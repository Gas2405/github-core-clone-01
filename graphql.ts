// The GraphQL v4 surface at /api/graphql: a small parser and executor for the documents gh and
// github-mcp-server send — viewer, repository reads, issue/pull connections with cursor paging,
// the five mutations, Relay node(id:), batched operations, and the introspection probes gh
// feature-detects with. Unknown fields answer HTTP 200 with an errors array naming them; an
// unknown repository answers data.repository = null with no errors; no token answers 401.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { baseEpochSec, isoOf, type Issue, type PullRequest, type Repo, type Store } from './store.ts';
import { mergePull, pullFiles, pullMergeable } from './ops.ts';
import { globalId, isAuthed, parseGlobalId, readBody, sendJson } from './http.ts';

// --------------------------------------------------------------------------- syntax

type Value =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: Value[] }
  | { kind: 'object'; fields: Map<string, Value> };

interface FieldNode {
  alias: string | null;
  name: string;
  args: Map<string, Value>;
  selections: Selection[];
}

type Selection =
  | { kind: 'field'; field: FieldNode }
  | { kind: 'inline'; typeCondition: string | null; selections: Selection[] }
  | { kind: 'spread'; name: string };

interface Operation {
  type: 'query' | 'mutation';
  name: string | null;
  selections: Selection[];
}

interface Document {
  operations: Operation[];
  fragments: Map<string, { typeCondition: string | null; selections: Selection[] }>;
}

