// Operations every surface shares: the contents API's commit-on-write model, a pull request's
// changed-file list, and the three-way squash merge. REST, GraphQL and MCP all call these, so a
// file written over one surface diffs and merges identically on the others.

import {
  buildTreeFromFiles,
  flattenTree,
  isAncestor,
  mergeBase,
  parseCommit,
  peelToCommit,
  storeObject,
  type PullRequest,
  type Repo,
  type Store,
} from './store.ts';

export interface FileVersion {
  mode: string;
  oid: string;
}

/** The flat path -> version map of a commit's tree (empty for an unborn or unknown commit). */
export function filesAtCommit(repo: Repo, commitOid: string | null): Map<string, FileVersion> {
  const out = new Map<string, FileVersion>();
  if (commitOid === null) return out;
  const commit = repo.objects.get(commitOid);
  if (!commit || commit.type !== 'commit') return out;
  const tree = parseCommit(commit.data).tree;
  for (const [path, entry] of flattenTree(repo, tree)) out.set(path, { mode: entry.mode, oid: entry.oid });
  return out;
}

export type WriteResult =
  | { ok: true; status: number; commitSha: string; contentSha: string }
  | { ok: false; status: number; message: string };

/** PUT /contents semantics: create or replace one file with a commit on `branch`. */
export function writeContent(
  store: Store,
  repo: Repo,
  input: { path: string; content: Buffer; message: string; branch?: string; sha?: string },
): WriteResult {
  const branch = input.branch ?? repo.defaultBranch;
  const ref = `refs/heads/${branch}`;
  const tipRaw = repo.refs.get(ref) ?? null;
  const tip = tipRaw === null ? null : peelToCommit(repo, tipRaw);
  const files = filesAtCommit(repo, tip);
  const existing = files.get(input.path);
  if (existing && input.sha === undefined) {
    return { ok: false, status: 422, message: `"sha" wasn't supplied` };
  }
  if (existing && input.sha !== undefined && input.sha.toLowerCase() !== existing.oid) {
    return { ok: false, status: 409, message: `${input.sha} does not match the current blob ${existing.oid}` };
  }
  if (!existing && input.sha !== undefined) {
    return { ok: false, status: 422, message: 'Invalid sha for a file that does not exist' };
  }
  const blobOid = storeObject(repo, 'blob', input.content);
  files.set(input.path, { mode: existing?.mode ?? '100644', oid: blobOid });
  const tree = buildTreeFromFiles(repo, files);
  const commitSha = store.createCommit(repo, tree, tip, input.message);
  repo.refs.set(ref, commitSha);
  return { ok: true, status: existing ? 200 : 201, commitSha, contentSha: blobOid };
}

/** DELETE /contents semantics: remove one file with a commit on `branch`. */
export function deleteContent(
  store: Store,
  repo: Repo,
  input: { path: string; message: string; branch?: string; sha?: string },
): WriteResult {
  const branch = input.branch ?? repo.defaultBranch;
  const ref = `refs/heads/${branch}`;
  const tipRaw = repo.refs.get(ref) ?? null;
  const tip = tipRaw === null ? null : peelToCommit(repo, tipRaw);
  if (tip === null) return { ok: false, status: 404, message: 'Not Found' };
  const files = filesAtCommit(repo, tip);
  const existing = files.get(input.path);
  if (!existing) return { ok: false, status: 404, message: 'Not Found' };
  if (input.sha !== undefined && input.sha.toLowerCase() !== existing.oid) {
    return { ok: false, status: 409, message: `${input.sha} does not match the current blob ${existing.oid}` };
  }
  files.delete(input.path);
  const tree = buildTreeFromFiles(repo, files);
  const commitSha = store.createCommit(repo, tree, tip, input.message);
  repo.refs.set(ref, commitSha);
  return { ok: true, status: 200, commitSha, contentSha: existing.oid };
}

// --------------------------------------------------------------------------- line diffs

export function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Additions/deletions between two texts, by longest common subsequence over lines. */
export function lineDiff(before: string, after: string): { additions: number; deletions: number } {
  const a = splitLines(before);
  const b = splitLines(after);
  if (a.length === 0) return { additions: b.length, deletions: 0 };
  if (b.length === 0) return { additions: 0, deletions: a.length };
  if (a.length * b.length > 4_000_000) {
    // Too large for the DP table: count whole-side changes (the suite's files are small).
    return { additions: b.length, deletions: a.length };
  }
  const dp = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = 0;
    for (let j = 1; j <= b.length; j += 1) {
      const above = dp[j] as number;
      if (a[i - 1] === b[j - 1]) dp[j] = diagonal + 1;
      else dp[j] = Math.max(dp[j] as number, dp[j - 1] as number);
      diagonal = above;
    }
  }
  const common = dp[b.length] as number;
  return { additions: b.length - common, deletions: a.length - common };
}

