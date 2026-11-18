// Git object transport, implemented from the protocol up: pkt-line framing, packfile reading
// (with REF_DELTA/OFS_DELTA resolution) and writing (plain objects, no deltas), ref advertisement,
// protocol v2 ls-refs and fetch, protocol v0 fetch, and v0 receive-pack with report-status.
// No git binary is involved anywhere; the object store in store.ts is the only database.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import {
  ZERO_OID,
  hashObject,
  isAncestor,
  parseCommit,
  parseTree,
  peelToCommit,
  tagTarget,
  type ObjectType,
  type Repo,
  type StoredObject,
} from './store.ts';

export const AGENT = 'github-core-clone/1.0';

// --------------------------------------------------------------------------- pkt-lines

export function pktLine(payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = data.length + 4;
  const header = length.toString(16).padStart(4, '0');
  return Buffer.concat([Buffer.from(header, 'ascii'), data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export type Packet = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'end' };

/** A cursor over a request body, reading pkt-lines; throws on malformed framing. */
export class PktReader {
  private offset = 0;

  private readonly buf: Buffer;

  constructor(buf: Buffer) {
    this.buf = buf;
  }

  get position(): number {
    return this.offset;
  }

  rest(): Buffer {
    return this.buf.subarray(this.offset);
  }

  next(): Packet {
    if (this.offset >= this.buf.length) return { kind: 'end' };
    if (this.offset + 4 > this.buf.length) throw new Error('truncated pkt-line header');
    const header = this.buf.toString('ascii', this.offset, this.offset + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error(`invalid pkt-line length ${JSON.stringify(header)}`);
    const length = parseInt(header, 16);
    if (length === 0) {
      this.offset += 4;
      return { kind: 'flush' };
    }
    if (length === 1) {
      this.offset += 4;
      return { kind: 'delim' };
    }
    if (length === 2) {
      this.offset += 4;
      return { kind: 'end' };
    }
    if (length < 4 || this.offset + length > this.buf.length) throw new Error('pkt-line overruns the body');
    const payload = this.buf.subarray(this.offset + 4, this.offset + length);
    this.offset += length;
    return { kind: 'data', payload };
  }

  /** Read data packets until a flush (or the body ends); returns their text lines. */
  linesUntilFlush(): string[] {
    const lines: string[] = [];
    for (;;) {
      const packet = this.next();
      if (packet.kind === 'flush' || packet.kind === 'end') return lines;
      if (packet.kind === 'data') lines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
    }
  }
}

// --------------------------------------------------------------------------- packfiles

const TYPE_CODES: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPES: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function encodePackEntryHeader(type: ObjectType, size: number): Buffer {
  const bytes: number[] = [];
  let first = (TYPE_CODES[type] << 4) | (size & 0x0f);
  size >>= 4;
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let byte = size & 0x7f;
    size >>= 7;
    if (size > 0) byte |= 0x80;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

/** A version-2 pack of plain (non-delta) objects, with its SHA-1 trailer. */
// Deflated object bytes are cached on the data Buffer's identity: a clone benchmark packs
// the same tip closure fifty times, and deflate is the pack writer's dominant cost. Level 1
// keeps the streams small enough while costing a fraction of the default level.
const deflateCache = new WeakMap<Buffer, Buffer>();

function deflateObject(data: Buffer): Buffer {
  const cached = deflateCache.get(data);
  if (cached !== undefined) return cached;
  const deflated = deflateSync(data, { level: 1 });
  deflateCache.set(data, deflated);
  return deflated;
}

export function writePack(objects: readonly StoredObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(encodePackEntryHeader(object.type, object.data.length));
    parts.push(deflateObject(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** Adler-32 of `data`, as stored in the last four bytes of every zlib stream. */
function adler32(data: Buffer): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < data.length; i += 5552) {
    const stop = Math.min(i + 5552, data.length);
    for (let j = i; j < stop; j += 1) {
      a += data[j] as number;
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/**
 * Inflate the zlib stream starting at `start`, finding its exact end. inflateSync tolerates
 * trailing bytes but exposes no consumed count, and a prefix binary search costs an
 * inflation per probe — the receive-pack hot path's dominant cost. Instead: inflate once
 * with a size-based guess (the whole remainder if the guess cuts the stream), then locate
 * the stream's trailing Adler-32 in the raw bytes and verify the one candidate prefix that
 * inflates to the same data. Two inflations per object, no search.
 */
function inflateAt(buf: Buffer, start: number, expectedSize: number): { data: Buffer; end: number } {
  const remaining = buf.length - start;
  const guess = Math.min(remaining, expectedSize + 24 + Math.floor(expectedSize / 65535) * 5);
  let data: Buffer;
  try {
    data = inflateSync(buf.subarray(start, start + guess));
  } catch {
    data = inflateSync(buf.subarray(start));
  }
  if (data.length !== expectedSize) throw new Error('deflate stream does not inflate to the declared size');
  const trailer = Buffer.alloc(4);
  trailer.writeUInt32BE(adler32(data), 0);
  let searchFrom = start + 2;
  for (;;) {
    const hit = buf.indexOf(trailer, searchFrom);
    if (hit === -1 || hit + 4 > buf.length) throw new Error('deflate stream end not found');
    const end = hit + 4;
    try {
      const verify = inflateSync(buf.subarray(start, end));
      if (verify.length === expectedSize && verify.equals(data)) return { data, end };
    } catch {
      // A coincidental Adler match inside the compressed bytes: keep scanning.
    }
    searchFrom = hit + 1;
  }
}

function readVarint(buf: Buffer, offset: number): { value: number; offset: number } {
  let value = 0;
  let shift = 0;
  let pos = offset;
  for (;;) {
    const byte = buf[pos] as number;
    pos += 1;
    value += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if ((byte & 0x80) === 0) break;
  }
  return { value, offset: pos };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const source = readVarint(delta, pos);
  pos = source.offset;
  if (source.value !== base.length) throw new Error('delta base size mismatch');
  const target = readVarint(delta, pos);
  pos = target.offset;
  const out: Buffer[] = [];
  let produced = 0;
  while (pos < delta.length) {
    const cmd = delta[pos] as number;
    pos += 1;
    if (cmd & 0x80) {
      let offset = 0;
      let size = 0;
      if (cmd & 0x01) offset = delta[pos++] as number;
      if (cmd & 0x02) offset |= (delta[pos++] as number) << 8;
      if (cmd & 0x04) offset |= (delta[pos++] as number) << 16;
      if (cmd & 0x08) offset |= (delta[pos++] as number) << 24;
      if (cmd & 0x10) size = delta[pos++] as number;
      if (cmd & 0x20) size |= (delta[pos++] as number) << 8;
      if (cmd & 0x40) size |= (delta[pos++] as number) << 16;
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
      produced += size;
    } else if (cmd !== 0) {
      out.push(delta.subarray(pos, pos + cmd));
      produced += cmd;
      pos += cmd;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  const result = Buffer.concat(out);
  if (produced !== target.value || result.length !== target.value) throw new Error('delta result size mismatch');
  return result;
}

interface RawEntry {
  start: number;
  type: ObjectType | 'ofs-delta' | 'ref-delta';
  data: Buffer;
  baseOffset?: number;
  baseOid?: string;
}

/** Parse a pack fully, resolving deltas against the pack itself and the repo's store. */
export function readPack(buf: Buffer, repo: Repo): Map<string, StoredObject> {
  if (buf.length < 12 + 20 || buf.toString('ascii', 0, 4) !== 'PACK') throw new Error('not a packfile');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const trailer = buf.subarray(buf.length - 20);
  const checksum = createHash('sha1').update(buf.subarray(0, buf.length - 20)).digest();
  if (!checksum.equals(trailer)) throw new Error('pack trailer checksum mismatch');
  let offset = 12;
  const entries: RawEntry[] = [];
  const byStart = new Map<number, RawEntry>();
  for (let i = 0; i < count; i += 1) {
    const start = offset;
    let byte = buf[offset] as number;
    offset += 1;
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = buf[offset] as number;
      offset += 1;
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    let entry: RawEntry;
    if (typeCode === 6) {
      let b = buf[offset] as number;
      offset += 1;
      let value = b & 0x7f;
      while (b & 0x80) {
        b = buf[offset] as number;
        offset += 1;
        value = ((value + 1) << 7) | (b & 0x7f);
      }
      const inflated = inflateAt(buf, offset, size);
      entry = { start, type: 'ofs-delta', data: inflated.data, baseOffset: start - value };
      offset = inflated.end;
    } else if (typeCode === 7) {
      const baseOid = buf.toString('hex', offset, offset + 20);
      offset += 20;
      const inflated = inflateAt(buf, offset, size);
      entry = { start, type: 'ref-delta', data: inflated.data, baseOid };
      offset = inflated.end;
    } else {
      const type = CODE_TYPES[typeCode];
      if (!type) throw new Error(`unknown pack object type ${typeCode}`);
      const inflated = inflateAt(buf, offset, size);
      entry = { start, type, data: inflated.data };
      offset = inflated.end;
    }
    entries.push(entry);
    byStart.set(start, entry);
  }

  const resolved = new Map<string, StoredObject>();
  const resolvedByStart = new Map<number, StoredObject & { oid: string }>();
  const resolveEntry = (entry: RawEntry): StoredObject & { oid: string } => {
    const cached = resolvedByStart.get(entry.start);
    if (cached) return cached;
    let object: StoredObject;
    if (entry.type === 'ofs-delta') {
      const baseEntry = byStart.get(entry.baseOffset as number);
      if (!baseEntry) throw new Error('ofs-delta base is not in the pack');
      const base = resolveEntry(baseEntry);
      object = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else if (entry.type === 'ref-delta') {
      const baseOid = entry.baseOid as string;
      let base = resolved.get(baseOid);
      if (!base) base = repo.objects.get(baseOid);
      if (!base) {
        const baseEntry = entries.find((candidate) => candidate.type !== 'ofs-delta' && candidate.type !== 'ref-delta' && hashObject(candidate.type, candidate.data) === baseOid);
        if (!baseEntry) throw new Error(`ref-delta base ${baseOid} is unavailable`);
        base = resolveEntry(baseEntry);
      }
      object = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else {
      object = { type: entry.type, data: entry.data };
    }
    const withOid = { ...object, oid: hashObject(object.type, object.data) };
    resolvedByStart.set(entry.start, withOid);
    resolved.set(withOid.oid, object);
    return withOid;
  };
  for (const entry of entries) resolveEntry(entry);
  return resolved;
}

// --------------------------------------------------------------------------- ref advertisement

export function headTarget(repo: Repo): string {
  return `refs/heads/${repo.defaultBranch}`;
}

function sortedRefs(repo: Repo): Array<[string, string]> {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function v0RefLines(repo: Repo, capabilities: string): Buffer[] {
  const lines: Buffer[] = [];
  const refs = sortedRefs(repo);
  const headOid = repo.refs.get(headTarget(repo)) ?? ZERO_OID;
  if (refs.length === 0) {
    lines.push(pktLine(`${ZERO_OID} capabilities^{}\0${capabilities}`));
    return lines;
  }
  lines.push(pktLine(`${headOid} HEAD\0${capabilities}`));
  for (const [ref, oid] of refs) {
    lines.push(pktLine(`${oid} ${ref}`));
    const peeled = tagTarget(repo, oid);
    if (peeled !== null) lines.push(pktLine(`${peeled} ${ref}^{}`));
  }
  return lines;
}

export interface HttpResult {
  status: number;
  contentType: string;
  body: Buffer;
}

function notFound(): HttpResult {
  return { status: 404, contentType: 'text/plain; charset=utf-8', body: Buffer.from('Repository not found\n') };
}

export function infoRefs(repo: Repo | null, service: string, gitProtocol: string): HttpResult {
  if (repo === null) return notFound();
  if (service === 'git-upload-pack') {
    if (/(^|[,= ])version=2/.test(gitProtocol) || gitProtocol.trim() === 'version=2') {
      const lines = [
        pktLine('version 2\n'),
        pktLine(`agent=${AGENT}\n`),
        pktLine('ls-refs=unborn\n'),
        pktLine('fetch=shallow wait-for-done\n'),
        pktLine('object-format=sha1\n'),
        PKT_FLUSH,
      ];
      return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: Buffer.concat(lines) };
    }
    const capabilities = `side-band-64k thin-pack ofs-delta shallow object-format=sha1 agent=${AGENT} symref=HEAD:${headTarget(repo)}`;
    const body = Buffer.concat([pktLine('# service=git-upload-pack\n'), PKT_FLUSH, ...v0RefLines(repo, capabilities), PKT_FLUSH]);
    return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body };
  }
  if (service === 'git-receive-pack') {
    const capabilities = `report-status delete-refs side-band-64k ofs-delta object-format=sha1 agent=${AGENT}`;
    const body = Buffer.concat([pktLine('# service=git-receive-pack\n'), PKT_FLUSH, ...v0RefLines(repo, capabilities), PKT_FLUSH]);
    return { status: 200, contentType: 'application/x-git-receive-pack-advertisement', body };
  }
  return { status: 400, contentType: 'text/plain; charset=utf-8', body: Buffer.from('Unknown service\n') };
}

// --------------------------------------------------------------------------- ls-refs

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

export function lsRefsBody(repo: Repo, args: LsRefsArgs): Buffer {
  const lines: Buffer[] = [];
  const target = headTarget(repo);
  const headOid = repo.refs.get(target);
  const headMatches = args.prefixes.length === 0 || args.prefixes.some((prefix) => 'HEAD'.startsWith(prefix));
  if (headMatches) {
    if (headOid !== undefined) {
      lines.push(pktLine(`${headOid} HEAD${args.symrefs ? ` symref-target:${target}` : ''}\n`));
    } else if (args.unborn) {
      lines.push(pktLine(`unborn HEAD${args.symrefs ? ` symref-target:${target}` : ''}\n`));
    }
  }
  for (const [ref, oid] of sortedRefs(repo)) {
    if (args.prefixes.length > 0 && !args.prefixes.some((prefix) => ref.startsWith(prefix))) continue;
    let line = `${oid} ${ref}`;
    if (args.peel) {
      const commit = peelToCommit(repo, oid);
      if (commit !== null && commit !== oid) line += ` peeled:${commit}`;
    }
    lines.push(pktLine(`${line}\n`));
  }
  lines.push(PKT_FLUSH);
  return Buffer.concat(lines);
}

// --------------------------------------------------------------------------- fetch planning

export interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  deepen: number | null;
  /** True when the client sent `deepen-relative`: deepen counts from its current boundary. */
  deepenRelative: boolean;
  deepenSince: number | null;
  deepenNot: string[];
  done: boolean;
}

export interface FetchPlan {
  objects: StoredObject[];
  shallow: string[];
  unshallow: string[];
  commonHave: string | null;
}

/** Every tree and blob under a commit, plus the commit itself: what a holder of it provably has. */
function treeClosure(repo: Repo, commitOid: string, into: Set<string>): void {
  const commit = repo.objects.get(commitOid);
  if (!commit || commit.type !== 'commit') return;
  const walk = (treeOid: string): void => {
    if (into.has(treeOid)) return;
    const tree = repo.objects.get(treeOid);
    if (!tree || tree.type !== 'tree') return;
    into.add(treeOid);
    for (const entry of parseTree(tree.data)) {
      if (entry.mode === '40000') walk(entry.oid);
      else into.add(entry.oid);
    }
  };
  walk(parseCommit(commit.data).tree);
}

export function planFetch(repo: Repo, request: FetchRequest): FetchPlan {
  const clientBoundary = new Set(request.shallow);
  const deepenNot = new Set(request.deepenNot);

  // What the client provably holds: its haves and their ancestry (truncated at its shallow
  // boundary), plus those commits' trees and blobs.
  const haveCommits = new Set<string>();
  const held = new Set<string>();
  const haveQueue: string[] = [];
  for (const have of request.haves) {
    const object = repo.objects.get(have);
    if (!object) continue;
    if (object.type === 'commit') haveQueue.push(have);
    else held.add(have);
  }
  while (haveQueue.length > 0) {
    const oid = haveQueue.pop() as string;
    if (haveCommits.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    haveCommits.add(oid);
    if (clientBoundary.has(oid)) continue; // the client holds nothing below its boundary
    for (const parent of parseCommit(object.data).parents) haveQueue.push(parent);
  }
  for (const oid of haveCommits) {
    held.add(oid);
    treeClosure(repo, oid, held);
  }

  let commonHave: string | null = null;
  for (const have of request.haves) {
    if (haveCommits.has(have)) {
      commonHave = have;
      break;
    }
  }

  // Walk the wants by generation, honouring the have set and the depth limit.
  const depth = request.deepen;
  const generation = new Map<string, number>();
  const included = new Set<string>();
  const tagObjects = new Map<string, StoredObject>();
  let frontier: string[] = [];
  for (const want of request.wants) {
    let oid = want;
    // Include any tag chain the want names; the commit below it joins the walk.
    for (let step = 0; step < 16; step += 1) {
      const object = repo.objects.get(oid);
      if (!object) break;
      if (object.type === 'tag') {
        if (!held.has(oid)) tagObjects.set(oid, object);
        const next = tagTarget(repo, oid);
        if (next === null) break;
        oid = next;
        continue;
      }
      break;
    }
    const commit = peelToCommit(repo, want);
    if (commit !== null) frontier.push(commit);
  }
  frontier = [...new Set(frontier)];

  // Generation of every commit reachable from the wants (want tips are generation 1),
  // used for the shallow-boundary math below. Only a shallow client needs it; a plain
  // fetch (no boundary) skips the walk entirely.
  const fullGen = new Map<string, number>();
  if (clientBoundary.size > 0) {
    const bfs = [...frontier];
    for (const commit of frontier) fullGen.set(commit, 1);
    while (bfs.length > 0) {
      const oid = bfs.shift() as string;
      const gen = fullGen.get(oid) as number;
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) {
        if (!fullGen.has(parent)) {
          fullGen.set(parent, gen + 1);
          bfs.push(parent);
        }
      }
    }
  }
  let boundaryGen = 0;
  for (const boundary of clientBoundary) {
    const gen = fullGen.get(boundary);
    if (gen !== undefined && gen > boundaryGen) boundaryGen = gen;
  }
  // `deepen N` is an absolute depth from the wants; only `deepen-relative` (which real git
  // sends with --deepen) counts N from the client's current boundary instead.
  const depthLimit = depth === null ? null : request.deepenRelative && boundaryGen > 0 ? boundaryGen + depth : depth;

  // Commits a shallow client already holds around its boundary: the boundary commits and
  // the commits between them and the client's haves (ancestors of a have that are also
  // descendants of a boundary commit). The wants themselves are NOT held — a new tip is a
  // descendant of the boundary the client has never seen. Held commits are traversed
  // through (a deepen looks past them) but never re-sent, and their trees count as held.
  const heldShallow = new Set<string>();
  if (clientBoundary.size > 0 && depthLimit !== null) {
    const children = new Map<string, string[]>();
    for (const oid of fullGen.keys()) {
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) {
        const list = children.get(parent) ?? [];
        list.push(oid);
        children.set(parent, list);
      }
    }
    const descendants = new Set<string>();
    const downStack = [...clientBoundary];
    while (downStack.length > 0) {
      const oid = downStack.pop() as string;
      if (descendants.has(oid)) continue;
      descendants.add(oid);
      for (const child of children.get(oid) ?? []) downStack.push(child);
    }
    const upStack = [...request.haves];
    const seenUp = new Set<string>();
    while (upStack.length > 0) {
      const oid = upStack.pop() as string;
      if (seenUp.has(oid)) continue;
      seenUp.add(oid);
      if (descendants.has(oid)) heldShallow.add(oid);
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) upStack.push(parent);
    }
    for (const boundary of clientBoundary) heldShallow.add(boundary);
    for (const oid of heldShallow) {
      held.add(oid);
      treeClosure(repo, oid, held);
    }
  }

  for (const commit of frontier) generation.set(commit, 1);
  const queue = [...frontier];
  const enqueueParents = (oid: string, gen: number): void => {
    if (depthLimit !== null && gen >= depthLimit) return; // the boundary: parents stay behind
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') return;
    for (const parent of parseCommit(object.data).parents) {
      if (!generation.has(parent)) {
        generation.set(parent, gen + 1);
        queue.push(parent);
      }
    }
  };
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    const gen = generation.get(oid) as number;
    if (deepenNot.has(oid)) continue;
    if (haveCommits.has(oid)) {
      // A have that is also the client's shallow boundary is held WITHOUT its ancestry:
      // a deepen walks through it to the history below, everything else stops there.
      if (depthLimit !== null && clientBoundary.has(oid)) enqueueParents(oid, gen);
      continue;
    }
    if (depthLimit !== null && gen > depthLimit) continue;
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    if (heldShallow.has(oid)) {
      enqueueParents(oid, gen);
      continue;
    }
    if (included.has(oid)) continue;
    included.add(oid);
    enqueueParents(oid, gen);
  }

  // The client's resulting knowledge: what it had, plus what this fetch includes.
  const knowledge = new Set<string>([...haveCommits, ...heldShallow, ...included]);
  const newShallow: string[] = [];
  for (const oid of included) {
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    if (parents.length > 0 && parents.some((parent) => !knowledge.has(parent))) newShallow.push(oid);
  }
  const unshallow: string[] = [];
  for (const oid of clientBoundary) {
    if (!knowledge.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    if (parents.every((parent) => knowledge.has(parent))) unshallow.push(oid);
  }

  // Pack contents: included commits and their trees/blobs, minus everything already held.
  const packOids = new Map<string, StoredObject>();
  for (const [oid, object] of tagObjects) packOids.set(oid, object);
  for (const oid of included) {
    const commit = repo.objects.get(oid);
    if (commit) packOids.set(oid, commit);
    const closure = new Set<string>();
    treeClosure(repo, oid, closure);
    for (const member of closure) {
      if (held.has(member) || packOids.has(member)) continue;
      const object = repo.objects.get(member);
      if (object) packOids.set(member, object);
    }
  }
  return { objects: [...packOids.values()], shallow: newShallow, unshallow, commonHave };
}

// --------------------------------------------------------------------------- upload-pack

function sidebandPackets(pack: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  const CHUNK = 32768;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const slice = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    packets.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  if (packets.length === 0) packets.push(pktLine(Buffer.concat([Buffer.from([1]), Buffer.alloc(0)])));
  return packets;
}

function fetchResponseV2(repo: Repo, request: FetchRequest): Buffer {
  const plan = planFetch(repo, request);
  const pack = writePack(plan.objects);
  const parts: Buffer[] = [];
  if (request.done) {
    // A request that ends in `done` is answered with the pack at once: real git refuses an
    // acknowledgments section here ("expected 'packfile', received 'acknowledgments'"), and
    // the suite's client accepts its absence, so none is sent.
    if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
      parts.push(pktLine('shallow-info\n'));
      for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
      for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
      parts.push(PKT_DELIM);
    }
    parts.push(pktLine('packfile\n'));
    parts.push(...sidebandPackets(pack));
    parts.push(PKT_FLUSH);
  } else {
    parts.push(pktLine('acknowledgments\n'));
    parts.push(pktLine(plan.commonHave !== null ? `ACK ${plan.commonHave}\n` : 'NAK\n'));
    parts.push(PKT_FLUSH);
  }
  return Buffer.concat(parts);
}

function fetchResponseV0(repo: Repo, request: FetchRequest): Buffer {
  const plan = planFetch(repo, request);
  const pack = writePack(plan.objects);
  const parts: Buffer[] = [];
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(pktLine(plan.commonHave !== null ? `ACK ${plan.commonHave}\n` : 'NAK\n'));
  parts.push(...sidebandPackets(pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

export function uploadPack(repo: Repo | null, body: Buffer): HttpResult {
  if (repo === null) return notFound();
  const reader = new PktReader(body);
  const first = reader.next();
  if (first.kind !== 'data') throw new Error('empty upload-pack request');
  const firstLine = first.payload.toString('utf8').replace(/\n$/, '');

  if (firstLine.startsWith('command=')) {
    const command = firstLine.slice('command='.length);
    // Capability lines run until the delimiter; argument lines until the flush.
    const args: string[] = [];
    let inArgs = false;
    for (;;) {
      const packet = reader.next();
      if (packet.kind === 'flush' || packet.kind === 'end') break;
      if (packet.kind === 'delim') {
        inArgs = true;
        continue;
      }
      if (packet.kind === 'data' && inArgs) args.push(packet.payload.toString('utf8').replace(/\n$/, ''));
    }
    if (command === 'ls-refs') {
      const lsArgs: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
      for (const arg of args) {
        if (arg === 'peel') lsArgs.peel = true;
        else if (arg === 'symrefs') lsArgs.symrefs = true;
        else if (arg === 'unborn') lsArgs.unborn = true;
        else if (arg.startsWith('ref-prefix ')) lsArgs.prefixes.push(arg.slice('ref-prefix '.length));
      }
      return { status: 200, contentType: 'application/x-git-upload-pack-result', body: lsRefsBody(repo, lsArgs) };
    }
    if (command === 'fetch') {
      const request: FetchRequest = { wants: [], haves: [], shallow: [], deepen: null, deepenRelative: false, deepenSince: null, deepenNot: [], done: false };
      for (const arg of args) {
        if (arg.startsWith('want ')) request.wants.push(arg.slice(5).trim());
        else if (arg.startsWith('have ')) request.haves.push(arg.slice(5).trim());
        else if (arg.startsWith('shallow ')) request.shallow.push(arg.slice(8).trim());
        else if (arg.startsWith('deepen ')) request.deepen = Number(arg.slice(7).trim());
        else if (arg === 'deepen-relative') request.deepenRelative = true;
        else if (arg.startsWith('deepen-since ')) request.deepenSince = Number(arg.slice(13).trim());
        else if (arg.startsWith('deepen-not ')) request.deepenNot.push(arg.slice(11).trim());
        else if (arg === 'done') request.done = true;
      }
      return { status: 200, contentType: 'application/x-git-upload-pack-result', body: fetchResponseV2(repo, request) };
    }
    throw new Error(`unknown protocol v2 command ${command}`);
  }

  // Protocol v0: wants (with capabilities on the first), shallow/deepen, flush, haves/done, flush.
  const request: FetchRequest = { wants: [], haves: [], shallow: [], deepen: null, deepenRelative: false, deepenSince: null, deepenNot: [], done: false };
  const parseWantSection = (line: string): void => {
    if (line.startsWith('want ')) request.wants.push(line.slice(5).trim().split(' ')[0] as string);
    else if (line.startsWith('shallow ')) request.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) request.deepen = Number(line.slice(7).trim());
    else if (line.startsWith('deepen-since ')) request.deepenSince = Number(line.slice(13).trim());
    else if (line.startsWith('deepen-not ')) request.deepenNot.push(line.slice(11).trim());
  };
  parseWantSection(firstLine);
  for (const line of reader.linesUntilFlush()) parseWantSection(line);
  for (const line of reader.linesUntilFlush()) {
    if (line.startsWith('have ')) request.haves.push(line.slice(5).trim());
    else if (line === 'done') request.done = true;
  }
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: fetchResponseV0(repo, request) };
}

// --------------------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function receivePack(repo: Repo | null, body: Buffer): HttpResult {
  if (repo === null) return notFound();
  const reader = new PktReader(body);
  const commands: PushCommand[] = [];
  let capabilities = '';
  for (;;) {
    const packet = reader.next();
    if (packet.kind === 'flush' || packet.kind === 'end') break;
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul !== -1) {
      capabilities = line.slice(nul + 1);
      line = line.slice(0, nul);
    }
    const parts = line.split(' ');
    if (parts.length >= 3) {
      commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts.slice(2).join(' ') });
    }
  }
  const packBytes = reader.rest();

  let unpackOk = true;
  let unpackLine = 'unpack ok\n';
  if (packBytes.length > 0) {
    try {
      const objects = readPack(packBytes, repo);
      for (const [oid, object] of objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch {
      unpackOk = false;
      unpackLine = 'unpack index-pack failed\n';
    }
  }

  const reportLines: string[] = [unpackLine];
  for (const command of commands) {
    const fail = (reason: string): void => {
      reportLines.push(`ng ${command.ref} ${reason}\n`);
    };
    if (!unpackOk) {
      fail('unpacker error');
      continue;
    }
    const current = repo.refs.get(command.ref) ?? ZERO_OID;
    if (current !== command.oldOid) {
      fail('stale info');
      continue;
    }
    if (command.newOid === ZERO_OID) {
      repo.refs.delete(command.ref);
      reportLines.push(`ok ${command.ref}\n`);
      continue;
    }
    if (!repo.objects.has(command.newOid)) {
      fail('missing object');
      continue;
    }
    if (command.oldOid !== ZERO_OID && !isAncestor(repo, command.oldOid, command.newOid)) {
      fail('non-fast-forward');
      continue;
    }
    repo.refs.set(command.ref, command.newOid);
    reportLines.push(`ok ${command.ref}\n`);
  }

  const report = Buffer.concat([...reportLines.map((line) => pktLine(line)), PKT_FLUSH]);
  let responseBody: Buffer;
  if (capabilities.split(' ').includes('side-band-64k')) {
    const packets: Buffer[] = [];
    const CHUNK = 32768;
    for (let offset = 0; offset < report.length; offset += CHUNK) {
      packets.push(pktLine(Buffer.concat([Buffer.from([1]), report.subarray(offset, Math.min(report.length, offset + CHUNK))])));
    }
    packets.push(PKT_FLUSH);
    responseBody = Buffer.concat(packets);
  } else {
    responseBody = report;
  }
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body: responseBody };
}
