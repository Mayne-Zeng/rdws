import { createServer as httpsServer } from 'node:https';
import { readFileSync } from 'node:fs';
import type { Socket } from 'node:net';

// Isolated loopback HTTPS supplier for the §11.20.25 windowed read assembly.
// Runs as a separate process so the test can freeze (SIGSTOP) or kill it to
// inject the silent peer-disappearance phase; every accepted plaintext body
// is reported over IPC for independent counting.

const [keyPath, certPath] = process.argv.slice(2);
let pending = 0;
const server = httpsServer(
  {
    key: readFileSync(keyPath!),
    cert: readFileSync(certPath!),
    minVersion: 'TLSv1.3',
    maxVersion: 'TLSv1.3',
  },
  (incoming, response) => {
    const parts: Buffer[] = [];
    incoming.on('data', (part) => parts.push(part));
    incoming.on('end', () => {
      const body = Buffer.concat(parts);
      const attempt = String(incoming.headers['x-rdws-window-attempt'] ?? '');
      if (pending > 0) {
        pending--;
        process.send!({ kind: 'reset', attempt, bytes: body.length });
        (response.socket as Socket).resetAndDestroy?.();
        return;
      }
      process.send!({
        kind: 'request',
        attempt,
        bytes: body.length,
        path: incoming.url,
      });
      response.end('window-supplier-ok');
    });
  },
);
process.on('message', (input: { kind: string }) => {
  if (input.kind === 'rst-once') pending++;
});
server.listen(0, '127.0.0.1', () => {
  const { port } = server.address() as { port: number };
  process.send!({ kind: 'ready', port });
});
