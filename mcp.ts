// The MCP endpoint at /mcp: JSON-RPC 2.0 over Streamable HTTP. It speaks the modern revision
// (server/discover answers supportedVersions, capabilities and identity) and the legacy
// initialize handshake, and its six tools act on the same store as REST and GraphQL, so an
// object created here reads back over /api/v3 unchanged.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Store } from './store.ts';
import { mergePull } from './ops.ts';
import { issueJson, pullJson, repoJson } from './rest.ts';
import { isAuthed, readBody, sendJson } from './http.ts';

const SERVER_INFO = { name: 'github-core-clone', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string; items?: { type: string } }>;
    required: string[];
  };
}

function tool(name: string, description: string, properties: ToolDef['inputSchema']['properties'], required: string[]): ToolDef {
  return { name, description, inputSchema: { type: 'object', properties, required } };
}

const OWNER = { type: 'string', description: 'The repository owner login.' };
const REPO = { type: 'string', description: 'The repository name.' };

/** The tool list, built once so two tools/list answers are byte-identical. */
const TOOLS: ToolDef[] = [
  tool(
    'create_repo',
    'Create a new repository owned by the authenticated user.',
    {
      name: { type: 'string', description: 'The repository name.' },
      description: { type: 'string', description: 'A short description of the repository.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
      owner: OWNER,
    },
    ['name'],
  ),
  tool('get_repo', 'Get a repository by owner and name.', { owner: OWNER, repo: REPO }, ['owner', 'repo']),
  tool(
    'create_issue',
    'Create an issue in a repository.',
    {
      owner: OWNER,
      repo: REPO,
      title: { type: 'string', description: 'The issue title.' },
      body: { type: 'string', description: 'The issue body.' },
      labels: { type: 'array', items: { type: 'string' }, description: 'Label names to apply.' },
    },
    ['owner', 'repo', 'title'],
  ),
  tool(
    'list_issues',
    'List the issues of a repository, optionally filtered by state (open, closed or all).',
    {
      owner: OWNER,
      repo: REPO,
      state: { type: 'string', description: 'Filter by state: open, closed or all.' },
    },
    ['owner', 'repo'],
  ),
  tool(
    'create_pull_request',
    'Open a pull request from a head branch into a base branch.',
    {
      owner: OWNER,
      repo: REPO,
      title: { type: 'string', description: 'The pull request title.' },
      body: { type: 'string', description: 'The pull request body.' },
      head: { type: 'string', description: 'The head branch name.' },
      base: { type: 'string', description: 'The base branch name.' },
    },
    ['owner', 'repo', 'title', 'head', 'base'],
  ),
  tool(
    'merge_pull_request',
    'Squash-merge a pull request by number.',
    {
      owner: OWNER,
      repo: REPO,
      pull_number: { type: 'number', description: 'The pull request number.' },
    },
    ['owner', 'repo', 'pull_number'],
  ),
];

type Json = Record<string, unknown>;

interface Reply {
  status: number;
  body: unknown;
}

function ok(id: unknown, result: unknown): Reply {
  return { status: 200, body: { jsonrpc: '2.0', id: id ?? null, result } };
}

function fail(id: unknown, code: number, message: string, status = 200): Reply {
  return { status, body: { jsonrpc: '2.0', id: id ?? null, error: { code, message } } };
}

function toolOk(id: unknown, payload: unknown): Reply {
  return ok(id, {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError: false,
  });
}

function toolError(id: unknown, message: string): Reply {
  return ok(id, { content: [{ type: 'text', text: message }], isError: true });
}

function stringArg(args: Json, key: string): string {
  const value = args[key];
  return typeof value === 'string' ? value : '';
}

function callTool(store: Store, id: unknown, params: Json): Reply {
  const name = stringArg(params, 'name');
  const definition = TOOLS.find((candidate) => candidate.name === name);
  if (definition === undefined) return fail(id, -32602, `Unknown tool: ${name}`);
  const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Json;
  for (const required of definition.inputSchema.required) {
    const value = args[required];
    if (value === undefined || value === null || value === '') {
      return fail(id, -32602, `Missing required argument: ${required}`);
    }
  }

  switch (definition.name) {
    case 'create_repo': {
      const repoName = stringArg(args, 'name');
      const repo = store.createRepo(repoName, stringArg(args, 'description'), args.private !== false);
      if (repo === null) return toolError(id, `Repository ${repoName} already exists`);
      return toolOk(id, repoJson(store, repo));
    }
    case 'get_repo': {
      const repo = store.getRepo(stringArg(args, 'owner'), stringArg(args, 'repo'));
      if (repo === null) return toolError(id, 'Repository not found');
      return toolOk(id, repoJson(store, repo));
    }
    case 'create_issue': {
      const repo = store.getRepo(stringArg(args, 'owner'), stringArg(args, 'repo'));
      if (repo === null) return toolError(id, 'Repository not found');
      const labelNames: string[] = [];
      if (Array.isArray(args.labels)) {
        for (const entry of args.labels) {
          if (typeof entry !== 'string' || entry === '') continue;
          if (!repo.labels.has(entry)) return toolError(id, `Label "${entry}" does not exist`);
          labelNames.push(entry);
        }
      }
      const issue = store.createIssue(repo, stringArg(args, 'title'), stringArg(args, 'body'), labelNames);
      return toolOk(id, issueJson(store, repo, issue));
    }
    case 'list_issues': {
      const repo = store.getRepo(stringArg(args, 'owner'), stringArg(args, 'repo'));
      if (repo === null) return toolError(id, 'Repository not found');
      const state = stringArg(args, 'state') || 'open';
      let issues = [...repo.issues.values()];
      if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
      else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
      issues.sort((a, b) => a.createdSeq - b.createdSeq);
      return toolOk(id, { issues: issues.map((issue) => issueJson(store, repo, issue)) });
    }
    case 'create_pull_request': {
      const repo = store.getRepo(stringArg(args, 'owner'), stringArg(args, 'repo'));
      if (repo === null) return toolError(id, 'Repository not found');
      const head = stringArg(args, 'head');
      const base = stringArg(args, 'base');
      if (store.branchTip(repo, head) === null || store.branchTip(repo, base) === null) {
        return toolError(id, 'Head or base branch does not exist');
      }
      if (store.openPullFor(repo, head, base) !== null) {
        return toolError(id, 'A pull request already exists for this head and base');
      }
      const pull = store.createPull(repo, stringArg(args, 'title'), stringArg(args, 'body'), head, base);
      if (pull === null) return toolError(id, 'Could not create the pull request');
      return toolOk(id, pullJson(store, repo, pull));
    }
    case 'merge_pull_request': {
      const repo = store.getRepo(stringArg(args, 'owner'), stringArg(args, 'repo'));
      if (repo === null) return toolError(id, 'Repository not found');
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
      const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;
      if (pull === undefined) return toolError(id, 'Pull request not found');
      const result = mergePull(store, repo, pull);
      if (!result.ok) {
        return toolError(id, result.reason === 'conflict' ? 'Pull Request is not mergeable' : 'Pull Request cannot be merged');
      }
      return toolOk(id, pullJson(store, repo, pull));
    }
    default:
      return fail(id, -32602, `Unknown tool: ${name}`);
  }
}

function discoverResult(): Json {
  return {
    resultType: 'complete',
    supportedVersions: SUPPORTED_VERSIONS,
    capabilities: { tools: {} },
    serverInfo: SERVER_INFO,
    _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
    instructions: 'A GitHub-compatible forge: repositories, issues and pull requests over MCP.',
  };
}

/** Dispatches one JSON-RPC message; a null reply means a notification (answer 202, no body). */
function dispatch(store: Store, message: Json): Reply | null {
  const id = message.id;
  const method = stringArg(message, 'method');
  const params = (typeof message.params === 'object' && message.params !== null ? message.params : {}) as Json;
  if (id === undefined || id === null) return null;
  switch (method) {
    case 'server/discover':
      return ok(id, discoverResult());
    case 'initialize': {
      const requested = stringArg(params, 'protocolVersion');
      const protocolVersion = SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
      return ok(id, { protocolVersion, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
    }
    case 'ping':
      return ok(id, {});
    case 'tools/list':
      return ok(id, { tools: TOOLS });
    case 'tools/call':
      return callTool(store, id, params);
    case 'resources/list':
      return ok(id, { resources: [] });
    case 'prompts/list':
      return ok(id, { prompts: [] });
    default:
      return fail(id, -32601, `Method not found: ${method}`);
  }
}

export async function handleMcp(store: Store, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method === 'DELETE') {
    // Session teardown for the legacy era: stateless here, so it always succeeds.
    sendJson(res, 200, {});
    return;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { jsonrpc: '2.0', id: null, error: { code: -32601, message: 'Method not allowed' } });
    return;
  }
  if (!isAuthed(req)) {
    sendJson(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized: a bearer <redacted> is required' } });
    return;
  }
  const raw = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: the body is not JSON' } });
    return;
  }
  if (Array.isArray(parsed)) {
    // Batched requests (dropped by newer revisions, still answered in order).
    const replies: unknown[] = [];
    for (const entry of parsed) {
      if (typeof entry === 'object' && entry !== null) {
        const reply = dispatch(store, entry as Json);
        if (reply !== null) replies.push(reply.body);
      }
    }
    sendJson(res, 200, replies);
    return;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } });
    return;
  }
  const reply = dispatch(store, parsed as Json);
  if (reply === null) {
    res.writeHead(202);
    res.end();
    return;
  }
  sendJson(res, reply.status, reply.body);
}
