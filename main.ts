// Boot driver for the forge — this file owns the trial lifecycle and nothing else.
//
// The suite's harness starts beside this process and waits to be told where the
// forge lives, so the sequence here is fixed by that conversation:
//   1. build the application server (app.ts) and bind it to a kernel-chosen
//      port — port 0, never 8080, which belongs to the suite itself;
//   2. announce the chosen port with a POST to $MAKEFUN_ENV_URL/register;
//   3. keep serving while long-polling $MAKEFUN_ENV_URL/done;
//   4. when the harness answers that it is done, close the server and exit 0.
//
// All request handling lives behind createApp(); nothing about the four
// surfaces (git smart HTTP, REST, GraphQL, MCP) is decided in this file.

import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from './app.ts';

// How long to wait between /done polls and between register retries. The
// harness thinks in seconds, so a quarter second keeps the exit prompt
// without busy-spinning for the length of a trial.
const POLL_INTERVAL_MS = 250;

// The harness is started beside us, but "beside" is not "first": give the
// register call a grace window of retries before concluding it is absent.
const REGISTER_ATTEMPTS = 40;

// No single harness call may hang: a peer that accepts the connection and
// then never answers would otherwise stall the retry loop (or the done
// poll) well past the boot budget instead of being retried.
const HARNESS_CALL_TIMEOUT_MS = 5000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function harnessBase(): string {
  const raw = process.env.MAKEFUN_ENV_URL;
  if (raw === undefined || raw.trim() === '') {
    throw new Error('MAKEFUN_ENV_URL is not set; nowhere to register');
  }
  // Join paths by hand below, so drop any trailing slash once, here.
  return raw.replace(/\/+$/, '');
}

async function announcePort(base: string, port: number): Promise<void> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= REGISTER_ATTEMPTS; attempt += 1) {
    try {
      const reply = await fetch(`${base}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(HARNESS_CALL_TIMEOUT_MS),
      });
      if (reply.ok) return;
      lastError = new Error(`register answered HTTP ${reply.status}`);
    } catch (err) {
      lastError = err;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw lastError instanceof Error ? lastError : new Error('register never succeeded');
}

async function awaitHarnessDone(base: string): Promise<void> {
  for (;;) {
    try {
      const reply = await fetch(`${base}/done`, {
        signal: AbortSignal.timeout(HARNESS_CALL_TIMEOUT_MS),
      });
      if (reply.ok) {
        const state = (await reply.json()) as { done?: unknown };
        if (state.done === true) return;
      }
    } catch {
      // A dropped poll is not the end of the trial; the harness may still be
      // writing its export. Fall through and ask again after the interval.
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

function bindEphemeral(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => {
      server.removeListener('error', reject);
      const address = server.address() as AddressInfo;
      resolve(address.port);
    });
  });
}

async function shutdown(server: Server): Promise<void> {
  // The harness has finished, so no client is owed a graceful drain: force
  // any lingering keep-alive sockets shut and let close() settle at once.
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function run(): Promise<void> {
  const base = harnessBase();
  const server = createApp();
  const port = await bindEphemeral(server);
  process.stderr.write(`[forge] listening on port ${port}\n`);
  await announcePort(base, port);
  process.stderr.write('[forge] registered with the harness; serving until done\n');
  await awaitHarnessDone(base);
  await shutdown(server);
  process.stderr.write('[forge] harness done; exiting\n');
}

run().then(
  () => {
    process.exit(0);
  },
  (err: unknown) => {
    process.stderr.write(`[forge] fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);
