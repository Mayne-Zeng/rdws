import { request } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';

const redirects = new Set([301, 302, 303, 307, 308]);
const empty = new Set([204, 205, 304]);

export async function nativeLoopbackRequest(
  origin: string,
  path: string,
  init: RequestInit,
) {
  const url = new URL(path, origin);
  if (
    !path.startsWith('/') ||
    path.startsWith('//') ||
    url.origin !== origin ||
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    url.username ||
    url.password
  )
    throw new Error('Invalid Native loopback target');
  const input = new Request(url, { ...init, duplex: 'half' } as RequestInit);
  input.headers.set('accept-encoding', 'identity');
  return new Promise<Response>((resolve, reject) => {
    const outgoing = request(
      url,
      {
        agent: false,
        method: input.method,
        headers: Object.fromEntries(input.headers),
        signal: input.signal,
      },
      (incoming) => {
        const status = incoming.statusCode ?? 0;
        const hasBody = input.method !== 'HEAD' && !empty.has(status);
        const encoding = incoming.headers['content-encoding'];
        if (
          status < 200 ||
          status > 599 ||
          redirects.has(status) ||
          (hasBody && encoding && encoding.toLowerCase() !== 'identity')
        ) {
          incoming.destroy();
          reject(new Error('Invalid Native loopback response'));
          return;
        }
        const headers = new Headers();
        for (let i = 0; i < incoming.rawHeaders.length; i += 2)
          headers.append(incoming.rawHeaders[i]!, incoming.rawHeaders[i + 1]!);
        if (!hasBody) incoming.resume();
        const body = hasBody
          ? (Readable.toWeb(incoming, {
              strategy: {
                highWaterMark: incoming.readableHighWaterMark,
                size: (chunk: Uint8Array) => chunk.byteLength,
              },
            }) as unknown as ReadableStream<Uint8Array>)
          : null;
        resolve(
          new Response(body, {
            status,
            statusText: incoming.statusMessage,
            headers,
          }),
        );
      },
    );
    outgoing.once('error', reject);
    outgoing.once('upgrade', (_response, socket) => {
      socket.destroy();
      reject(new Error('Invalid Native loopback response'));
    });
    if (input.body) {
      void pipeline(
        Readable.fromWeb(input.body as NodeReadableStream<Uint8Array>),
        outgoing,
      ).catch(reject);
    } else outgoing.end();
  });
}