function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i] as string;
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (/\s|,/.test(ch)) {
      i += 1;
      continue;
    }
    if (input.startsWith('...', i)) {
      tokens.push('...');
      i += 3;
      continue;
    }
    if ('!$():=@[]{}|&'.includes(ch)) {
      tokens.push(ch);
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (input.startsWith('"""', i)) {
        const end = input.indexOf('"""', i + 3);
        if (end === -1) throw new Error('unterminated block string');
        tokens.push(`"${input.slice(i + 3, end)}"`);
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\') {
          value += input[j + 1] === 'u' ? String.fromCharCode(parseInt(input.slice(j + 2, j + 6), 16)) : escapeOf(input[j + 1] as string);
          j += input[j + 1] === 'u' ? 6 : 2;
        } else {
          value += input[j];
          j += 1;
        }
      }
      if (j >= input.length) throw new Error('unterminated string');
      tokens.push(`"${value}"`);
      i = j + 1;
      continue;
    }
    const nameMatch = /^[_A-Za-z][_0-9A-Za-z]*/.exec(input.slice(i));
    if (nameMatch) {
      tokens.push(nameMatch[0]);
      i += nameMatch[0].length;
      continue;
    }
    const numberMatch = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(input.slice(i));
    if (numberMatch) {
      tokens.push(numberMatch[0]);
      i += numberMatch[0].length;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)}`);
  }
  return tokens;
}

function escapeOf(ch: string): string {
  switch (ch) {
    case 'n':
      return '\n';
    case 't':
      return '\t';
    case 'r':
      return '\r';
    case 'b':
      return '\b';
    case 'f':
      return '\f';
    case '/':
      return '/';
    case '\\':
      return '\\';
    case '"':
      return '"';
    default:
      return ch;
  }
}

class Parser {
  private pos = 0;

  private readonly tokens: string[];

  constructor(tokens: string[]) {
    this.tokens = tokens;
  }

  peek(): string | undefined {
    return this.tokens[this.pos];
  }

  next(): string {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('unexpected end of document');
    this.pos += 1;
    return token;
  }

  expect(token: string): void {
    const got = this.next();
    if (got !== token) throw new Error(`expected ${token}, got ${got}`);
  }

  parseDocument(): Document {
    const operations: Operation[] = [];
    const fragments = new Map<string, { typeCondition: string | null; selections: Selection[] }>();
    while (this.pos < this.tokens.length) {
      const token = this.peek();
      if (token === 'query' || token === 'mutation' || token === 'subscription') {
        const type = this.next() as 'query' | 'mutation';
        let name: string | null = null;
        if (this.peek() !== undefined && /^[_A-Za-z]/.test(this.peek() as string) && this.peek() !== '(' && this.peek() !== '{') {
          name = this.next();
        }
        if (this.peek() === '(') this.skipBalanced();
        // Directives on the operation are skipped.
        while (this.peek() === '@') {
          this.next();
          this.next();
          if (this.peek() === '(') this.skipBalanced();
        }
        operations.push({ type, name, selections: this.parseSelectionSet() });
      } else if (token === 'fragment') {
        this.next();
        const fragName = this.next();
        this.expect('on');
        const typeCondition = this.next();
        if (this.peek() === '(') this.skipBalanced();
        fragments.set(fragName, { typeCondition, selections: this.parseSelectionSet() });
      } else if (token === '{') {
        operations.push({ type: 'query', name: null, selections: this.parseSelectionSet() });
      } else {
        throw new Error(`unexpected token ${token}`);
      }
    }
    return { operations, fragments };
  }

  private skipBalanced(): void {
    let depth = 0;
    do {
      const token = this.next();
      if (token === '(' || token === '[' || token === '{') depth += 1;
      if (token === ')' || token === ']' || token === '}') depth -= 1;
    } while (depth > 0);
  }

  private parseSelectionSet(): Selection[] {
    this.expect('{');
    const selections: Selection[] = [];
    while (this.peek() !== '}') {
      if (this.peek() === '...') {
        this.next();
        if (this.peek() === 'on') {
          this.next();
          const typeCondition = this.next();
          selections.push({ kind: 'inline', typeCondition, selections: this.parseSelectionSet() });
        } else {
          selections.push({ kind: 'spread', name: this.next() });
        }
        continue;
      }
      selections.push({ kind: 'field', field: this.parseField() });
    }
    this.expect('}');
    return selections;
  }

  private parseField(): FieldNode {
    let name = this.next();
    let alias: string | null = null;
    if (this.peek() === ':') {
      this.next();
      alias = name;
      name = this.next();
    }
    const args = new Map<string, Value>();
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')') {
        const argName = this.next();
        this.expect(':');
        args.set(argName, this.parseValue());
      }
      this.expect(')');
    }
    // Field directives are skipped.
    while (this.peek() === '@') {
      this.next();
      this.next();
      if (this.peek() === '(') this.skipBalanced();
    }
    const selections = this.peek() === '{' ? this.parseSelectionSet() : [];
    return { alias, name, args, selections };
  }

  private parseValue(): Value {
    const token = this.next();
    if (token === '$') return { kind: 'variable', name: this.next() };
    if (token === '[') {
      const items: Value[] = [];
      while (this.peek() !== ']') items.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', items };
    }
    if (token === '{') {
      const fields = new Map<string, Value>();
      while (this.peek() !== '}') {
        const key = this.next();
        this.expect(':');
        fields.set(key, this.parseValue());
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (token.startsWith('"')) return { kind: 'string', value: token.slice(1, -1) };
    if (token === 'true') return { kind: 'boolean', value: true };
    if (token === 'false') return { kind: 'boolean', value: false };
    if (token === 'null') return { kind: 'null' };
    if (/^-?\d+$/.test(token)) return { kind: 'int', value: Number(token) };
    if (/^-?\d/.test(token)) return { kind: 'float', value: Number(token) };
    return { kind: 'enum', value: token };
  }
}

function evaluate(value: Value, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'variable':
      return variables[value.name] ?? null;
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
    case 'enum':
      return value.value;
    case 'null':
      return null;
    case 'list':
      return value.items.map((item) => evaluate(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, item] of value.fields) out[key] = evaluate(item, variables);
      return out;
    }
  }
}

// --------------------------------------------------------------------------- schema

const OBJECT_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'nodes', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['id', 'login', 'name', 'email', 'url'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'isPrivate', 'viewerPermission',
    'hasIssuesEnabled', 'hasPullRequestsEnabled', 'defaultBranchRef', 'issue', 'issues', 'pullRequest',
    'pullRequests', 'createdAt', 'updatedAt', 'url',
  ],
  Ref: ['name', 'prefix', 'target'],
  Issue: [
    'id', 'number', 'title', 'body', 'state', 'author', 'createdAt', 'updatedAt', 'closedAt', 'labels',
    'comments', 'repository', 'url',
  ],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'mergedAt', 'mergeable', 'headRefName',
    'baseRefName', 'files', 'author', 'createdAt', 'updatedAt', 'repository', 'url', 'additions',
    'deletions', 'changedFiles',
  ],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PullRequestEdge: ['node', 'cursor'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  PullRequestFile: ['path', 'additions', 'deletions', 'changeType'],
  Label: ['id', 'name', 'color', 'description'],
  LabelConnection: ['nodes', 'totalCount'],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'updatedAt'],
  IssueCommentConnection: ['nodes', 'totalCount'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'subject', 'clientMutationId'],
  CommentEdge: ['node', 'cursor'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues', 'possibleTypes', 'inputFields', 'interfaces', 'ofType'],
  __Field: ['name', 'description', 'type', 'args', 'isDeprecated', 'deprecationReason'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason'],
  __Schema: ['types', 'queryType', 'mutationType', 'subscriptionType', 'directives'],
  __InputValue: ['name', 'description', 'type', 'defaultValue'],
  __Directive: ['name', 'description', 'locations', 'args'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  PullRequestOrderField: ['CREATED_AT', 'UPDATED_AT'],
  RepositoryPrivacy: ['PUBLIC', 'PRIVATE'],
  Permission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  FileChangeType: ['ADDED', 'DELETED', 'MODIFIED', 'RENAMED', 'COPIED', 'CHANGED'],
};

/** The child object type a field resolves to, where it resolves to an object at all. */
const FIELD_TYPES: Record<string, Record<string, string>> = {
  Query: { viewer: 'User', repository: 'Repository', node: 'Node', __type: '__Type', __schema: '__Schema' },
  Mutation: {
    createIssue: 'CreateIssuePayload',
    closeIssue: 'CloseIssuePayload',
    createPullRequest: 'CreatePullRequestPayload',
    mergePullRequest: 'MergePullRequestPayload',
    addComment: 'AddCommentPayload',
  },
  Repository: { owner: 'User', defaultBranchRef: 'Ref', issue: 'Issue', issues: 'IssueConnection', pullRequest: 'PullRequest', pullRequests: 'PullRequestConnection' },
  Issue: { author: 'User', labels: 'LabelConnection', comments: 'IssueCommentConnection', repository: 'Repository' },
  PullRequest: { author: 'User', files: 'PullRequestFileConnection', repository: 'Repository' },
  IssueConnection: { nodes: 'Issue', edges: 'IssueEdge', pageInfo: 'PageInfo' },
  PullRequestConnection: { nodes: 'PullRequest', edges: 'PullRequestEdge', pageInfo: 'PageInfo' },
  PullRequestFileConnection: { nodes: 'PullRequestFile', pageInfo: 'PageInfo' },
  IssueEdge: { node: 'Issue' },
  PullRequestEdge: { node: 'PullRequest' },
  LabelConnection: { nodes: 'Label' },
  IssueCommentConnection: { nodes: 'IssueComment' },
  IssueComment: { author: 'User' },
  CreateIssuePayload: { issue: 'Issue' },
  CloseIssuePayload: { issue: 'Issue' },
  CreatePullRequestPayload: { pullRequest: 'PullRequest' },
  MergePullRequestPayload: { pullRequest: 'PullRequest' },
  AddCommentPayload: { commentEdge: 'CommentEdge', subject: 'Issue' },
  CommentEdge: { node: 'IssueComment' },
  __Type: { fields: '__Field', enumValues: '__EnumValue', possibleTypes: '__Type', inputFields: '__InputValue', interfaces: '__Type', ofType: '__Type' },
  __Field: { type: '__Type', args: '__InputValue' },
  __Schema: { types: '__Type', queryType: '__Type', mutationType: '__Type', subscriptionType: '__Type', directives: '__Directive' },
  __Directive: { args: '__InputValue' },
};

const NODE_TYPES = new Set(['Repository', 'Issue', 'PullRequest', 'User', 'IssueComment', 'Label']);

// --------------------------------------------------------------------------- execution

interface Ctx {
  store: Store;
  document: Document;
  variables: Record<string, unknown>;
  errors: Array<{ message: string; path?: Array<string | number> }>;
}

type Wrapped =
  | { __type: 'User' }
  | { __type: 'Repository'; repo: Repo }
  | { __type: 'Issue'; repo: Repo; issue: Issue }
  | { __type: 'PullRequest'; repo: Repo; pull: PullRequest }
  | { __type: 'Ref'; name: string }
  | { __type: 'IssueConnection'; items: Array<{ repo: Repo; issue: Issue }>; total: number; pageInfo: PageInfo }
  | { __type: 'PullRequestConnection'; items: Array<{ repo: Repo; pull: PullRequest }>; total: number; pageInfo: PageInfo }
  | { __type: 'PullRequestFileConnection'; files: Array<{ path: string; additions: number; deletions: number; changeType: string }>; pageInfo: PageInfo }
  | { __type: 'PageInfo'; pageInfo: PageInfo }
  | { __type: 'PullRequestFile'; file: { path: string; additions: number; deletions: number; changeType: string } }
  | { __type: 'Label'; repo: Repo; name: string }
  | { __type: 'LabelConnection'; repo: Repo; names: string[] }
  | { __type: 'IssueComment'; repo: Repo; issue: Issue; comment: { id: number; body: string; createdSeq: number } }
  | { __type: 'IssueCommentConnection'; repo: Repo; issue: Issue }
  | { __type: 'CreateIssuePayload'; repo: Repo; issue: Issue }
  | { __type: 'CloseIssuePayload'; repo: Repo; issue: Issue }
  | { __type: 'CreatePullRequestPayload'; repo: Repo; pull: PullRequest }
  | { __type: 'MergePullRequestPayload'; repo: Repo; pull: PullRequest }
  | { __type: 'AddCommentPayload'; repo: Repo; issue: Issue; comment: { id: number; body: string; createdSeq: number } }
  | { __type: 'CommentEdge'; repo: Repo; issue: Issue; comment: { id: number; body: string; createdSeq: number } }
  | { __type: '__Type'; name: string }
  | { __type: '__Field'; name: string }
  | { __type: '__EnumValue'; name: string }
  | { __type: '__Schema' };

interface PageInfo {
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  startCursor: string | null;
  endCursor: string | null;
}

function cursorOf(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function indexOfCursor(cursor: unknown): number {
  if (typeof cursor !== 'string' || cursor === '') return -1;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match ? Number(match[1]) : -1;
  } catch {
    return -1;
  }
}

function page<T>(items: T[], first: unknown, after: unknown): { slice: T[]; pageInfo: PageInfo; total: number } {
  const total = items.length;
  const size = typeof first === 'number' && Number.isFinite(first) && first > 0 ? Math.floor(first) : total;
  const afterIndex = indexOfCursor(after);
  const start = afterIndex >= 0 ? afterIndex + 1 : 0;
  const slice = items.slice(start, start + size);
  return {
    slice,
    total,
    pageInfo: {
      hasNextPage: start + slice.length < total,
      hasPreviousPage: start > 0,
      startCursor: slice.length > 0 ? cursorOf(start) : null,
      endCursor: slice.length > 0 ? cursorOf(start + slice.length - 1) : null,
    },
  };
}

function iso(repo: { createdSeq: number }): string {
  return isoOf(baseEpochSec() + repo.createdSeq);
}

class FieldError extends Error {}

function findRepoById(store: Store, id: number): Repo | null {
  for (const repo of store.repos.values()) if (repo.id === id) return repo;
  return null;
}

function findIssueById(store: Store, id: number): { repo: Repo; issue: Issue } | null {
  for (const repo of store.repos.values()) {
    for (const issue of repo.issues.values()) if (issue.id === id) return { repo, issue };
  }
  return null;
}

function findPullById(store: Store, id: number): { repo: Repo; pull: PullRequest } | null {
  for (const repo of store.repos.values()) {
    for (const pull of repo.pulls.values()) if (pull.id === id) return { repo, pull };
  }
  return null;
}

function resolveField(ctx: Ctx, source: Wrapped | null, typeName: string, field: FieldNode): unknown {
  const args = new Map<string, unknown>();
  for (const [key, value] of field.args) args.set(key, evaluate(value, ctx.variables));
  const store = ctx.store;

  if (field.name === '__typename') return typeName;

  if (typeName === 'Query') {
    switch (field.name) {
      case 'viewer':
        return { __type: 'User' } satisfies Wrapped;
      case 'repository': {
        const owner = String(args.get('owner') ?? '');
        const name = String(args.get('name') ?? '');
        const repo = store.getRepo(owner, name);
        return repo === null ? null : ({ __type: 'Repository', repo } satisfies Wrapped);
      }
      case 'node': {
        const parsed = parseGlobalId(String(args.get('id') ?? ''));
        if (parsed === null) return null;
        const numeric = Number(parsed.id);
        if (parsed.type === 'Repository') {
          const repo = findRepoById(store, numeric);
          return repo === null ? null : ({ __type: 'Repository', repo } satisfies Wrapped);
        }
        if (parsed.type === 'Issue') {
          const found = findIssueById(store, numeric);
          return found === null ? null : ({ __type: 'Issue', ...found } satisfies Wrapped);
        }
        if (parsed.type === 'PullRequest') {
          const found = findPullById(store, numeric);
          return found === null ? null : ({ __type: 'PullRequest', ...found } satisfies Wrapped);
        }
        return null;
      }
      case '__type': {
        const typeName = String(args.get('name') ?? '');
        if (OBJECT_FIELDS[typeName] === undefined && ENUM_VALUES[typeName] === undefined && typeName !== 'Node') return null;
        return { __type: '__Type', name: typeName } satisfies Wrapped;
      }
      case '__schema':
        return { __type: '__Schema' } satisfies Wrapped;
      default:
        return null;
    }
  }

  if (typeName === 'Mutation') {
    const input = (args.get('input') ?? {}) as Record<string, unknown>;
    switch (field.name) {
      case 'createIssue': {
        const parsed = parseGlobalId(String(input.repositoryId ?? ''));
        const repo = parsed !== null && parsed.type === 'Repository' ? findRepoById(store, Number(parsed.id)) : null;
        if (repo === null) throw new FieldError('Could not resolve the repository for createIssue');
        const title = String(input.title ?? '');
        if (title === '') throw new FieldError('Title is required');
        const issue = store.createIssue(repo, title, String(input.body ?? ''), []);
        return { __type: 'CreateIssuePayload', repo, issue } satisfies Wrapped;
      }
      case 'closeIssue': {
        const parsed = parseGlobalId(String(input.issueId ?? ''));
        const found = parsed !== null && parsed.type === 'Issue' ? findIssueById(store, Number(parsed.id)) : null;
        if (found === null) throw new FieldError('Could not resolve the issue for closeIssue');
        found.issue.state = 'closed';
        return { __type: 'CloseIssuePayload', ...found } satisfies Wrapped;
      }
      case 'createPullRequest': {
        const parsed = parseGlobalId(String(input.repositoryId ?? ''));
        const repo = parsed !== null && parsed.type === 'Repository' ? findRepoById(store, Number(parsed.id)) : null;
        if (repo === null) throw new FieldError('Could not resolve the repository for createPullRequest');
        const head = String(input.headRefName ?? '');
        const base = String(input.baseRefName ?? '');
        if (store.branchTip(repo, head) === null || store.branchTip(repo, base) === null) {
          throw new FieldError(`Head ref ${head} or base ref ${base} does not exist`);
        }
        if (store.openPullFor(repo, head, base) !== null) throw new FieldError('A pull request already exists for this head and base');
        const pull = store.createPull(repo, String(input.title ?? ''), String(input.body ?? ''), head, base);
        if (pull === null) throw new FieldError('Could not create the pull request');
        return { __type: 'CreatePullRequestPayload', repo, pull } satisfies Wrapped;
      }
      case 'mergePullRequest': {
        const parsed = parseGlobalId(String(input.pullRequestId ?? ''));
        const found = parsed !== null && parsed.type === 'PullRequest' ? findPullById(store, Number(parsed.id)) : null;
        if (found === null) throw new FieldError('Could not resolve the pull request for mergePullRequest');
        const result = mergePull(store, found.repo, found.pull);
        if (!result.ok) throw new FieldError(result.reason === 'conflict' ? 'Pull Request is not mergeable' : 'Pull Request cannot be merged');
        return { __type: 'MergePullRequestPayload', ...found } satisfies Wrapped;
      }
      case 'addComment': {
        const parsed = parseGlobalId(String(input.subjectId ?? ''));
        const found = parsed !== null && parsed.type === 'Issue' ? findIssueById(store, Number(parsed.id)) : null;
        if (found === null) throw new FieldError('Could not resolve the subject for addComment');
        const comment = { id: store.nextCommentId(), body: String(input.body ?? ''), createdSeq: found.issue.comments.length + 1 };
        found.issue.comments.push(comment);
        return { __type: 'AddCommentPayload', ...found, comment } satisfies Wrapped;
      }
      default:
        return null;
    }
  }

  if (source === null) return null;

  switch (source.__type) {
    case 'User': {
      const viewer = store.viewer;
      switch (field.name) {
        case 'id':
          return globalId('User', viewer.id);
        case 'login':
          return viewer.login;
        case 'name':
          return viewer.name;
        case 'email':
          return viewer.email;
        case 'url':
          return `https://github.invalid/${viewer.login}`;
        default:
          return null;
      }
    }
    case 'Repository': {
      const repo = source.repo;
      switch (field.name) {
        case 'id':
          return globalId('Repository', repo.id);
        case 'databaseId':
          return repo.id;
        case 'name':
          return repo.name;
        case 'nameWithOwner':
          return `${repo.owner}/${repo.name}`;
        case 'owner':
          return { __type: 'User' } satisfies Wrapped;
        case 'description':
          return repo.description;
        case 'isPrivate':
          return repo.isPrivate;
        case 'viewerPermission':
          return 'ADMIN';
        case 'hasIssuesEnabled':
          return true;
        case 'hasPullRequestsEnabled':
          return true;
        case 'defaultBranchRef': {
          if (store.defaultTip(repo) === null) return null;
          return { __type: 'Ref', name: repo.defaultBranch } satisfies Wrapped;
        }
        case 'issue': {
          const issue = repo.issues.get(Number(args.get('number')));
          return issue === undefined ? null : ({ __type: 'Issue', repo, issue } satisfies Wrapped);
        }
        case 'issues': {
          let issues = [...repo.issues.values()];
          const states = args.get('states');
          if (Array.isArray(states)) {
            const wanted = states.map((state) => String(state).toLowerCase());
            issues = issues.filter((issue) => wanted.includes(issue.state));
          }
          const orderBy = args.get('orderBy') as { field?: string; direction?: string } | null;
          const descending = orderBy !== null && typeof orderBy === 'object' ? String(orderBy.direction ?? 'ASC') === 'DESC' : false;
          issues.sort((a, b) => (descending ? b.createdSeq - a.createdSeq : a.createdSeq - b.createdSeq));
          const paged = page(issues, args.get('first'), args.get('after'));
          return {
            __type: 'IssueConnection',
            items: paged.slice.map((issue) => ({ repo, issue })),
            total: paged.total,
            pageInfo: paged.pageInfo,
          } satisfies Wrapped;
        }
        case 'pullRequest': {
          const pull = repo.pulls.get(Number(args.get('number')));
          return pull === undefined ? null : ({ __type: 'PullRequest', repo, pull } satisfies Wrapped);
        }
        case 'pullRequests': {
          let pulls = [...repo.pulls.values()];
          const states = args.get('states');
          if (Array.isArray(states)) {
            const wanted = new Set(states.map((state) => String(state).toUpperCase()));
            pulls = pulls.filter((pull) => wanted.has(pull.merged ? 'MERGED' : pull.state.toUpperCase()));
          }
          pulls.sort((a, b) => b.createdSeq - a.createdSeq);
          const paged = page(pulls, args.get('first'), args.get('after'));
          return {
            __type: 'PullRequestConnection',
            items: paged.slice.map((pull) => ({ repo, pull })),
            total: paged.total,
            pageInfo: paged.pageInfo,
          } satisfies Wrapped;
        }
        case 'createdAt':
        case 'updatedAt':
          return iso(repo);
        case 'url':
          return `https://github.invalid/${repo.owner}/${repo.name}`;
        default:
          return null;
      }
    }
    case 'Ref':
      switch (field.name) {
        case 'name':
          return source.name;
        case 'prefix':
          return 'refs/heads/';
        default:
          return null;
      }
    case 'Issue': {
      const { repo, issue } = source;
      switch (field.name) {
        case 'id':
          return globalId('Issue', issue.id);
        case 'number':
          return issue.number;
        case 'title':
          return issue.title;
        case 'body':
          return issue.body;
        case 'state':
          return issue.state.toUpperCase();
        case 'author':
          return { __type: 'User' } satisfies Wrapped;
        case 'createdAt':
        case 'updatedAt':
          return iso(issue);
        case 'closedAt':
          return issue.state === 'closed' ? iso(issue) : null;
        case 'labels':
          return { __type: 'LabelConnection', repo, names: issue.labels } satisfies Wrapped;
        case 'comments':
          return { __type: 'IssueCommentConnection', repo, issue } satisfies Wrapped;
        case 'repository':
          return { __type: 'Repository', repo } satisfies Wrapped;
        case 'url':
          return `https://github.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`;
        default:
          return null;
      }
    }
    case 'PullRequest': {
      const { repo, pull } = source;
      switch (field.name) {
        case 'id':
          return globalId('PullRequest', pull.id);
        case 'number':
          return pull.number;
        case 'title':
          return pull.title;
        case 'body':
          return pull.body;
        case 'state':
          return pull.merged ? 'MERGED' : pull.state.toUpperCase();
        case 'merged':
          return pull.merged;
        case 'mergedAt':
          return pull.mergedAt;
        case 'mergeable': {
          if (pull.state !== 'open') return 'UNKNOWN';
          return pullMergeable(repo, pull) ? 'MERGEABLE' : 'CONFLICTING';
        }
        case 'headRefName':
          return pull.headRef;
        case 'baseRefName':
          return pull.baseRef;
        case 'files': {
          const files = pullFiles(repo, pull).map((file) => ({
            path: file.filename,
            additions: file.additions,
            deletions: file.deletions,
            changeType: file.status === 'added' ? 'ADDED' : file.status === 'removed' ? 'DELETED' : 'MODIFIED',
          }));
          const paged = page(files, args.get('first'), args.get('after'));
          return { __type: 'PullRequestFileConnection', files: paged.slice, pageInfo: paged.pageInfo } satisfies Wrapped;
        }
        case 'author':
          return { __type: 'User' } satisfies Wrapped;
        case 'createdAt':
        case 'updatedAt':
          return iso(pull);
        case 'repository':
          return { __type: 'Repository', repo } satisfies Wrapped;
        case 'url':
          return `https://github.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`;
        case 'additions':
          return pullFiles(repo, pull).reduce((sum, file) => sum + file.additions, 0);
        case 'deletions':
          return pullFiles(repo, pull).reduce((sum, file) => sum + file.deletions, 0);
        case 'changedFiles':
          return pullFiles(repo, pull).length;
        default:
          return null;
      }
    }
    case 'IssueConnection':
      switch (field.name) {
        case 'nodes':
          return source.items.map((item) => ({ __type: 'Issue', ...item }) satisfies Wrapped);
        case 'edges':
          return source.items.map((item, index) => ({ node: { __type: 'Issue', ...item }, cursor: cursorOf(index) }));
        case 'pageInfo':
          return { __type: 'PageInfo', pageInfo: source.pageInfo } satisfies Wrapped;
        case 'totalCount':
          return source.total;
        default:
          return null;
      }
    case 'PullRequestConnection':
      switch (field.name) {
        case 'nodes':
          return source.items.map((item) => ({ __type: 'PullRequest', ...item }) satisfies Wrapped);
        case 'edges':
          return source.items.map((item, index) => ({ node: { __type: 'PullRequest', ...item }, cursor: cursorOf(index) }));
        case 'pageInfo':
          return { __type: 'PageInfo', pageInfo: source.pageInfo } satisfies Wrapped;
        case 'totalCount':
          return source.total;
        default:
          return null;
      }
    case 'PullRequestFileConnection':
      switch (field.name) {
        case 'nodes':
          return source.files.map((file) => ({ __type: 'PullRequestFile', file }) satisfies Wrapped);
        case 'pageInfo':
          return { __type: 'PageInfo', pageInfo: source.pageInfo } satisfies Wrapped;
        case 'totalCount':
          return source.files.length;
        default:
          return null;
      }
    case 'PageInfo':
      return (source.pageInfo as unknown as Record<string, unknown>)[field.name] ?? null;
    case 'PullRequestFile':
      return (source.file as unknown as Record<string, unknown>)[field.name] ?? null;
    case 'Label': {
      const label = source.repo.labels.get(source.name);
      switch (field.name) {
        case 'id':
          return globalId('Label', label?.id ?? 0);
        case 'name':
          return source.name;
        case 'color':
          return label?.color ?? 'ededed';
        case 'description':
          return label?.description ?? '';
        default:
          return null;
      }
    }
    case 'LabelConnection':
      switch (field.name) {
        case 'nodes':
          return source.names.map((name) => ({ __type: 'Label', repo: source.repo, name }) satisfies Wrapped);
        case 'totalCount':
          return source.names.length;
        default:
          return null;
      }
    case 'IssueComment':
      switch (field.name) {
        case 'id':
          return globalId('IssueComment', source.comment.id);
        case 'body':
          return source.comment.body;
        case 'author':
          return { __type: 'User' } satisfies Wrapped;
        case 'createdAt':
        case 'updatedAt':
          return isoOf(baseEpochSec() + source.comment.createdSeq);
        default:
          return null;
      }
    case 'IssueCommentConnection':
      switch (field.name) {
        case 'nodes':
          return source.issue.comments.map((comment) => ({ __type: 'IssueComment', repo: source.repo, issue: source.issue, comment }) satisfies Wrapped);
        case 'totalCount':
          return source.issue.comments.length;
        default:
          return null;
      }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload':
      if (field.name === 'issue') return { __type: 'Issue', repo: source.repo, issue: source.issue } satisfies Wrapped;
      return null;
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload':
      if (field.name === 'pullRequest') return { __type: 'PullRequest', repo: source.repo, pull: source.pull } satisfies Wrapped;
      return null;
    case 'AddCommentPayload':
      if (field.name === 'commentEdge') return { __type: 'CommentEdge', repo: source.repo, issue: source.issue, comment: source.comment } satisfies Wrapped;
      if (field.name === 'subject') return { __type: 'Issue', repo: source.repo, issue: source.issue } satisfies Wrapped;
      return null;
    case 'CommentEdge':
      if (field.name === 'node') return { __type: 'IssueComment', repo: source.repo, issue: source.issue, comment: source.comment } satisfies Wrapped;
      if (field.name === 'cursor') return cursorOf(0);
      return null;
    case '__Type': {
      const name = source.name;
      switch (field.name) {
        case 'name':
          return name;
        case 'kind':
          if (ENUM_VALUES[name]) return 'ENUM';
          if (name === 'Node') return 'INTERFACE';
          return 'OBJECT';
        case 'description':
          return null;
        case 'fields': {
          const fields = OBJECT_FIELDS[name];
          if (!fields) return null;
          return fields.map((fieldName) => ({ __type: '__Field', name: fieldName }) satisfies Wrapped);
        }
        case 'enumValues': {
          const values = ENUM_VALUES[name];
          if (!values) return null;
          return values.map((valueName) => ({ __type: '__EnumValue', name: valueName }) satisfies Wrapped);
        }
        case 'possibleTypes':
          return name === 'Node' ? [...NODE_TYPES].map((typeName) => ({ __type: '__Type', name: typeName }) satisfies Wrapped) : null;
        case 'inputFields':
          return [];
        case 'interfaces':
          return [];
        case 'ofType':
          return null;
        default:
          return null;
      }
    }
    case '__Field':
      switch (field.name) {
        case 'name':
          return source.name;
        case 'description':
          return null;
        case 'isDeprecated':
          return false;
        case 'deprecationReason':
          return null;
        case 'args':
          return [];
        case 'type':
          return null;
        default:
          return null;
      }
    case '__EnumValue':
      switch (field.name) {
        case 'name':
          return source.name;
        case 'description':
          return null;
        case 'isDeprecated':
          return false;
        case 'deprecationReason':
          return null;
        default:
          return null;
      }
    case '__Schema':
      switch (field.name) {
        case 'types':
          return [...Object.keys(OBJECT_FIELDS), ...Object.keys(ENUM_VALUES)].map((name) => ({ __type: '__Type', name }) satisfies Wrapped);
        case 'queryType':
          return { __type: '__Type', name: 'Query' } satisfies Wrapped;
        case 'mutationType':
          return { __type: '__Type', name: 'Mutation' } satisfies Wrapped;
        case 'subscriptionType':
          return null;
        case 'directives':
          return [];
        default:
          return null;
      }
  }
  return null;
}

