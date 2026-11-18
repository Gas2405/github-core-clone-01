// The REST v3 surface: repositories, branches, commits, contents, git refs, labels, issues,
// comments and pull requests under /api/v3. Every reply is application/json and carries an
// X-GitHub-Request-Id; errors are {"message": string}; the token's owner is the only owner whose
// repositories exist, so the same name under any other login answers 404.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  ZERO_OID,
  baseEpochSec,
  isoOf,
  parseCommit,
  parseTree,
  peelToCommit,
  type Issue,
  type PullRequest,
  type Repo,
  type Store,
} from './store.ts';
import { deleteContent, pullFiles, mergePull, writeContent } from './ops.ts';
import { baseUrlOf, globalId, isAuthed, readBody, sendJson } from './http.ts';

type Json = Record<string, unknown>;

function userJson(store: Store): Json {
  const viewer = store.viewer;
  return {
    login: viewer.login,
    id: viewer.id,
    node_id: globalId('User', viewer.id),
    type: 'User',
    name: viewer.name,
    email: viewer.email,
  };
}

export function repoJson(store: Store, repo: Repo): Json {
  const iso = isoOf(baseEpochSec() + repo.createdSeq);
  return {
    id: repo.id,
    node_id: globalId('Repository', repo.id),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(store),
    private: repo.isPrivate,
    description: repo.description,
    html_url: `https://github.invalid/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    fork: false,
    created_at: iso,
    updated_at: iso,
    pushed_at: iso,
    default_branch: repo.defaultBranch,
    visibility: repo.isPrivate ? 'private' : 'public',
  };
}

function labelJson(repo: Repo, name: string): Json | null {
  const label = repo.labels.get(name);
  if (!label) return null;
  return {
    id: label.id,
    node_id: globalId('Label', label.id),
    name: label.name,
    color: label.color,
    description: label.description,
    default: false,
  };
}

export function issueJson(store: Store, repo: Repo, issue: Issue): Json {
  const iso = isoOf(baseEpochSec() + issue.createdSeq);
  return {
    id: issue.id,
    node_id: globalId('Issue', issue.id),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(repo, name)).filter((label) => label !== null),
    user: userJson(store),
    comments: issue.comments.length,
    created_at: iso,
    updated_at: iso,
    closed_at: issue.state === 'closed' ? iso : null,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    html_url: `https://github.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function commentJson(store: Store, comment: { id: number; body: string; createdSeq: number }): Json {
  const iso = isoOf(baseEpochSec() + comment.createdSeq);
  return {
    id: comment.id,
    node_id: globalId('IssueComment', comment.id),
    body: comment.body,
    user: userJson(store),
    created_at: iso,
    updated_at: iso,
  };
}

export function pullJson(store: Store, repo: Repo, pull: PullRequest): Json {
  const iso = isoOf(baseEpochSec() + pull.createdSeq);
  const headSha = store.branchTip(repo, pull.headRef) ?? pull.mergeCommitSha ?? ZERO_OID;
  const baseSha = store.branchTip(repo, pull.baseRef) ?? pull.baseShaAtCreate;
  const side = (ref: string, sha: string): Json => ({
    label: `${repo.owner}:${ref}`,
    ref,
    sha,
    user: userJson(store),
    repo: repoJson(store, repo),
  });
  return {
    id: pull.id,
    node_id: globalId('PullRequest', pull.id),
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    user: userJson(store),
    head: side(pull.headRef, headSha),
    base: side(pull.baseRef, baseSha),
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    created_at: iso,
    updated_at: pull.mergedAt ?? iso,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    html_url: `https://github.invalid/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

function parseIdent(line: string): Json {
  const match = /^(.*) <(.*)> (\d+) ([+-]\d{4})$/.exec(line);
  if (!match) return { name: '', email: '', date: isoOf(baseEpochSec()) };
  return {
    name: match[1] as string,
    email: match[2] as string,
    date: isoOf(Number(match[3])),
  };
}

function commitJson(repo: Repo, sha: string): Json {
  const object = repo.objects.get(sha);
  const parsed = object && object.type === 'commit' ? parseCommit(object.data) : null;
  return {
    sha,
    node_id: globalId('Commit', sha),
    commit: {
      author: parsed ? parseIdent(parsed.author) : { name: '', email: '', date: isoOf(baseEpochSec()) },
      committer: parsed ? parseIdent(parsed.committer) : { name: '', email: '', date: isoOf(baseEpochSec()) },
      message: parsed ? parsed.message : '',
      tree: { sha: parsed ? parsed.tree : ZERO_OID },
    },
    parents: parsed ? parsed.parents.map((parent) => ({ sha: parent })) : [],
  };
}

// --------------------------------------------------------------------------- plumbing

interface Ctx {
  store: Store;
  req: IncomingMessage;
  res: ServerResponse;
  requestId: string;
  baseUrl: string;
}

function reply(ctx: Ctx, status: number, body: unknown, headers: Record<string, string> = {}): void {
  sendJson(ctx.res, status, body, { 'x-github-request-id': ctx.requestId, ...headers });
}

function fail(ctx: Ctx, status: number, message: string): void {
  reply(ctx, status, { message });
}

interface Pagination {
  perPage: number;
  page: number;
}

function paginationOf(query: URLSearchParams): Pagination {
  const perPageRaw = Number(query.get('per_page') ?? '30');
  const pageRaw = Number(query.get('page') ?? '1');
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(100, Math.floor(perPageRaw)) : 30;
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 1;
  return { perPage, page };
}

/** Slice one page and build the GitHub Link header for the rest. */
function paged<T>(ctx: Ctx, items: T[], query: URLSearchParams, path: string): { slice: T[]; headers: Record<string, string> } {
  const { perPage, page } = paginationOf(query);
  const total = items.length;
  const slice = items.slice((page - 1) * perPage, page * perPage);
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  const urlFor = (target: number): string => {
    const params = new URLSearchParams(query);
    params.set('per_page', String(perPage));
    params.set('page', String(target));
    return `<${ctx.baseUrl}${path}?${params.toString()}>`;
  };
  const links: string[] = [];
  if (page < lastPage) {
    links.push(`${urlFor(page + 1)}; rel="next"`, `${urlFor(lastPage)}; rel="last"`);
  }
  if (page > 1) {
    links.push(`${urlFor(1)}; rel="first"`, `${urlFor(page - 1)}; rel="prev"`);
  }
  return { slice, headers: links.length > 0 ? { link: links.join(', ') } : {} };
}

function asObject(value: unknown): Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : {};
}

function stringOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

// --------------------------------------------------------------------------- contents

function contentsGet(ctx: Ctx, repo: Repo, path: string, refParam: string | null): void {
  const commit = refParam !== null && refParam !== '' ? ctx.store.resolveRef(repo, refParam) : ctx.store.defaultTip(repo);
  if (commit === null) return fail(ctx, 404, 'Not Found');
  const commitObject = repo.objects.get(commit);
  if (!commitObject || commitObject.type !== 'commit') return fail(ctx, 404, 'Not Found');
  let treeOid = parseCommit(commitObject.data).tree;
  const segments = path === '' ? [] : path.split('/');
  for (let i = 0; i < segments.length; i += 1) {
    const tree = repo.objects.get(treeOid);
    if (!tree || tree.type !== 'tree') return fail(ctx, 404, 'Not Found');
    const entry = parseTree(tree.data).find((candidate) => candidate.name === segments[i]);
    if (!entry) return fail(ctx, 404, 'Not Found');
    if (i === segments.length - 1) {
      if (entry.mode === '40000') return contentsDir(ctx, repo, entry.oid, path);
      const blob = repo.objects.get(entry.oid);
      if (!blob || blob.type !== 'blob') return fail(ctx, 404, 'Not Found');
      const base64 = blob.data.toString('base64');
      const wrapped = `${base64.replace(/.{60}/g, '$&\n')}${base64.length % 60 === 0 && base64.length > 0 ? '' : '\n'}`;
      return reply(ctx, 200, {
        type: 'file',
        encoding: 'base64',
        size: blob.data.length,
        name: entry.name,
        path,
        sha: entry.oid,
        content: wrapped,
        url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
        html_url: `https://github.invalid/${repo.owner}/${repo.name}/blob/${repo.defaultBranch}/${path}`,
        download_url: `https://github.invalid/${repo.owner}/${repo.name}/raw/${repo.defaultBranch}/${path}`,
      });
    }
    if (entry.mode !== '40000') return fail(ctx, 404, 'Not Found');
    treeOid = entry.oid;
  }
  return contentsDir(ctx, repo, treeOid, path);
}

