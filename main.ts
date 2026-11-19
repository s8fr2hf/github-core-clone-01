// main.ts — the harness lifecycle for this entry.
//
// The scoring suite talks to the forge through the harness environment, and
// this file is the only thing that connects the two. The forge itself lives
// in app.ts; all this file does is:
//
//   * read MAKEFUN_ENV_URL, the origin of the environment (in a trial
//     container that is something like http://store:8080). No URL, no
//     environment to talk to, so the process gives up immediately.
//   * start the forge on a port the kernel picks (listen(0)). Port 8080
//     belongs to the environment and must never be bound here.
//   * tell the environment which port was picked, with a POST to
//     /register. From then on the environment reaches the forge at the
//     address that request came from, plus that port. If some other entry
//     already claimed the slot the environment answers 409, and that is
//     fine — this process simply waits its turn like any other.
//   * ask GET /done over and over until the environment answers
//     {"done": true}. The answer comes back at once either way, so the
//     loop is a plain poll. A poll that fails or times out is not a
//     reason to quit; it is retried with a growing delay.
//   * shut the server down and exit 0 once the environment says done.
//     The harness then stops the environment, which writes out the
//     export the scorer reads.
//
// Nothing here touches MAKEFUN_SHOP_TOKEN: the forge in app.ts reads it
// itself and checks bearer tokens against it. This file imports the
// forge and nothing else.

import { createApp } from './app.ts';

const envOrigin = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (envOrigin === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

// One HTTP round trip gets thirty seconds before it is abandoned.
const FETCH_TIMEOUT_MS = 30_000;
// Retries start a quarter of a second apart and never wait longer than
// two seconds; the doubling stops growing after eight failures.
const FIRST_BACKOFF_MS = 250;
const MAX_BACKOFF_MS = 2_000;

function pause(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

// Delay before retry number `failures` (counting from zero): double the
// previous delay each time, capped at MAX_BACKOFF_MS.
function backoffMs(failures: number): number {
  let delay = FIRST_BACKOFF_MS;
  for (let step = 0; step < Math.min(failures, 8); step += 1) delay *= 2;
  return Math.min(delay, MAX_BACKOFF_MS);
}

// Tell the environment the port the forge is listening on. 200 means it
// accepted the registration; 409 means another entry got there first, and
// there is nothing to fix, so that counts as done too. 400 and 405 mean
// the request itself broke the contract, so the process dies instead of
// retrying forever. Anything else — a refused connection, a timeout, an
// unexpected status — is retried, because the environment may still be
// coming up.
async function announcePort(port: number): Promise<void> {
  let failures = 0;
  while (true) {
    try {
      const response = await fetch(`${envOrigin}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (response.status === 200 || response.status === 409) return;
      if (response.status === 400 || response.status === 405) {
        throw new Error(`register answered HTTP ${response.status}: ${await response.text()}`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('register answered HTTP ')) throw error;
    }
    await pause(backoffMs(failures));
    failures += 1;
  }
}

// Keep asking the environment whether the trial is over. Only a 200
// response whose body says done ends the wait; anything else — a
// non-200, a body that is not done yet, a failed request — means poll
// again after a short delay.
async function awaitDone(): Promise<void> {
  let failures = 0;
  while (true) {
    try {
      const response = await fetch(`${envOrigin}/done`, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (response.ok) {
        const payload = (await response.json()) as { done?: unknown };
        if (payload.done === true) return;
      }
    } catch {
      // The environment is not answering, or the request timed out.
      // That only means the trial is not over yet.
    }
    await pause(backoffMs(failures));
    failures += 1;
  }
}

// Start the forge on an ephemeral port and resolve with the port number.
function listenOnEphemeralPort(server: ReturnType<typeof createApp>): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => {
      const bound = server.address();
      if (bound === null || typeof bound === 'string') {
        reject(new Error('the server did not bind an ephemeral TCP port'));
        return;
      }
      resolve(bound.port);
    });
  });
}

async function boot(): Promise<void> {
  const server = createApp();
  const port = await listenOnEphemeralPort(server);
  process.stdout.write(`[entry] listening on port ${port}\n`);

  await announcePort(port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await awaitDone();
  server.close();
  process.stdout.write('[entry] done\n');
}

boot()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    process.stderr.write(`[entry] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
