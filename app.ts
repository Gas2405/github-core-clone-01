// The forge server: one HTTP server routing the four surfaces onto one shared store —
// git smart HTTP at /{owner}/{repo}.git, REST v3 under /api/v3, GraphQL at /api/graphql and
// MCP at /mcp. main.ts owns the register/done lifecycle; this file only builds the server.
//
// Every handler is wrapped so a malformed request (a garbage pkt-line body, a truncated
// pack) answers an error instead of crashing the process: a crashed entry scores zero.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { infoRefs, receivePack, uploadPack } from './git.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { readBody, sendJson } from './http.ts';

const GIT_PATH = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;

function gitProtocolHeader(req: IncomingMessage): string {
  const header = req.headers['git-protocol'];
  return typeof header === 'string' ? header : '';
}

function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

function sendResult(res: ServerResponse, result: { status: number; contentType: string; body: Buffer }): void {
  sendBuffer(res, result.status, result.contentType, result.body);
}

async function handleGit(store: Store, req: IncomingMessage, res: ServerResponse, match: RegExpMatchArray, url: URL): Promise<void> {
  const owner = decodeURIComponent(match[1]);
  const name = decodeURIComponent(match[2]);
  const tail = match[3];
  const repo = store.getRepo(owner, name);
  if (tail === 'info/refs') {
    if (req.method !== 'GET') {
      sendBuffer(res, 405, 'text/plain; charset=utf-8', Buffer.from('method not allowed\n'));
      return;
    }
    const service = url.searchParams.get('service') ?? '';
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      sendBuffer(res, 400, 'text/plain; charset=utf-8', Buffer.from('missing or unknown service\n'));
      return;
    }
    sendResult(res, infoRefs(repo, service, gitProtocolHeader(req)));
    return;
  }
  if (req.method !== 'POST') {
    sendBuffer(res, 405, 'text/plain; charset=utf-8', Buffer.from('method not allowed\n'));
    return;
  }
  const body = await readBody(req);
  if (tail === 'git-upload-pack') {
    sendResult(res, uploadPack(repo, body));
    return;
  }
  sendResult(res, receivePack(repo, body));
}

async function route(store: Store, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://forge.invalid');
  const path = url.pathname;

  if (path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }
  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    await handleRest(store, req, res, url);
    return;
  }
  if (path === '/api/graphql') {
    await handleGraphQL(store, req, res);
    return;
  }
  if (path === '/mcp') {
    await handleMcp(store, req, res);
    return;
  }
  const gitMatch = path.match(GIT_PATH);
  if (gitMatch !== null) {
    await handleGit(store, req, res, gitMatch, url);
    return;
  }
  sendJson(res, 404, { message: 'Not Found' });
}

export function createApp(): Server {
  const store = new Store();
  const server = createServer((req, res) => {
    route(store, req, res).catch((err: unknown) => {
      // Containment: log to stderr, answer a plain error, keep serving.
      process.stderr.write(`[forge] request failed: ${err instanceof Error ? err.message : String(err)}\n`);
      try {
        if (!res.headersSent) {
          const path = (req.url ?? '').split('?')[0];
          if (path.endsWith('.git/git-upload-pack') || path.endsWith('.git/git-receive-pack') || path.endsWith('.git/info/refs')) {
            sendBuffer(res, 400, 'text/plain; charset=utf-8', Buffer.from('bad request\n'));
          } else {
            sendJson(res, 400, { message: 'Bad Request' });
          }
        }
        if (!res.writableEnded) res.end();
      } catch {
        // The socket is already gone; nothing more to do.
      }
    });
  });
  server.on('clientError', (_err, socket) => {
    socket.destroy();
  });
  return server;
}
