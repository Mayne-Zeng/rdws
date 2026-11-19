import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

export async function modelTlsCertificate(directory: string, ip = '127.0.0.1') {
  const key = join(directory, 'key.pem');
  const cert = join(directory, 'certificate.pem');
  await promisify(execFile)('openssl', [
    'req',
    '-x509',
    '-newkey',
    'ec',
    '-pkeyopt',
    'ec_paramgen_curve:P-256',
    '-nodes',
    '-days',
    '1',
    '-subj',
    '/CN=' + ip,
    '-addext',
    'subjectAltName=IP:' + ip,
    '-keyout',
    key,
    '-out',
    cert,
  ]);
  return { key: await readFile(key), cert: await readFile(cert) };
}
