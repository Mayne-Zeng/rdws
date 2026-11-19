import assert from 'node:assert/strict';
import { readFileSync, writeSync } from 'node:fs';
import { Socket } from 'node:net';
import { Duplex } from 'node:stream';
import { connect } from 'node:tls';

const applicationData = 23;
const maxRecordBytes = 18_432;

export function tlsRecords(record: (bytes: Buffer) => void) {
  let pending: Buffer = Buffer.alloc(0);
  return {
    feed(chunk: Buffer) {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      while (pending.length >= 5) {
        const type = pending[0]!;
        const length = pending.readUInt16BE(3);
        assert(
          type >= 20 &&
            type <= applicationData &&
            pending[1] === 3 &&
            pending[2]! >= 1 &&
            pending[2]! <= 3 &&
            length > 0 &&
            length <= maxRecordBytes,
          'Invalid TLS fixture record',
        );
        if (pending.length < length + 5) return;
        const complete = pending.subarray(0, length + 5);
        pending = pending.subarray(length + 5);
        record(complete);
      }
    },
    finish() {
      assert.equal(pending.length, 0, 'Truncated TLS fixture record');
    },
  };
}

function exchange(certificate: string, host: string, truncate: boolean) {
  const fd = 3;
  const socket = new Socket({ fd, readable: true, writable: true });
  let application: Buffer | undefined;
  let sequence = 0;
  let authorized = true;
  let ready = false;
  let requested = false;
  let first = false;
  let stopped = false;
  const report = (kind: string, bytes = 0) =>
    process.send!({ kind, sequence: ++sequence, bytes });
  const records = tlsRecords((bytes) => {
    if (bytes[0] === applicationData) {
      assert(ready && requested && application === undefined && !first);
      application = bytes;
      return;
    }
    assert(
      !requested,
      'Unexpected TLS control record during application write',
    );
    assert.equal(writeSync(fd, bytes, 0, bytes.length), bytes.length);
  });
  const transport = new Duplex({
    read() {
      socket.resume();
    },
    write(bytes: Buffer, _encoding, done) {
      try {
        records.feed(
          truncate && bytes[0] === applicationData
            ? bytes.subarray(0, -1)
            : bytes,
        );
        done();
      } catch (error) {
        done(error as Error);
      }
    },
  });
  socket.on('data', (bytes: Buffer) => {
    if (!transport.push(bytes)) socket.pause();
  });
  socket.on('end', () => transport.push(null));
  const secure = connect({
    socket: transport,
    host,
    ca: readFileSync(certificate),
    minVersion: 'TLSv1.2',
    maxVersion: 'TLSv1.2',
    rejectUnauthorized: true,
  });
  function close() {
    if (stopped) return;
    stopped = true;
    secure.destroy();
    transport.destroy();
    socket.destroy();
    if (process.connected) process.disconnect?.();
  }
  function fail(kind: string) {
    if (stopped) return;
    report(kind);
    close();
  }
  secure.once('secureConnect', () => {
    assert(secure.authorized);
    secure.disableRenegotiation();
    ready = true;
    report('ready');
  });
  secure.once('error', (error: NodeJS.ErrnoException) => {
    fail(
      error.code === 'ERR_TLS_CERT_ALTNAME_INVALID'
        ? 'invalid-peer'
        : 'failure',
    );
  });
  socket.on('error', (error) => transport.destroy(error));
  process.once('disconnect', close);
  process.on('message', (input: { kind: string; request?: string }) => {
    switch (input.kind) {
      case 'prepare':
        assert(
          ready &&
            !requested &&
            typeof input.request === 'string' &&
            Buffer.byteLength(input.request) <= 1024,
        );
        requested = true;
        secure.write(input.request, (error) => {
          if (error) return fail('failure');
          try {
            records.finish();
            assert(application, 'Missing TLS fixture application record');
            report('prepared', application.length);
          } catch {
            fail('invalid-record');
          }
        });
        return;
      case 'revoke':
        authorized = false;
        report('revoked');
        return;
      case 'submit':
      case 'zero':
      case 'partial': {
        records.finish();
        assert(application && !first);
        if (!authorized) {
          report('denied');
          close();
          return;
        }
        const length =
          input.kind === 'zero'
            ? 0
            : input.kind === 'partial'
              ? application.length - 8
              : application.length;
        let accepted: number;
        try {
          accepted = writeSync(fd, application, 0, length);
        } catch {
          fail('write-failed');
          return;
        }
        first = accepted > 0;
        if (!first) {
          report('zero');
          return;
        }
        report('first', accepted);
        report(accepted === application.length ? 'full' : 'partial', accepted);
        if (accepted !== application.length) close();
        return;
      }
      case 'close':
        close();
        return;
      default:
        assert.fail('Unknown TLS fixture operation');
    }
  });
}

if (import.meta.main)
  exchange(process.argv[2]!, process.argv[3]!, process.argv[4] === 'truncated');
