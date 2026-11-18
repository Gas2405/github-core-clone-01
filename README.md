# github-core-clone

![github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)
![rank](https://make.fun/badge/github-core-clone-01/Gas2405/github-core-clone-01/rank.svg)
![reward](https://make.fun/badge/github-core-clone-01/Gas2405/github-core-clone-01/reward.svg)

A GitHub-compatible git forge in a single dependency-free Node 22 process, built for
[the github-core-clone-01 bounty](https://make.fun/bounty/github-core-clone-01) on
[make.fun](https://make.fun/r/9v18ghw6). No `git` binary, no packages, no outside service:
git object storage, packfile read/write, refs and the smart-HTTP protocol are implemented
from scratch on the Node standard library, and one in-memory store backs all four surfaces,
so an object created over one surface reads back identically over the others.

## Run it

```sh
node main.ts
```

The platform runs `node /bot/main.ts` on Node 22, which strips TypeScript types on its own.
There is nothing to install: the program imports `node:http`, `node:crypto`, `node:zlib` and
its own modules only, and the trial has no package manager and no internet.

## The lifecycle (main.ts)

The env is a server the harness starts beside yours. Its origin is in `MAKEFUN_ENV_URL`
(`http://store:8080` in a trial).

1. **Bind an ephemeral port.** `server.listen(0)` lets the kernel pick one; read it with
   `server.address().port`. Never bind 8080: that is the env's port.
2. **Register.** `POST $MAKEFUN_ENV_URL/register` with `{"port": <the port you bound>}`, as
   JSON. The first register wins: a later one is answered `409`.
3. **Wait for done.** `GET $MAKEFUN_ENV_URL/done` answers at once with `{"done":false}` while
   the suite runs and `{"done":true}` once its export is written. Poll it with a short
   backoff; never exit before it says `true`.
4. **Exit 0** when it does.

## The surface

| Route | What it is |
| --- | --- |
| `GET /healthz` | 200 `{"ok":true}`: the env's boot probe |
| `GET /api/v3/` | 200, `X-OAuth-Scopes: repo, read:org`, a JSON API root |
| `/api/v3/...` | GitHub REST v3: repositories, branches, commits, contents, git refs, issues, comments, labels, pull requests, files, squash merges |
| `POST /api/graphql` | GitHub GraphQL v4: viewer, repository, issues, pull requests, search-type introspection, `node(id:)`, and the create/close/merge/comment mutations |
| `POST /mcp` | Model Context Protocol over streamable HTTP: `server/discover`, `initialize`, `tools/list`, `tools/call` with `create_repo`, `get_repo`, `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request` |
| `/<owner>/<repo>.git/...` | git smart HTTP: `info/refs`, `git-upload-pack` (protocol v2 `ls-refs` and `fetch`, v0 fetch, shallow and incremental fetches), `git-receive-pack` (create, fast-forward, delete, non-fast-forward refusal with `report-status`) |
| anything else | 404 `{"message":"Not Found"}` |

Every REST reply is `application/json` with a non-empty `X-GitHub-Request-Id`; errors are JSON
with a string `message`. API calls carry `Authorization: Bearer $MAKEFUN_SHOP_TOKEN`; a missing
token is refused with 401. A repository belongs to the token's login: the same name under
another owner is a 404, never a 403. All state is deterministic — timestamps derive from
`MAKEFUN_TRIAL_NOW` and ids from sequence counters — so a replayed trial exports identically.

## Layout

- `main.ts`: the lifecycle above. Kept as the starter wrote it.
- `app.ts`: the HTTP server and router.
- `store.ts`: the in-memory store and the git object model (hashing, trees, ancestry, merge base).
- `git.ts`: pkt-lines, packfile read/write, ref advertisement, fetch planning, receive-pack.
- `rest.ts`: the REST v3 resources.
- `graphql.ts`: the GraphQL v4 subset (parser, executor, introspection).
- `mcp.ts`: the MCP endpoint.
- `ops.ts`: operations shared by REST, GraphQL and MCP (contents writes, PR files, squash merge).
- `http.ts`, `scenario.ts`: shared HTTP helpers and the deterministic trial identities.

## Rules and limits

The rules, the scoring weights, the deadline and the prizes are on the contest page:
**https://make.fun/bounty/github-core-clone-01**. In short: Node 22 only, no dependencies at
run time, no internet and no `git` binary in the trial; the repository is mounted read-only at
`/bot`. The trial's wall budget is 900 seconds.

Entered by [Gas2405](https://make.fun/r/9v18ghw6) via [make.fun](https://make.fun/r/9v18ghw6).

## Licence

MIT — see `LICENSE`.
