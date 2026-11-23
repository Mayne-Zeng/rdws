import { Duplex } from 'node:stream';
import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import {
  firstWriteLimit,
  modelSocketDescriptor,
  submitModelPrefix,
  type ModelWireOutcome,
} from '@rdws/dsh/host/model-wire';
import { WindowSealed, type WindowWitness } from './failure-boundary-window.ts';

// §11.20.25 T07 read loopback outbound carrier: one TLS 1.3 connection per
// delivery attempt. The fixed-header request with the page body is captured
// as complete TLS application records before the window opens, and the
// window's arming callback submits the first-write prefix (at most
// firstWriteLimit bytes, the §11.16.47 prefix/remainder split) to the kernel
// with a synchronous write; the remainder follows on the same connection only
// after the certificate. Nothing is written before arming; after a lost
// certificate the captured records are discarded without retry.

export type PreparedReadFrame = {
  // Synchronous arming callback for the checked authorization window.
  arm: () => WindowWitness;
  // Post-certificate remainder delivery; resolves only when the whole frame
  // is on the wire, after which the connection is released (the kernel keeps
  // flushing the accepted bytes; the supplier response is never consumed).
  finish: () => Promise<void>;
  // Sealed/zero-write discard: destroys the connection, never writes.
  abort: () => void;
};

export type WindowedReadEgressStats = {
  connections: number;
  armed: number;
  acceptedBytes: number;
  discarded: number;
  // Sockets still open under this egress (released on finish/abort/close).
  live: number;
};

