// The forge's single store: repositories with their git object databases, refs, labels, issues,
// pull requests and comments. Every surface (git smart HTTP, REST v3, GraphQL, MCP) reads and
// writes through this module, so an object created on one surface is the same object on all.
//
// Determinism: nothing here reads the wall clock or a random source. Timestamps come from
// MAKEFUN_TRIAL_NOW (parsed once) plus a per-store tick counter, and every id is a sequence
// number, so a replayed trial that makes the same requests builds the same state.

import { createHash } from 'node:crypto';
import { VIEWER, type ScenarioUser } from './scenario.ts';

export type ObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface StoredObject {
  type: ObjectType;
  data: Buffer;
}

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface IssueComment {
  id: number;
  body: string;
  createdSeq: number;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: IssueComment[];
  createdSeq: number;
}

export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  /** The base branch tip when the pull request was opened: its divergence point. */
  baseShaAtCreate: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdSeq: number;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  objects: Map<string, StoredObject>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pulls: Map<number, PullRequest>;
  /** Issues and pull requests share one number sequence, as they do on GitHub. */
  nextNumber: number;
  createdSeq: number;
}

// --------------------------------------------------------------------------- time

/** Parse MAKEFUN_TRIAL_NOW (ISO text, epoch seconds or epoch milliseconds) once. */
function trialEpochSec(): number {
  const raw = (process.env.MAKEFUN_TRIAL_NOW ?? '').trim();
  if (raw !== '') {
    if (/^\d+$/.test(raw)) {
      const value = Number(raw);
      if (Number.isSafeInteger(value)) return value > 100_000_000_000 ? Math.floor(value / 1000) : value;
    }
    const parsed = Date.parse(raw);
    if (!Number.isNaN(parsed)) return Math.floor(parsed / 1000);
  }
  return 1_735_689_600; // 2025-01-01T00:00:00Z, the scenario's own epoch.
}

const TRIAL_EPOCH_SEC = trialEpochSec();

/** The trial's fixed epoch second: stored timestamps derive from it plus a sequence tick. */
export function baseEpochSec(): number {
  return TRIAL_EPOCH_SEC;
}

export function isoOf(epochSec: number): string {
  return new Date(epochSec * 1000).toISOString();
}

// --------------------------------------------------------------------------- git objects

export const ZERO_OID = '0000000000000000000000000000000000000000';

export function hashObject(type: ObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(`${type} ${data.length}\0`, 'utf8');
  hash.update(data);
  return hash.digest('hex');
}

export function storeObject(repo: Repo, type: ObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

export interface ParsedCommit {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

// Stored object bytes never change, so a parse is cached on the Buffer's identity: the
// fetch planner and the ancestry walks re-read the same commits many times per request.
const commitParseCache = new WeakMap<Buffer, ParsedCommit>();

export function parseCommit(data: Buffer): ParsedCommit {
  const cached = commitParseCache.get(data);
  if (cached !== undefined) return cached;
  const parsed = parseCommitBytes(data);
  commitParseCache.set(data, parsed);
  return parsed;
}

function parseCommitBytes(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

const treeParseCache = new WeakMap<Buffer, TreeEntry[]>();

export function parseTree(data: Buffer): TreeEntry[] {
  const cached = treeParseCache.get(data);
  if (cached !== undefined) return cached;
  const parsed = parseTreeBytes(data);
  treeParseCache.set(data, parsed);
  return parsed;
}

function parseTreeBytes(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) break;
    const mode = data.toString('ascii', offset, space);
    const nul = data.indexOf(0x00, space + 1);
    if (nul === -1 || nul + 21 > data.length) break;
    const name = data.toString('utf8', space + 1, nul);
    const oid = data.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Git's tree order: byte-wise by name, directories compared as if suffixed with '/'. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

export function buildTreeData(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Flatten a tree (recursively) into path -> blob entry. Missing objects flatten as empty. */
export function flattenTree(repo: Repo, treeOid: string): Map<string, TreeEntry & { path: string }> {
  const out = new Map<string, TreeEntry & { path: string }>();
  const walk = (oid: string, prefix: string): void => {
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, { ...entry, path });
    }
  };
  walk(treeOid, '');
  return out;
}

/** Rebuild nested trees from a flat path -> {mode, oid} map; returns the root tree oid. */
export function buildTreeFromFiles(repo: Repo, files: ReadonlyMap<string, { mode: string; oid: string }>): string {
  interface Node {
    dirs: Map<string, Node>;
    files: Map<string, { mode: string; oid: string }>;
  }
  const root: Node = { dirs: new Map(), files: new Map() };
  for (const [path, file] of files) {
    const segments = path.split('/');
    let node = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const segment = segments[i] as string;
      let next = node.dirs.get(segment);
      if (!next) {
        next = { dirs: new Map(), files: new Map() };
        node.dirs.set(segment, next);
      }
      node = next;
    }
    node.files.set(segments[segments.length - 1] as string, file);
  }
  const write = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, file] of node.files) entries.push({ mode: file.mode, name, oid: file.oid });
    for (const [name, dir] of node.dirs) entries.push({ mode: '40000', name, oid: write(dir) });
    return storeObject(repo, 'tree', buildTreeData(entries));
  };
  return write(root);
}