// --------------------------------------------------------------------------- pull requests

export interface PullFile {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
}

/** The divergence point of a pull request: the merge base of its current head and base tips. */
export function pullMergeBase(repo: Repo, pull: PullRequest): string | null {
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (headTip === undefined || baseTip === undefined) return pull.baseShaAtCreate;
  const headCommit = peelToCommit(repo, headTip);
  const baseCommit = peelToCommit(repo, baseTip);
  if (headCommit === null || baseCommit === null) return pull.baseShaAtCreate;
  return mergeBase(repo, headCommit, baseCommit) ?? pull.baseShaAtCreate;
}

function blobText(repo: Repo, oid: string): string {
  const object = repo.objects.get(oid);
  return object && object.type === 'blob' ? object.data.toString('utf8') : '';
}

/** The changed files of a pull request: merge base tree against current head tree. */
export function pullFiles(repo: Repo, pull: PullRequest): PullFile[] {
  const baseFiles = filesAtCommit(repo, pullMergeBase(repo, pull));
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  const headCommit = headTip === undefined ? null : peelToCommit(repo, headTip);
  const headFiles = filesAtCommit(repo, headCommit);
  const files: PullFile[] = [];
  const paths = new Set<string>([...baseFiles.keys(), ...headFiles.keys()]);
  for (const path of [...paths].sort()) {
    const before = baseFiles.get(path);
    const after = headFiles.get(path);
    if (before && after && before.oid === after.oid) continue;
    if (!before && after) {
      const additions = splitLines(blobText(repo, after.oid)).length;
      files.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (before && !after) {
      const deletions = splitLines(blobText(repo, before.oid)).length;
      files.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
    } else if (before && after) {
      const { additions, deletions } = lineDiff(blobText(repo, before.oid), blobText(repo, after.oid));
      files.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  return files;
}

interface ThreeWay {
  conflict: boolean;
  merged: Map<string, FileVersion>;
}

/** A path-wise three-way merge of the pull request's head into the current base tip. */
function threeWayMerge(repo: Repo, pull: PullRequest): ThreeWay {
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  const headCommit = headTip === undefined ? null : peelToCommit(repo, headTip);
  const baseCommit = baseTip === undefined ? null : peelToCommit(repo, baseTip);
  const origin = filesAtCommit(repo, pullMergeBase(repo, pull));
  const head = filesAtCommit(repo, headCommit);
  const current = filesAtCommit(repo, baseCommit);
  const merged = new Map<string, FileVersion>(current);
  let conflict = false;
  const paths = new Set<string>([...origin.keys(), ...head.keys(), ...current.keys()]);
  for (const path of paths) {
    const o = origin.get(path)?.oid;
    const h = head.get(path)?.oid;
    const c = current.get(path)?.oid;
    if (h === c) continue; // both sides agree (or both absent)
    if (o === h) continue; // only the base side moved: keep current
    if (o === c) {
      // only the head side moved: take the head's version (or its deletion)
      const headVersion = head.get(path);
      if (headVersion) merged.set(path, headVersion);
      else merged.delete(path);
      continue;
    }
    conflict = true;
  }
  return { conflict, merged };
}

/** Whether the pull request would merge cleanly right now. */
export function pullMergeable(repo: Repo, pull: PullRequest): boolean {
  if (pull.state !== 'open') return false;
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (headTip === undefined || baseTip === undefined) return false;
  if (isAncestor(repo, headTip, baseTip)) return false; // nothing to merge
  return !threeWayMerge(repo, pull).conflict;
}

export type MergeResult = { ok: true; sha: string } | { ok: false; reason: 'conflict' | 'not-open' | 'missing' };

/** Squash-merge a pull request into its base branch: one commit, the head's changes applied. */
export function mergePull(store: Store, repo: Repo, pull: PullRequest): MergeResult {
  if (pull.state !== 'open') return { ok: false, reason: 'not-open' };
  const baseRef = `refs/heads/${pull.baseRef}`;
  const baseTipRaw = repo.refs.get(baseRef);
  if (baseTipRaw === undefined) return { ok: false, reason: 'missing' };
  const baseTip = peelToCommit(repo, baseTipRaw);
  if (baseTip === null) return { ok: false, reason: 'missing' };
  const { conflict, merged } = threeWayMerge(repo, pull);
  if (conflict) return { ok: false, reason: 'conflict' };
  const tree = buildTreeFromFiles(repo, merged);
  const message = pull.body === '' ? pull.title : `${pull.title}\n\n${pull.body}`;
  const sha = store.createCommit(repo, tree, baseTip, message);
  repo.refs.set(baseRef, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = store.now().iso;
  pull.mergeCommitSha = sha;
  return { ok: true, sha };
}