export function createWindowedReadEgress(options: {
  destination: string;
  ca: string;
  header: string;
}) {
  const endpoint = new URL(options.destination);
  if (endpoint.protocol !== 'https:' || !endpoint.hostname)
    throw new Error('Windowed read egress requires an HTTPS supplier');
  const sockets = new Set<Socket>();
  const stats = {
    connections: 0,
    armed: 0,
    acceptedBytes: 0,
    discarded: 0,
  };
  let closing = false;

  function request(attemptId: string, body: Buffer) {
    return Buffer.from(
      [
        'POST ' + endpoint.pathname + ' HTTP/1.1',
        'Host: ' + endpoint.host,
        'Content-Length: ' + body.length,
        'X-Rdws-Window-Attempt: ' + attemptId,
        'Authorization: ' + options.header,
        'Connection: close',
        '',
        '',
      ].join('\r\n'),
    );
  }

  async function frame(input: {
    attemptId: string;
    body: Buffer;
  }): Promise<PreparedReadFrame> {
    if (closing) throw new Error('Windowed read egress is closed');
    const plaintext = Buffer.concat([
      request(input.attemptId, input.body),
      input.body,
    ]);
    const host = endpoint.hostname;
    const port = Number(endpoint.port || 443);
    const raw = netConnect({ host, port });
    sockets.add(raw);
    const remove = () => sockets.delete(raw);
    raw.once('close', remove);
    stats.connections++;
    let captured: Buffer[] = [];
    let length = 0;
    let capturing = false;
    const bridge = new Duplex({
      read() {
        raw.resume();
      },
      write(chunk: Buffer, _encoding, done) {
        // The TLS handshake flows to the supplier; only application records
        // written after the barrier are captured in memory for the window.
        if (!capturing) {
          raw.write(chunk, done);
          return;
        }
        captured.push(Buffer.from(chunk));
        length += chunk.length;
        done();
      },
      destroy(error, done) {
        raw.destroy();
        done(error);
      },
    });
    bridge.on('error', () => {});
    raw.on('error', () => {});
    raw.on('data', (chunk: Buffer) => {
      if (!bridge.push(chunk)) raw.pause();
    });
    raw.on('end', () => bridge.push(null));
    raw.on('close', () => {
      if (!raw.readableEnded) bridge.destroy();
    });
    const tls = tlsConnect({
      socket: bridge,
      host,
      ca: options.ca,
      minVersion: 'TLSv1.3',
      maxVersion: 'TLSv1.3',
      ALPNProtocols: ['http/1.1'],
      rejectUnauthorized: true,
    });
    tls.on('error', () => {});
    const failure = new Promise<never>((_, reject) => {
      const fail = () =>
        reject(new Error('Windowed read supplier is unreachable'));
      tls.once('error', fail);
      raw.once('close', () => {
        if (!tls.authorized) fail();
      });
    });
    const handshake = (async () => {
      await new Promise<void>((resolve, reject) => {
        tls.once('secureConnect', () => resolve());
        failure.catch(reject);
      });
      if (!tls.authorized || tls.getProtocol() !== 'TLSv1.3')
        throw new Error('Windowed read supplier TLS is not TLS 1.3');
      raw.pause();
      // Barrier: every pending handshake record has been flushed to the wire.
      await new Promise<void>((resolve, reject) => {
        tls.write(Buffer.alloc(0), (error) =>
          error ? reject(error) : resolve(),
        );
      });
      const fd = modelSocketDescriptor(raw);
      if (fd === undefined)
        throw new Error('Windowed read socket is not armed');
      if (capturing) throw new Error('Windowed read capture already sealed');
      capturing = true;
      await new Promise<void>((resolve, reject) => {
        tls.write(plaintext, (error) => (error ? reject(error) : resolve()));
      });
      return { tls, raw, fd };
    })();
    const connected = (async () => {
      try {
        return await handshake;
      } catch (error) {
        tls.destroy();
        raw.destroy();
        throw error;
      }
    })();
    const state = await Promise.race([connected, failure]);
    const records = Buffer.concat(captured, length);
    captured = [];
    length = 0;
    if (records.length === 0) {
      state.tls.destroy();
      state.raw.destroy();
      throw new Error('Windowed read frame capture is empty');
    }
    // §11.16.47 prefix/remainder: only the first-write prefix sits inside the
    // window's atomic segment. A full 16 KiB page plus its request header and
    // TLS record overhead exceeds the first-write limit, so the rest of the
    // captured records follow after the certificate.
    const prefix = records.subarray(
      0,
      Math.min(records.length, firstWriteLimit),
    );
    const remainder = records.subarray(prefix.length);
    let outcome: ModelWireOutcome | undefined;
    const prepared: PreparedReadFrame = {
      arm: () => {
        if (outcome !== undefined)
          throw new Error('Windowed read frame was already armed');
        const descriptor = modelSocketDescriptor(state.raw);
        outcome =
          descriptor === state.fd
            ? submitModelPrefix(
                state.raw,
                state.fd,
                prefix,
                Number.MAX_SAFE_INTEGER,
              )
            : 'not-sent';
        // 'submitted' is the only outcome that proves bytes reached the
        // kernel; 'not-sent' (and a descriptor mismatch) are provable
        // zero-byte deliveries; 'indeterminate' (partial write or a non-EAGAIN
        // writeSync failure) leaves coverage in doubt and is surfaced as a
        // seal to the window instead of folding into a zero-write.
        if (outcome === 'indeterminate')
          throw new WindowSealed('certificate-lost');
        if (outcome === 'submitted') {
          stats.armed++;
          stats.acceptedBytes += prefix.length;
        }
        return {
          acceptedBytes: outcome === 'submitted' ? prefix.length : 0,
          witnessedAt: Date.now(),
          wire: outcome,
        };
      },
      finish: async () => {
        if (outcome !== 'submitted')
          throw new Error('Windowed read delivery was not accepted');
        if (state.raw.destroyed || state.raw.readyState !== 'open')
          throw new Error('Windowed read supplier connection was lost');
        // Frames within the first-write limit carry no remainder; longer
        // frames deliver the remainder on the same TLS connection after the
        // certificate (§11.16.47 remainder semantics, never re-armed). The
        // connection is released once the whole frame is on the wire: the
        // kernel keeps flushing the accepted bytes and nothing here reads the
        // supplier response.
        if (remainder.length)
          await new Promise<void>((resolve, reject) => {
            state.raw.write(remainder, (error) =>
              error ? reject(error) : resolve(),
            );
          });
        state.tls.destroy();
        state.raw.destroy();
      },
      abort: () => {
        stats.discarded++;
        state.tls.destroy();
        state.raw.destroy();
      },
    };
    return prepared;
  }

  return {
    frame,
    stats: (): WindowedReadEgressStats => ({
      ...stats,
      live: sockets.size,
    }),
    async close() {
      closing = true;
      for (const socket of sockets) socket.destroy();
    },
  };
}

export type WindowedReadEgress = ReturnType<typeof createWindowedReadEgress>;
