import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { expect, test, vi } from 'vitest';
import {
  openContextIpc,
  serveContextIpc,
} from '../../dsh/bridge/context-ipc.ts';

class Port extends EventEmitter {
  connected = true;
  writes: {
    data: object;
    complete: (error: Error | null) => void;
  }[] = [];
  send(data: object, complete: (error: Error | null) => void) {
    this.writes.push({ data, complete });
    return false;
  }
}

const generation = 'fixture-host';

test('the context channel associates out-of-order results with their own requests', async () => {
  const worker = new Port(),
    parent = new Port();
  const client = openContextIpc(generation, worker);
  const ready: (() => void)[] = [];
  const handle = vi.fn(async (body, _token, reply) => {
    await new Promise<void>((resolve) => ready.push(resolve));
    reply(body, Infinity);
  });
  const dispose = serveContextIpc(parent, generation, handle, () => true);
  try {
    const first = client.request({ seq: 1 }, 'fixture-first');
    const second = client.request({ seq: 2 }, 'fixture-second');
    const [a, b] = worker.writes;
    parent.emit('message', { ...a!.data, generation: 'previous' });
    parent.emit('message', {
      ...a!.data,
      body: { payload: '界'.repeat(30000) },
    });
    const handleDestroy = vi.fn();
    parent.emit('message', a!.data, { destroy: handleDestroy });
    expect(handleDestroy).toHaveBeenCalledOnce();
    expect(handle).not.toHaveBeenCalled();
    parent.emit('message', a!.data);
    parent.emit('message', a!.data);
    parent.emit('message', b!.data);
    a!.complete(null);
    b!.complete(null);
    expect(handle.mock.calls.map(([body, token]) => ({ body, token }))).toEqual(
      [
        { body: { seq: 1 }, token: 'fixture-first' },
        { body: { seq: 2 }, token: 'fixture-second' },
      ],
    );
    ready[1]!();
    await vi.waitFor(() => expect(parent.writes).toHaveLength(1));
    const reply = parent.writes[0]!;
    worker.emit('message', {
      ...reply.data,
      id: randomUUID(),
      result: { stale: true },
    });
    worker.emit('message', {
      ...reply.data,
      generation: 'old',
      result: { stale: true },
    });
    worker.emit('message', reply.data);
    reply.complete(null);
    await expect(second).resolves.toEqual({ seq: 2 });
    ready[0]!();
    await vi.waitFor(() => expect(parent.writes).toHaveLength(2));
    worker.emit('message', parent.writes[1]!.data);
    parent.writes[1]!.complete(null);
    await expect(first).resolves.toEqual({ seq: 1 });
  } finally {
    client.close();
    dispose();
  }
});

test('timeout, host replacement and disconnect discard context results', async () => {
  vi.useFakeTimers();
  const worker = new Port(),
    parent = new Port();
  const client = openContextIpc(generation, worker);
  const ready: (() => void)[] = [];
  let current = true;
  const dispose = serveContextIpc(
    parent,
    generation,
    async (body, _token, reply) => {
      await new Promise<void>((resolve) => ready.push(resolve));
      reply(body, Infinity);
    },
    () => current,
  );
  try {
    const expired = client
      .request({ data: 'late snapshot' }, 'fixture')
      .catch((error) => error);
    parent.emit('message', worker.writes[0]!.data);
    worker.writes[0]!.complete(null);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await expired).toBeInstanceOf(Error);
    ready[0]!();
    await vi.advanceTimersByTimeAsync(0);
    expect(parent.writes).toEqual([]);

    const displaced = client
      .request({ data: 'old process' }, 'fixture')
      .catch((error) => error);
    parent.emit('message', worker.writes[1]!.data);
    worker.writes[1]!.complete(null);
    current = false;
    ready[1]!();
    await vi.advanceTimersByTimeAsync(0);
    expect(parent.writes).toEqual([]);
    worker.connected = false;
    worker.emit('disconnect');
    expect(await displaced).toBeInstanceOf(Error);
    expect(worker.listenerCount('message')).toBe(0);
    await expect(client.request({}, 'fixture')).rejects.toThrow(
      'Current context authorization failed',
    );
  } finally {
    client.close();
    dispose();
    vi.useRealTimers();
  }
});

test('IPC backpressure respects unfinished writes even when a caller cancels', async () => {
  const worker = new Port(),
    parent = new Port();
  const client = openContextIpc(generation, worker);
  const handle = vi.fn(async (body, _token, reply) => reply(body, Infinity));
  const dispose = serveContextIpc(parent, generation, handle, () => true);
  try {
    for (let seq = 0; seq < 64; seq++) {
      const controller = new AbortController();
      const result = client.request({ seq }, 'fixture', controller.signal);
      parent.emit('message', worker.writes.at(-1)!.data);
      controller.abort();
      await expect(result).rejects.toThrow(
        'Current context authorization failed',
      );
    }
    expect(worker.writes).toHaveLength(64);
    expect(parent.writes).toHaveLength(64);
    await expect(client.request({}, 'fixture')).rejects.toThrow(
      'Current context authorization failed',
    );
    worker.writes[0]!.complete(new Error('Synthetic channel failure'));
    await new Promise<void>((resolve) => setImmediate(resolve));
    const truncated = new AbortController();
    const rejected = client.request(
      { seq: 'blocked' },
      'fixture',
      truncated.signal,
    );
    expect(worker.writes).toHaveLength(65);
    parent.emit('message', worker.writes[64]!.data);
    expect(handle).toHaveBeenCalledTimes(64);
    truncated.abort();
    await expect(rejected).rejects.toThrow(
      'Current context authorization failed',
    );
    worker.writes[64]!.complete(null);
    parent.writes[0]!.complete(new Error('Synthetic response failure'));
    await new Promise<void>((resolve) => setImmediate(resolve));
    const newRequest = client.request({ seq: 'new' }, 'fixture');
    expect(worker.writes).toHaveLength(66);
    parent.emit('message', worker.writes[65]!.data);
    expect(handle).toHaveBeenCalledTimes(65);
    worker.writes[65]!.complete(null);
    worker.emit('message', parent.writes[64]!.data);
    parent.writes[64]!.complete(null);
    expect(await newRequest).toEqual({ seq: 'new' });
  } finally {
    client.close();
    dispose();
  }
});