/** Peel an object id through tag objects to the commit it names (or null). */
export function peelToCommit(repo: Repo, oid: string): string | null {
  let current = oid;
  for (let depth = 0; depth < 16; depth += 1) {
    const object = repo.objects.get(current);
    if (!object) return null;
    if (object.type === 'commit') return current;
    if (object.type === 'tag') {
      const match = /^object ([0-9a-f]{40})$/m.exec(object.data.toString('utf8'));
      if (!match) return null;
      current = match[1] as string;
      continue;
    }
    return null;
  }
  return null;
}

/** Peel an annotated tag one step: the oid its `object` header names, or null. */
export function tagTarget(repo: Repo, oid: string): string | null {
  const object = repo.objects.get(oid);
  if (!object || object.type !== 'tag') return null;
  const match = /^object ([0-9a-f]{40})$/m.exec(object.data.toString('utf8'));
  return match ? (match[1] as string) : null;
}

/** Every commit reachable from `tip` (inclusive), parents walked breadth-first. */
export function commitAncestry(repo: Repo, tip: string): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [tip];
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    seen.add(oid);
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return seen;
}

/** True when `ancestor` is `descendant` itself or one of its ancestors. */
export function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const queue: string[] = [descendant];
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return false;
}

/** The best common ancestor of two commits (the suite's histories are linear; any common one does). */
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  const ancestorsOfA = commitAncestry(repo, a);
  const seen = new Set<string>();
  const queue: string[] = [b];
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (ancestorsOfA.has(oid)) return oid;
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return null;
}

// --------------------------------------------------------------------------- the store

export class Store {
  readonly viewer: ScenarioUser = VIEWER;
  readonly repos = new Map<string, Repo>();
  private repoSeq = 0;
  private issueSeq = 0;
  private commentSeq = 0;
  private labelSeq = 0;
  private eventSeq = 0;
  private commitTick = 0;
  requestSeq = 0;

  /** A deterministic instant for a new stored event: trial time plus a tick per event. */
  now(): { epochSec: number; iso: string } {
    const epochSec = TRIAL_EPOCH_SEC + this.eventSeq;
    this.eventSeq += 1;
    return { epochSec, iso: isoOf(epochSec) };
  }

  /** The identity line server-created commits carry. */
  authorLine(): string {
    const epochSec = TRIAL_EPOCH_SEC + this.commitTick;
    this.commitTick += 1;
    return `${this.viewer.name} <${this.viewer.email}> ${epochSec} +0000`;
  }

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  /** The repository the token's owner holds under `name`; any other owner is a 404 by design. */
  getRepo(owner: string, name: string): Repo | null {
    if (owner !== this.viewer.login) return null;
    return this.repos.get(this.key(owner, name)) ?? null;
  }