function contentsDir(ctx: Ctx, repo: Repo, treeOid: string, path: string): void {
  const tree = repo.objects.get(treeOid);
  if (!tree || tree.type !== 'tree') return fail(ctx, 404, 'Not Found');
  const entries = parseTree(tree.data).map((entry) => {
    const isDir = entry.mode === '40000';
    const blob = isDir ? null : repo.objects.get(entry.oid);
    return {
      type: isDir ? 'dir' : 'file',
      size: blob && blob.type === 'blob' ? blob.data.length : 0,
      name: entry.name,
      path: path === '' ? entry.name : `${path}/${entry.name}`,
      sha: entry.oid,
      url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path === '' ? entry.name : `${path}/${entry.name}`}`,
      html_url: '',
      download_url: null,
    };
  });
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  reply(ctx, 200, entries);
}

// --------------------------------------------------------------------------- the router

export async function handleRest(store: Store, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  store.requestSeq += 1;
  const ctx: Ctx = {
    store,
    req,
    res,
    requestId: store.requestSeq.toString(16).toUpperCase().padStart(8, '0'),
    baseUrl: baseUrlOf(req),
  };
  const method = (req.method ?? 'GET').toUpperCase();
  const segments = url.pathname
    .split('/')
    .filter((segment) => segment !== '')
    .map((segment) => decodeURIComponent(segment));
  // segments[0] is 'api', segments[1] is 'v3' (the caller routes only /api/v3 here).
  const tail = segments.slice(2);

  // The API root answers without a token, as the starter (and api.github.com) do.
  if (tail.length === 0 && method === 'GET') {
    return reply(
      ctx,
      200,
      { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit', repository_url: '/api/v3/repos/{owner}/{repo}' },
      { 'x-oauth-scopes': 'repo, read:org' },
    );
  }

  if (!isAuthed(req)) return fail(ctx, 401, 'Requires authentication');

  // Bodies: a malformed JSON body is a 400 on any route that carries one.
  let body: unknown = undefined;
  if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
    const raw = await readBody(req);
    if (raw.length > 0) {
      try {
        body = JSON.parse(raw.toString('utf8'));
      } catch {
        return fail(ctx, 400, 'Problems parsing JSON');
      }
    }
  }
  const input = asObject(body);
  const query = url.searchParams;

  if (tail[0] === 'meta' && tail.length === 1 && method === 'GET') {
    return reply(ctx, 200, { installed_version: '3.10.0', github_hostname: 'github.invalid', verifiable_password_authentication: false });
  }

  if (tail[0] === 'user' && tail.length === 1 && method === 'GET') {
    return reply(ctx, 200, userJson(store));
  }

  if (tail[0] === 'user' && tail[1] === 'repos' && tail.length === 2) {
    if (method === 'GET') {
      const all = store.viewerRepos().map((repo) => repoJson(store, repo));
      const { slice, headers } = paged(ctx, all, query, '/api/v3/user/repos');
      return reply(ctx, 200, slice, headers);
    }
    if (method === 'POST') {
      const name = stringOf(input.name);
      if (name === '') {
        return reply(ctx, 422, {
          message: 'Repository creation failed.',
          errors: [{ resource: 'Repository', code: 'missing_field', field: 'name', message: 'name is required' }],
        });
      }
      const repo = store.createRepo(name, stringOf(input.description), input.private !== false);
      if (repo === null) {
        return reply(ctx, 422, {
          message: 'Repository creation failed.',
          errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }],
        });
      }
      return reply(ctx, 201, repoJson(store, repo));
    }
  }

  if (tail[0] === 'repos' && tail.length >= 3) {
    const owner = tail[1] as string;
    const name = tail[2] as string;
    const repo = store.getRepo(owner, name);
    if (repo === null) return fail(ctx, 404, 'Not Found');
    const rest = tail.slice(3);
    const repoPath = `/api/v3/repos/${owner}/${name}`;

    if (rest.length === 0) {
      if (method === 'GET') return reply(ctx, 200, repoJson(store, repo));
      if (method === 'PATCH') {
        if (typeof input.description === 'string') repo.description = input.description;
        if (typeof input.name === 'string' && input.name !== '' && input.name !== repo.name) {
          // A rename re-keys the repository.
          store.repos.delete(store.key(repo.owner, repo.name));
          repo.name = input.name;
          store.repos.set(store.key(repo.owner, repo.name), repo);
        }
        if (typeof input.private === 'boolean') repo.isPrivate = input.private;
        if (typeof input.default_branch === 'string' && input.default_branch !== '') repo.defaultBranch = input.default_branch;
        return reply(ctx, 200, repoJson(store, repo));
      }
      if (method === 'DELETE') {
        store.deleteRepo(owner, name);
        return reply(ctx, 204, undefined);
      }
      return fail(ctx, 404, 'Not Found');
    }

    if (rest[0] === 'branches') {
      if (rest.length === 1 && method === 'GET') {
        const branches = [...repo.refs.entries()]
          .filter(([ref]) => ref.startsWith('refs/heads/'))
          .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha, url: '' }, protected: false }))
          .sort((a, b) => (a.name < b.name ? -1 : 1));
        const { slice, headers } = paged(ctx, branches, query, `${repoPath}/branches`);
        return reply(ctx, 200, slice, headers);
      }
      if (rest.length >= 2 && method === 'GET') {
        const branch = rest.slice(1).join('/');
        const sha = store.branchTip(repo, branch);
        if (sha === null) return fail(ctx, 404, 'Branch not found');
        return reply(ctx, 200, { name: branch, commit: { sha, url: '' }, protected: false });
      }
      return fail(ctx, 404, 'Not Found');
    }

    if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') {
      const shaParam = query.get('sha');
      const start = shaParam !== null && shaParam !== '' ? store.resolveRef(repo, shaParam) : store.defaultTip(repo);
      const commits: Json[] = [];
      if (start !== null) {
        const seen = new Set<string>();
        const queue: string[] = [start];
        const { perPage } = paginationOf(query);
        while (queue.length > 0 && commits.length < perPage) {
          const oid = queue.shift() as string;
          if (seen.has(oid)) continue;
          seen.add(oid);
          const object = repo.objects.get(oid);
          if (!object || object.type !== 'commit') continue;
          commits.push(commitJson(repo, oid));
          for (const parent of parseCommit(object.data).parents) queue.push(parent);
        }
      }
      return reply(ctx, 200, commits);
    }

    if (rest[0] === 'contents') {
      const path = rest.slice(1).join('/');
      if (method === 'GET') return contentsGet(ctx, repo, path, query.get('ref'));
      if (method === 'PUT') {
        const contentRaw = stringOf(input.content);
        const content = Buffer.from(contentRaw.replace(/[\r\n\t ]+/g, ''), 'base64');
        const result = writeContent(store, repo, {
          path,
          content,
          message: stringOf(input.message) || 'Update file',
          branch: typeof input.branch === 'string' ? input.branch : undefined,
          sha: typeof input.sha === 'string' ? input.sha : undefined,
        });
        if (!result.ok) return fail(ctx, result.status, result.message);
        const commit = commitJson(repo, result.commitSha);
        const parsed = parseCommit(repo.objects.get(result.commitSha)?.data ?? Buffer.alloc(0));
        return reply(ctx, result.status, {
          content: {
            name: path.split('/').pop() ?? path,
            path,
            sha: result.contentSha,
            size: content.length,
            type: 'file',
            encoding: 'base64',
          },
          commit: {
            sha: result.commitSha,
            message: parsed.message,
            author: parseIdent(parsed.author),
            committer: parseIdent(parsed.committer),
            tree: { sha: parsed.tree },
            parents: commit.parents,
          },
        });
      }
      if (method === 'DELETE') {
        const result = deleteContent(store, repo, {
          path,
          message: stringOf(input.message) || 'Delete file',
          branch: typeof input.branch === 'string' ? input.branch : undefined,
          sha: typeof input.sha === 'string' ? input.sha : undefined,
        });
        if (!result.ok) return fail(ctx, result.status, result.message);
        return reply(ctx, 200, { content: null, commit: commitJson(repo, result.commitSha) });
      }
      return fail(ctx, 404, 'Not Found');
    }

    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (rest.length === 2 && method === 'POST') {
        const ref = stringOf(input.ref);
        const sha = stringOf(input.sha);
        if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/i.test(sha)) return fail(ctx, 422, 'Invalid ref or sha');
        if (!repo.objects.has(sha.toLowerCase())) return fail(ctx, 422, 'Object does not exist');
        if (repo.refs.has(ref)) {
          return reply(ctx, 422, { message: 'Reference already exists', errors: [{ resource: 'GitReference', code: 'custom', message: 'Reference already exists' }] });
        }
        repo.refs.set(ref, sha.toLowerCase());
        const object = repo.objects.get(sha.toLowerCase());
        return reply(ctx, 201, { ref, node_id: globalId('GitRef', ref), url: '', object: { sha: sha.toLowerCase(), type: object?.type ?? 'commit', url: '' } });
      }
      if (method === 'GET') {
        const refJson = (ref: string, sha: string): Json => ({
          ref,
          node_id: globalId('GitRef', ref),
          url: '',
          object: { sha, type: repo.objects.get(sha)?.type ?? 'commit', url: '' },
        });
        if (rest.length === 2) {
          const all = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([ref, sha]) => refJson(ref, sha));
          return reply(ctx, 200, all);
        }
        const ref = `refs/${rest.slice(2).join('/')}`;
        const sha = repo.refs.get(ref);
        if (sha === undefined) return fail(ctx, 404, 'Not Found');
        return reply(ctx, 200, refJson(ref, sha));
      }
      return fail(ctx, 404, 'Not Found');
    }

    if (rest[0] === 'labels') {
      if (rest.length === 1 && method === 'POST') {
        const labelName = stringOf(input.name);
        if (labelName === '') return fail(ctx, 422, 'Validation Failed: name is required');
        if (repo.labels.has(labelName)) {
          return reply(ctx, 422, { message: 'Validation Failed', errors: [{ resource: 'Label', code: 'already_exists', field: 'name' }] });
        }
        const label = {
          id: store.nextLabelId(),
          name: labelName,
          color: (stringOf(input.color) || 'ededed').replace(/^#/, ''),
          description: stringOf(input.description),
        };
        repo.labels.set(labelName, label);
        return reply(ctx, 201, labelJson(repo, labelName));
      }
      if (rest.length === 1 && method === 'GET') {
        const all = [...repo.labels.keys()].sort().map((labelName) => labelJson(repo, labelName));
        return reply(ctx, 200, all);
      }
      if (rest.length === 2 && method === 'GET') {
        const found = labelJson(repo, rest[1] as string);
        if (found === null) return fail(ctx, 404, 'Not Found');
        return reply(ctx, 200, found);
      }
      return fail(ctx, 404, 'Not Found');
    }

    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (method === 'POST') {
          const title = stringOf(input.title);
          if (title === '') return fail(ctx, 422, 'Validation Failed: title is required');
          const labelNames: string[] = [];
          if (Array.isArray(input.labels)) {
            for (const entry of input.labels) {
              const labelName = typeof entry === 'string' ? entry : stringOf(asObject(entry).name);
              if (labelName === '') continue;
              if (!repo.labels.has(labelName)) return fail(ctx, 422, `Validation Failed: label "${labelName}" does not exist`);
              labelNames.push(labelName);
            }
          }
          const issue = store.createIssue(repo, title, stringOf(input.body), labelNames);
          return reply(ctx, 201, issueJson(store, repo, issue));
        }
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          let issues = [...repo.issues.values()];
          if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
          else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
          const direction = query.get('direction') ?? 'desc';
          issues.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
          const all = issues.map((issue) => issueJson(store, repo, issue));
          const { slice, headers } = paged(ctx, all, query, `${repoPath}/issues`);
          return reply(ctx, 200, slice, headers);
        }
        return fail(ctx, 404, 'Not Found');
      }
      const number = Number(rest[1]);
      const issue = Number.isInteger(number) ? repo.issues.get(number) : undefined;
      if (rest.length === 2) {
        if (issue === undefined) return fail(ctx, 404, 'Not Found');
        if (method === 'GET') return reply(ctx, 200, issueJson(store, repo, issue));
        if (method === 'PATCH') {
          if (input.state === 'open' || input.state === 'closed') issue.state = input.state;
          if (typeof input.title === 'string') issue.title = input.title;
          if (typeof input.body === 'string') issue.body = input.body;
          if (Array.isArray(input.labels)) {
            const labelNames: string[] = [];
            for (const entry of input.labels) {
              const labelName = typeof entry === 'string' ? entry : stringOf(asObject(entry).name);
              if (labelName !== '' && repo.labels.has(labelName)) labelNames.push(labelName);
            }
            issue.labels = labelNames;
          }
          return reply(ctx, 200, issueJson(store, repo, issue));
        }
        return fail(ctx, 404, 'Not Found');
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        if (issue === undefined) return fail(ctx, 404, 'Not Found');
        if (method === 'POST') {
          const comment = { id: store.nextCommentId(), body: stringOf(input.body), createdSeq: issue.comments.length + 1 };
          issue.comments.push(comment);
          return reply(ctx, 201, commentJson(store, comment));
        }
        if (method === 'GET') {
          const all = issue.comments.map((comment) => commentJson(store, comment));
          const { slice, headers } = paged(ctx, all, query, `${repoPath}/issues/${number}/comments`);
          return reply(ctx, 200, slice, headers);
        }
        return fail(ctx, 404, 'Not Found');
      }
      return fail(ctx, 404, 'Not Found');
    }

    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (method === 'POST') {
          const title = stringOf(input.title);
          const headRaw = stringOf(input.head);
          const baseRaw = stringOf(input.base);
          const head = headRaw.includes(':') ? (headRaw.split(':').pop() as string) : headRaw;
          const base = baseRaw.includes(':') ? (baseRaw.split(':').pop() as string) : baseRaw;
          if (title === '' || head === '' || base === '') return fail(ctx, 422, 'Validation Failed: title, head and base are required');
          if (store.branchTip(repo, head) === null || store.branchTip(repo, base) === null) {
            return fail(ctx, 422, 'Validation Failed: head or base branch does not exist');
          }
          if (store.openPullFor(repo, head, base) !== null) {
            return fail(ctx, 422, `A pull request already exists for ${repo.owner}:${head}.`);
          }
          const pull = store.createPull(repo, title, stringOf(input.body), head, base);
          if (pull === null) return fail(ctx, 422, 'Validation Failed');
          return reply(ctx, 201, pullJson(store, repo, pull));
        }
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          let pulls = [...repo.pulls.values()];
          if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
          else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
          const direction = query.get('direction') ?? 'desc';
          pulls.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
          const all = pulls.map((pull) => pullJson(store, repo, pull));
          const { slice, headers } = paged(ctx, all, query, `${repoPath}/pulls`);
          return reply(ctx, 200, slice, headers);
        }
        return fail(ctx, 404, 'Not Found');
      }
      const number = Number(rest[1]);
      const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;
      if (rest.length === 2 && method === 'GET') {
        if (pull === undefined) return fail(ctx, 404, 'Not Found');
        return reply(ctx, 200, pullJson(store, repo, pull));
      }
      if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
        if (pull === undefined) return fail(ctx, 404, 'Not Found');
        const files = pullFiles(repo, pull).map((file) => ({ ...file, sha: '', blob_url: '', raw_url: '' }));
        const { slice, headers } = paged(ctx, files, query, `${repoPath}/pulls/${number}/files`);
        return reply(ctx, 200, slice, headers);
      }
      if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
        if (pull === undefined) return fail(ctx, 404, 'Not Found');
        const result = mergePull(store, repo, pull);
        if (!result.ok) {
          if (result.reason === 'conflict') return fail(ctx, 405, 'Pull Request is not mergeable');
          if (result.reason === 'not-open') return fail(ctx, 405, 'Pull Request is not mergeable');
          return fail(ctx, 404, 'Not Found');
        }
        return reply(ctx, 200, { sha: result.sha, merged: true, message: 'Pull Request successfully merged' });
      }
      return fail(ctx, 404, 'Not Found');
    }

    return fail(ctx, 404, 'Not Found');
  }

  return fail(ctx, 404, 'Not Found');
}
