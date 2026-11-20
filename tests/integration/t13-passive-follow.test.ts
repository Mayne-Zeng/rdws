import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import { passiveModelFollow } from '../../dsh/client/passive-follow.ts';

const request = {
  address: { kind: 'session', sessionId: 'session-' + randomUUID() },
  activate: true,
  assistantStream: true,
};
const follow = {
  type: 'open',
  streamId: randomUUID(),
  endpoint: 'session/follow',
  payload: { args: { request } },
};

test('the pilot client changes only the activation bit in the locked SDK follow', () => {
  for (const window of [
    {},
    { maxMessages: 80, turnWindow: { minMessages: 6, minTurns: 2 } },
  ]) {
    const frame = {
      ...follow,
      payload: { args: { request: { ...request, ...window } } },
    };
    const expected = {
      ...frame,
      payload: {
        args: { request: { ...request, ...window, activate: false } },
      },
    };
    expect(passiveModelFollow(JSON.stringify(frame))).toBe(
      JSON.stringify(expected),
    );
  }
});

test('the pilot client leaves bytes outside the exact ordinary SDK follow shape alone', () => {
  const raw = JSON.stringify(follow);
  const binary = new TextEncoder().encode(raw);
  const shapes = [
    { ...follow, endpoint: 'session/prompt' },
    { ...follow, streamId: 'another-id' },
    { type: 'cancel', streamId: follow.streamId },
    { ...follow, unknown: true },
    ...[
      { ...request, activate: 'true' },
      { ...request, activate: false },
      { ...request, assistantStream: false },
      {
        ...request,
        address: {
          kind: 'subagent',
          childSessionId: request.address.sessionId,
        },
      },
      { ...request, afterSeq: 1 },
      {
        ...request,
        maxMessages: 2,
        turnWindow: { minMessages: 3, minTurns: 1 },
      },
      { ...request, turnWindow: { minMessages: 0, minTurns: 1 } },
    ].map((shape) => ({ ...follow, payload: { args: { request: shape } } })),
  ];
  for (const input of [
    binary,
    '{',
    raw + ' '.repeat(16 * 1024),
    raw.replace('"activate":true', '"activate":false,"activate":true'),
    ...shapes.map((shape) => JSON.stringify(shape)),
  ])
    expect(passiveModelFollow(input)).toBe(input);
});