/** Expand spreads and filter inline fragments by the runtime type, yielding flat field nodes. */
function collectFields(ctx: Ctx, selections: Selection[], runtimeType: string, out: FieldNode[]): void {
  for (const selection of selections) {
    if (selection.kind === 'field') {
      out.push(selection.field);
    } else if (selection.kind === 'inline') {
      if (selection.typeCondition === null || selection.typeCondition === runtimeType) {
        collectFields(ctx, selection.selections, runtimeType, out);
      }
    } else {
      const fragment = ctx.document.fragments.get(selection.name);
      if (fragment && (fragment.typeCondition === null || fragment.typeCondition === runtimeType)) {
        collectFields(ctx, fragment.selections, runtimeType, out);
      }
    }
  }
}

function executeSelections(ctx: Ctx, source: Wrapped | null, typeName: string, selections: Selection[], path: Array<string | number>): Record<string, unknown> {
  const fields: FieldNode[] = [];
  collectFields(ctx, selections, typeName, fields);
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    const key = field.alias ?? field.name;
    const fieldPath = [...path, key];
    const knownFields = OBJECT_FIELDS[typeName];
    if (field.name !== '__typename' && knownFields !== undefined && !knownFields.includes(field.name)) {
      ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type '${typeName}'`, path: fieldPath });
      out[key] = null;
      continue;
    }
    let value: unknown;
    try {
      value = resolveField(ctx, source, typeName, field);
    } catch (err) {
      if (err instanceof FieldError) {
        ctx.errors.push({ message: err.message, path: fieldPath });
        out[key] = null;
        continue;
      }
      throw err;
    }
    out[key] = completeValue(ctx, value, typeName, field, fieldPath);
  }
  return out;
}

function completeValue(ctx: Ctx, value: unknown, parentType: string, field: FieldNode, path: Array<string | number>): unknown {
  if (value === null || value === undefined) return null;
  if (field.selections.length === 0) return value;
  const childType = FIELD_TYPES[parentType]?.[field.name];
  if (Array.isArray(value)) {
    return value.map((item, index) => completeValue(ctx, item, parentType, field, [...path, index]));
  }
  if (typeof value === 'object') {
    const wrapped = value as Wrapped & { node?: unknown; cursor?: unknown };
    if (wrapped.__type === undefined && 'node' in wrapped) {
      // A connection edge built inline: {node, cursor}.
      const edge: Record<string, unknown> = {};
      for (const sub of field.selections) {
        if (sub.kind !== 'field') continue;
        const subKey = sub.field.alias ?? sub.field.name;
        if (sub.field.name === 'node') edge[subKey] = completeValue(ctx, wrapped.node, parentType === 'IssueConnection' ? 'IssueEdge' : 'PullRequestEdge', sub.field, [...path, subKey]);
        else if (sub.field.name === 'cursor') edge[subKey] = wrapped.cursor;
      }
      return edge;
    }
    const runtimeType = (wrapped as Wrapped).__type;
    const typeForChildren = childType ?? runtimeType;
    return executeSelections(ctx, wrapped as Wrapped, typeForChildren === 'Node' ? runtimeType : typeForChildren, field.selections, path);
  }
  return value;
}

function executeOperation(store: Store, document: Document, operation: Operation, variables: Record<string, unknown>): { data: unknown; errors?: Array<{ message: string; path?: Array<string | number> }> } {
  const ctx: Ctx = { store, document, variables, errors: [] };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelections(ctx, null, rootType, operation.selections, []);
  return ctx.errors.length > 0 ? { data, errors: ctx.errors } : { data };
}

// --------------------------------------------------------------------------- the endpoint

export async function handleGraphQL(store: Store, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!isAuthed(req)) {
    sendJson(res, 401, { message: 'Bad credentials' });
    return;
  }
  const raw = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    sendJson(res, 400, { errors: [{ message: 'Request body is not valid JSON' }] });
    return;
  }
  const runOne = (entry: unknown): unknown => {
    const operation = (entry ?? {}) as { query?: unknown; variables?: unknown; operationName?: unknown };
    if (typeof operation.query !== 'string') {
      return { data: null, errors: [{ message: 'A query document is required' }] };
    }
    let document: Document;
    try {
      document = new Parser(tokenize(operation.query)).parseDocument();
    } catch (err) {
      return { data: null, errors: [{ message: err instanceof Error ? err.message : 'Syntax error' }] };
    }
    const variables = (typeof operation.variables === 'object' && operation.variables !== null ? operation.variables : {}) as Record<string, unknown>;
    const chosen =
      typeof operation.operationName === 'string'
        ? (document.operations.find((candidate) => candidate.name === operation.operationName) ?? document.operations[0])
        : document.operations[0];
    if (chosen === undefined) return { data: null, errors: [{ message: 'No operation in the document' }] };
    try {
      return executeOperation(store, document, chosen, variables);
    } catch (err) {
      return { data: null, errors: [{ message: err instanceof Error ? err.message : 'Internal error' }] };
    }
  };
  if (Array.isArray(parsed)) {
    sendJson(res, 200, parsed.map(runOne));
    return;
  }
  sendJson(res, 200, runOne(parsed));
}