  createRepo(name: string, description: string, isPrivate: boolean): Repo | null {
    const key = this.key(this.viewer.login, name);
    if (this.repos.has(key)) return null;
    this.repoSeq += 1;
    const repo: Repo = {
      id: this.repoSeq,
      owner: this.viewer.login,
      name,
      description,
      isPrivate,
      defaultBranch: 'main',
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      createdSeq: this.repoSeq,
    };
    this.repos.set(key, repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    if (owner !== this.viewer.login) return false;
    return this.repos.delete(this.key(owner, name));
  }

  viewerRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.createdSeq - b.createdSeq);
  }

  nextIssueId(): number {
    this.issueSeq += 1;
    return this.issueSeq;
  }

  nextCommentId(): number {
    this.commentSeq += 1;
    return this.commentSeq;
  }

  nextLabelId(): number {
    this.labelSeq += 1;
    return this.labelSeq;
  }

  /** Create a commit object on top of `parent` (or unborn) with the viewer's identity. */
  createCommit(repo: Repo, treeOid: string, parent: string | null, message: string): string {
    const line = this.authorLine();
    const lines = [`tree ${treeOid}`];
    if (parent !== null) lines.push(`parent ${parent}`);
    lines.push(`author ${line}`, `committer ${line}`, '', message);
    return storeObject(repo, 'commit', Buffer.from(lines.join('\n'), 'utf8'));
  }

  branchTip(repo: Repo, branch: string): string | null {
    return repo.refs.get(`refs/heads/${branch}`) ?? null;
  }

  defaultTip(repo: Repo): string | null {
    return this.branchTip(repo, repo.defaultBranch);
  }

  /** The commit a ref-ish value names: a branch name, a full ref, or a commit oid. */
  resolveRef(repo: Repo, ref: string): string | null {
    if (/^[0-9a-f]{40}$/.test(ref)) {
      const commit = peelToCommit(repo, ref);
      if (commit !== null) return commit;
    }
    const byBranch = this.branchTip(repo, ref);
    if (byBranch !== null) return peelToCommit(repo, byBranch);
    const byRef = repo.refs.get(ref);
    if (byRef !== undefined) return peelToCommit(repo, byRef);
    return null;
  }

  createIssue(repo: Repo, title: string, body: string, labelNames: string[]): Issue {
    const number = repo.nextNumber;
    repo.nextNumber += 1;
    const issue: Issue = {
      id: this.nextIssueId(),
      number,
      title,
      body,
      state: 'open',
      labels: [...labelNames],
      comments: [],
      createdSeq: number,
    };
    repo.issues.set(number, issue);
    return issue;
  }

  createPull(repo: Repo, title: string, body: string, headRef: string, baseRef: string): PullRequest | null {
    const headTip = this.branchTip(repo, headRef);
    const baseTip = this.branchTip(repo, baseRef);
    if (headTip === null || baseTip === null) return null;
    const number = repo.nextNumber;
    repo.nextNumber += 1;
    const pull: PullRequest = {
      id: this.nextIssueId(),
      number,
      title,
      body,
      state: 'open',
      headRef,
      baseRef,
      baseShaAtCreate: baseTip,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      createdSeq: number,
    };
    repo.pulls.set(number, pull);
    return pull;
  }

  /** An open pull request for the same head/base pair, if one exists (GitHub refuses duplicates). */
  openPullFor(repo: Repo, headRef: string, baseRef: string): PullRequest | null {
    for (const pull of repo.pulls.values()) {
      if (pull.state === 'open' && pull.headRef === headRef && pull.baseRef === baseRef) return pull;
    }
    return null;
  }
}

/** The one store every surface shares. */
export const store = new Store();
