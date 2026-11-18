// Small HTTP helpers shared by the REST, GraphQL and MCP surfaces: JSON replies, request bodies,
// bearer-token auth, and the opaque global ids GraphQL round-trips.

import type { IncomingMessage, ServerResponse } from 'node:http';

export const JSON_TYPE = 'application/json; charset=utf-8';

/** Answer with a JSON body (or no body at all for 204). */
export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  if (status === 204) {
    res.writeHead(204, headers);
    res.end();
    return;
  }
  const text = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

/** Read a whole request body. */
export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** The bearer <redacted> of a request, from `Bearer <t>` or `token <t>`; null when absent. */
export function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^(?:Bearer|token)\s+(.+)$/i.exec(header.trim());
  return match ? (match[1] as string) : null;
}

/**
 * Whether the request carries the trial's token. When MAKEFUN_SHOP_TOKEN is unset (a local run)
 * any presented token is accepted; a missing token never is.
 */
export function isAuthed(req: IncomingMessage): boolean {
  const token = bearerToken(req);
  if (token === null || token === '') return false;
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  return expected === '' || token === expected;
}

/** An opaque, stable global id for a stored object, in GitHub's base64 style. */
export function globalId(type: string, id: number | string): string {
  return Buffer.from(`${type}:${id}`, 'utf8').toString('base64');
}

/** Decode a global id back to its type and local id; null when it is not one of ours. */
export function parseGlobalId(value: string): { type: string; id: string } | null {
  try {
    const text = Buffer.from(value, 'base64').toString('utf8');
    const index = text.indexOf(':');
    if (index < 1) return null;
    return { type: text.slice(0, index), id: text.slice(index + 1) };
  } catch {
    return null;
  }
}

/** The public base URL of this server as the client addressed it (for Link headers). */
export function baseUrlOf(req: IncomingMessage): string {
  const host = req.headers.host;
  return host ? `http://${host}` : 'http://localhost';
}
