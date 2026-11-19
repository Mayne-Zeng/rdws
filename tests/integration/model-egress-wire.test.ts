import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer as httpsServer, request } from 'node:https';
import { createConnection, createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import { createSecureContext } from 'node:tls';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { tlsRecords } from '../fixtures/tls-egress-wire.ts';

const body = 'Synthetic model wire marker';
const path = '/v1/chat/completions';
const header = 'Synthetic wire authentication';
const plaintext = Buffer.from(
  [
    'POST ' + path + ' HTTP/1.1',
    'Host: 127.0.0.1',
    'Content-Length: ' + Buffer.byteLength(body),
    'Authorization: ' + header,
    'Connection: close',
    '',
    body,
  ].join('\r\n'),
);
const deadline = () => AbortSignal.timeout(5_000);
type Notice = { kind: string; sequence: number; bytes: number };

test('TLS fixture records preserve split and joined frames and reject malformed lengths or truncation', () => {
  const handshake = Buffer.from([22, 3, 3, 0, 2, 1, 2]);
  const payload = Buffer.from([23, 3, 3, 0, 3, 4, 5, 6]);
  const observed: Buffer[] = [];
  const records = tlsRecords((bytes) => observed.push(bytes));
  records.feed(handshake.subarray(0, 2));
  records.feed(handshake.subarray(2, 6));
  records.feed(Buffer.concat([handshake.subarray(6), payload]));
  records.finish();
  expect(observed).toEqual([handshake, payload]);
  const truncated = tlsRecords(() => {});
  truncated.feed(payload.subarray(0, -1));
  expect(() => truncated.finish()).toThrow('Truncated TLS fixture record');
  for (const input of [
    [24, 3, 3, 0, 1, 0],
    [23, 3, 3, 73, 0],
  ])
    expect(() => tlsRecords(() => {}).feed(Buffer.from(input))).toThrow(
      'Invalid TLS fixture record',
    );
});

async function listening(server: Server) {
  const waiting = once(server, 'listening', { signal: deadline() });
  server.listen(0, '127.0.0.1');
  await waiting;
  return (server.address() as { port: number }).port;
}

async function send(child: ChildProcess, kind: string, payload?: string) {
  await new Promise<void>((resolve, reject) => {
    child.send({ kind, request: payload }, (error) =>
      error ? reject(error) : resolve(),
    );
  });
}

function waitForExit(closed: Promise<unknown[]>, ms: number) {
  return Promise.race([
    closed,
    once(AbortSignal.timeout(ms), 'abort').then(() => {
      throw new Error('TLS fixture subprocess did not close');
    }),
  ]);
}

describe.skipIf(process.platform !== 'darwin')(
  'Node TLS supplier transport',
  () => {
    let root: string;
    let certificate: string;
    let key: Buffer;
    let cert: Buffer;
    beforeAll(async () => {
      const locked = (
        await readFile(new URL('../../.node-version', import.meta.url), 'utf8')
      ).trim();
      expect(process.version).toBe('v' + locked);
      root = await mkdtemp(join(tmpdir(), 'rdws-wire-tls-'));
      certificate = join(root, 'certificate.pem');
      const privateKey = join(root, 'key.pem');
      await promisify(execFile)(
        'openssl',
        [
          'req',
          '-x509',
          '-newkey',
          'rsa:2048',
          '-sha256',
          '-nodes',
          '-days',
          '1',
          '-subj',
          '/CN=fixture.invalid',
          '-addext',
          'subjectAltName=IP:127.0.0.1,DNS:fixture.invalid',
          '-keyout',
          privateKey,
          '-out',
          certificate,
        ],
        { timeout: 5_000 },
      );
      [key, cert] = await Promise.all([
        readFile(privateKey),
        readFile(certificate),
      ]);
    });
    afterAll(async () => {
      if (root) await rm(root, { recursive: true, force: true });
    });

    function supplier() {
      const decrypted: Buffer[] = [];
      const requests: {
        path?: string;
        authenticated: boolean;
        body: string;
      }[] = [];
      const server = httpsServer(
        {
          key,
          cert,
          minVersion: 'TLSv1.2',
          maxVersion: 'TLSv1.2',
        },
        (incoming, response) => {
          const parts: Buffer[] = [];
          incoming.on('data', (part) => parts.push(part));
          incoming.on('end', () => {
            requests.push({
              path: incoming.url,
              authenticated: incoming.headers.authorization === header,
              body: Buffer.concat(parts).toString(),
            });
            response.end('fixture response');
          });
        },
      );
      server.on('secureConnection', (socket) =>
        socket.on('data', (part) => decrypted.push(part)),
      );
      return { server, decrypted, requests };
    }

    test.each([
      'revoked',
      'zero',
      'partial',
      'full',
      'invalid-peer',
      'truncated',
    ] as const)(
      '%s at the actual encrypted application write',
      async (scenario) => {
        const { server, decrypted, requests } = supplier();
        const servers: Server[] = [server];
        const sockets = new Set<Duplex>();
        const ciphertext: Buffer[] = [];
        const notices: Notice[] = [];
        let child: ChildProcess | undefined;
        let childDone: Promise<unknown[]> | undefined;
        let observing = false;
        let delayed = true;
        let inputEnded = false;
        let supplierClosed = false;
        let acceptedCiphertext = 0;
        let release = () => {};
        let peerConnected = false;
        function track(socket: Duplex) {
          sockets.add(socket);
          socket.on('error', () => {});
          socket.once('close', () => sockets.delete(socket));
        }
        server.on('connection', (socket) => {
          track(socket);
          socket.once('close', () => {
            supplierClosed = true;
          });
        });
        try {
          const target = await listening(server);
          const tap = createServer((incoming) => {
            const outgoing = createConnection(target, '127.0.0.1');
            track(incoming);
            track(outgoing);
            outgoing.once('connect', () => {
              peerConnected = true;
            });
            outgoing.pipe(incoming);
            const held: Buffer[] = [];
            release = () => {
              delayed = false;
              for (const bytes of held) outgoing.write(bytes);
              held.length = 0;
              if (inputEnded) outgoing.end();
            };
            incoming.on('data', (bytes: Buffer) => {
              if (observing) ciphertext.push(bytes);
              if (observing && delayed) held.push(bytes);
              else outgoing.write(bytes);
            });
            incoming.on('end', () => {
              inputEnded = true;
              if (!observing || !delayed) outgoing.end();
            });
          });
          servers.push(tap);
          const port = await listening(tap);
          const connection = createConnection(port, '127.0.0.1');
          track(connection);
          await once(connection, 'connect', { signal: deadline() });
          connection.pause();
          const script = fileURLToPath(
            new URL('../fixtures/tls-egress-wire.ts', import.meta.url),
          );
          child = spawn(
            process.execPath,
            [
              script,
              certificate,
              scenario === 'invalid-peer' ? '127.0.0.2' : '127.0.0.1',
              scenario,
            ],
            {
              env: {},
              stdio: ['ignore', 'ignore', 'pipe', connection, 'ipc'],
            },
          );
          let diagnostics = '';
          child.stderr?.on('data', (bytes) => {
            diagnostics += bytes.toString();
          });
          child.on('message', (value) => notices.push(value as Notice));
          const started = child;
          childDone = new Promise((resolve) => {
            started.once('close', (code, signal) => resolve([code, signal]));
          });
          await once(child, 'spawn', { signal: deadline() });
          connection.destroy();
          await expect.poll(() => peerConnected).toBe(true);
          async function notice(kind: string) {
            await expect
              .poll(() => notices.map((value) => value.kind))
              .toContain(kind);
            return notices.find((candidate) => candidate.kind === kind)!;
          }
          if (scenario === 'invalid-peer') {
            await notice('invalid-peer');
            expect(notices.map(({ kind }) => kind)).toEqual(['invalid-peer']);
          } else if (scenario === 'truncated') {
            await notice('ready');
            observing = true;
            await send(child, 'prepare', plaintext.toString());
            await notice('invalid-record');
            expect(notices.map(({ kind }) => kind)).toEqual([
              'ready',
              'invalid-record',
            ]);
          } else {
            await notice('ready');
            observing = true;
            await send(child, 'prepare', plaintext.toString());
            const prepared = await notice('prepared');
            expect(prepared.bytes).toBeGreaterThan(plaintext.length);
            expect(ciphertext).toEqual([]);

            if (scenario === 'full' || scenario === 'partial') {
              await send(child, scenario === 'full' ? 'submit' : 'partial');
              const terminal = await notice(scenario);
              const first = await notice('first');
              acceptedCiphertext = first.bytes;
              expect(first.sequence).toBeLessThan(terminal.sequence);
              expect(first.bytes).toBe(terminal.bytes);
              const captured = () => Buffer.concat(ciphertext);
              await expect.poll(() => captured().length).toBe(terminal.bytes);
              expect(captured()[0]).toBe(23);
              expect(captured().readUInt16BE(3) + 5).toBe(prepared.bytes);
              expect(decrypted).toEqual([]);
              expect(requests).toEqual([]);
              if (scenario === 'full') {
                expect(first.bytes).toBe(prepared.bytes);
                await send(child, 'revoke');
                expect((await notice('revoked')).sequence).toBeGreaterThan(
                  terminal.sequence,
                );
                release();
                await expect.poll(() => requests.length).toBe(1);
                expect(requests).toEqual([{ path, authenticated: true, body }]);
                expect(Buffer.concat(decrypted)).toEqual(plaintext);
                await send(child, 'close');
              } else {
                expect(first.bytes).toBe(prepared.bytes - 8);
                expect(notices.map(({ kind }) => kind)).toEqual([
                  'ready',
                  'prepared',
                  'first',
                  'partial',
                ]);
              }
            } else {
              if (scenario === 'zero') {
                await send(child, 'zero');
                expect((await notice('zero')).bytes).toBe(0);
                expect(ciphertext).toEqual([]);
              }
              await send(child, 'revoke');
              const revoked = await notice('revoked');
              await send(child, 'submit');
              expect((await notice('denied')).sequence).toBeGreaterThan(
                revoked.sequence,
              );
              expect(
                notices.some(({ kind }) => kind === 'first' || kind === 'full'),
              ).toBe(false);
            }
          }
          expect(await waitForExit(childDone, 5_000), diagnostics).toEqual([
            0,
            null,
          ]);
          await expect.poll(() => inputEnded).toBe(true);
          release();
          await expect.poll(() => supplierClosed).toBe(true);
          expect(Buffer.concat(ciphertext)).toHaveLength(acceptedCiphertext);
          if (scenario === 'full') {
            expect(requests).toEqual([{ path, authenticated: true, body }]);
            expect(Buffer.concat(decrypted)).toEqual(plaintext);
          } else {
            expect(decrypted).toEqual([]);
            expect(requests).toEqual([]);
          }
        } finally {
          for (const socket of sockets) socket.destroy();
          try {
            if (child && childDone) {
              if (child.exitCode === null && child.signalCode === null)
                child.kill();
              try {
                await waitForExit(childDone, 2_000);
              } catch {
                child.kill('SIGKILL');
                await waitForExit(childDone, 2_000);
              }
            }
          } finally {
            await Promise.all(
              servers.map(
                (server) =>
                  new Promise<void>((resolve) => server.close(() => resolve())),
              ),
            );
          }
        }
      },
    );

    test('ending an HTTPS request before handshake queues bytes across the revocation checkpoint', async () => {
      const checkpoints: string[] = [];
      const context = createSecureContext({ key, cert });
      let completeHandshake: (() => void) | undefined;
      const server = httpsServer(
        {
          key,
          cert,
          SNICallback(_servername, reply) {
            completeHandshake = () => reply(null, context);
          },
        },
        (incoming, response) => {
          checkpoints.push('supplier-request');
          incoming.resume();
          incoming.on('end', () => response.end('fixture response'));
        },
      );
      const sockets = new Set<Duplex>();
      server.on('connection', (socket) => {
        sockets.add(socket);
        socket.once('close', () => sockets.delete(socket));
      });
      try {
        const port = await listening(server);
        const received = new Promise<void>((resolve, reject) => {
          const outgoing = request(
            {
              hostname: '127.0.0.1',
              servername: 'fixture.invalid',
              port,
              method: 'POST',
              path,
              ca: cert,
              agent: false,
              rejectUnauthorized: true,
              signal: deadline(),
            },
            (response) => {
              response.resume();
              response.once('end', resolve);
              response.once('error', reject);
            },
          );
          outgoing.once('error', reject);
          outgoing.end(body);
          checkpoints.push('queued');
        });
        void received.catch(() => {});
        await expect.poll(() => Boolean(completeHandshake)).toBe(true);
        expect(checkpoints).toEqual(['queued']);
        checkpoints.push('revoked');
        completeHandshake!();
        await received;
        expect(checkpoints).toEqual(['queued', 'revoked', 'supplier-request']);
      } finally {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  },
);
