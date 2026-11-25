import { describe, expect, test } from 'vitest';
import {
  createProjectionCache,
  formatDuration,
  formatUsage,
  projectConversationNodes,
} from './conversation-nodes.ts';

const base = Date.UTC(2026, 10, 24, 8, 0, 0);
function user(seq: number, text: string, source: Record<string, unknown> = {}) {
  return {
    type: 'event',
    event: {
      seq,
      time: base + seq * 1000,
      type: 'user/message',
      surfaceOp: 'append',
      data: {
        source: { kind: 'user', ...source },
        message: { content: [{ type: 'text', text }] },
      },
    },
  };
}
function assistant(
  seq: number,
  content: unknown[],
  extra: Record<string, unknown> = {},
) {
  return {
    type: 'event',
    event: {
      seq,
      time: base + seq * 1000,
      type: 'assistant/message',
      surfaceOp: 'append',
      data: {
        message: {
          source: { kind: 'model', provider: 'gateway', model: 'm1' },
          content,
        },
        usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
        ...extra,
      },
      ...(extra.surfaceOp ? { surfaceOp: extra.surfaceOp } : {}),
    },
  };
}
const delta = (seq: number, text: string, attemptId = 'a1') => ({
  type: 'transient',
  event: {
    seq,
    time: base + seq * 1000,
    data: { attemptId, turn: 1, step: 1, chunk: { type: 'text-delta', text } },
  },
});
const chunk = (
  seq: number,
  chunk: Record<string, unknown>,
  attemptId = 'a1',
) => ({
  type: 'transient',
  event: {
    seq,
    time: base + seq * 1000,
    data: { attemptId, turn: 1, step: 1, chunk },
  },
});
const call = (seq: number, callId: string, name: string) => ({
  type: 'event',
  event: {
    seq,
    time: base + seq * 1000,
    type: 'tool/call',
    data: { turn: 1, step: 1, callId, name, arguments: '{"secret":1}' },
  },
});
const result = (seq: number, callId: string, status: string) => ({
  type: 'event',
  event: {
    seq,
    time: base + seq * 1000,
    type: 'tool/result',
    surfaceOp: 'append',
    data: {
      turn: 1,
      step: 1,
      status,
      message: {
        role: 'tool',
        toolCallId: callId,
        source: { kind: 'tool', callId },
        content: [{ type: 'text', text: 'private output' }],
      },
      error: { name: 'X', code: 'Y', reason: 'private reason' },
    },
  },
});
const turnEnd = (seq: number, kind: string) => ({
  type: 'event',
  event: {
    seq,
    time: base + seq * 1000,
    type: 'turn/end',
    data: { turn: 1, reason: { kind } },
  },
});

describe('projectConversationNodes', () => {
  test('append messages keep text, time, model and usage', () => {
    const nodes = projectConversationNodes([
      user(1, '你好'),
      assistant(2, [{ type: 'text', text: '你好！' }]),
    ]);
    expect(nodes).toEqual([
      { kind: 'user', key: 'u-1', seq: 1, time: base + 1000, text: '你好' },
      {
        kind: 'assistant',
        key: 'a-2',
        seq: 2,
        time: base + 2000,
        text: '你好！',
        live: false,
        model: 'gateway / m1',
        usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
        interrupted: false,
      },
    ]);
  });

  test('only human prompts become user messages', () => {
    expect(
      projectConversationNodes([
        user(1, 'ctx', { kind: 'rdws-context' }),
        user(2, 'again', { kind: 'retry' }),
        { type: 'event', event: { seq: 3, time: 1, type: 'user/message' } },
      ]),
    ).toEqual([]);
  });

  test('replacement copies neither appear nor hide earlier messages', () => {
    const nodes = projectConversationNodes([
      user(1, '已看到的问题'),
      assistant(2, [{ type: 'text', text: '已看到的回答' }], {
        surfaceOp: { op: 'replace', startSeq: 1, endSeq: 1 },
      }),
      assistant(3, [{ type: 'text', text: '压缩摘要' }], {
        surfaceOp: { op: 'replace', startSeq: 1, endSeq: 2 },
      }),
    ]);
    expect(nodes.map((node) => node.key)).toEqual(['u-1']);
  });

  test('reasoning blocks never become visible text', () => {
    expect(
      projectConversationNodes([
        assistant(1, [{ type: 'reasoning', text: '思考内容' }]),
        assistant(2, [
          { type: 'reasoning', text: '思考内容' },
          { type: 'text', text: '可见回答' },
        ]),
      ]).map((node) => (node.kind === 'assistant' ? node.text : node.key)),
    ).toEqual(['可见回答']);
  });

  test('only text deltas feed the live assistant node', () => {
    const nodes = projectConversationNodes([
      delta(1, '你'),
      chunk(2, { type: 'reasoning-delta', index: 0, text: '思考' }),
      chunk(3, { type: 'block-start', index: 0, blockType: 'text' }),
      delta(4, '好', 'a1'),
      chunk(5, {
        type: 'block-end',
        index: 0,
        block: { type: 'text', text: '你好' },
      }),
      delta(6, '另一段', 'a2'),
    ]);
    expect(nodes).toHaveLength(2);
    expect(nodes[0]).toMatchObject({
      kind: 'assistant',
      key: 'live-a1',
      live: true,
      text: '你好',
    });
    expect(nodes[1]).toMatchObject({
      key: 'live-a2',
      live: true,
      text: '另一段',
    });
  });

  test('a tool call and its result share one card at the call position', () => {
    const nodes = projectConversationNodes([
      user(1, '读文件'),
      call(2, 'c1', 'Read'),
      result(3, 'c1', 'result-returned'),
      assistant(4, [{ type: 'text', text: '完成' }]),
    ]);
    expect(nodes.map((node) => node.key)).toEqual(['u-1', 't-2', 'a-4']);
    expect(nodes[1]).toEqual({
      kind: 'tool',
      key: 't-2',
      seq: 2,
      time: base + 2000,
      name: 'Read',
      turn: 1,
      step: 1,
      status: 'result-returned',
      endSeq: 3,
      endTime: base + 3000,
    });
    // Arguments, result text and the raw error never reach the node.
    expect(JSON.stringify(nodes)).not.toMatch(/secret|private|arguments/);
  });

  test('tool events without a usable id stay separate and results need an append', () => {
    const nodes = projectConversationNodes([
      call(1, '', 'Read'),
      {
        ...call(2, 'c2', 'Edit'),
        event: { ...call(2, 'c2', 'Edit').event, surfaceOp: 'append' },
      },
      result(3, 'missing', 'result-error'),
      {
        ...result(4, 'c2', 'result-returned'),
        event: {
          ...result(4, 'c2', 'result-returned').event,
          surfaceOp: { op: 'replace', startSeq: 1, endSeq: 1 },
        },
      },
      call(5, 'c5', 'Shell'),
    ]);
    expect(
      nodes.map((node) => [
        node.seq,
        node.kind === 'tool' ? node.status : node.kind,
      ]),
    ).toEqual([
      [1, 'running'],
      [2, 'running'],
      [3, 'result-error'],
      [5, 'running'],
    ]);
  });

  test('a pruned or malformed tool result is skipped', () => {
    const broken = result(1, 'c1', 'result-returned') as {
      event: { data: { message: Record<string, unknown> } };
    };
    broken.event.data.message.role = 'user';
    expect(projectConversationNodes([broken])).toEqual([]);
  });

  test('only unfinished turns leave a notice', () => {
    const kinds = [
      'completed',
      'interrupted',
      'max-tokens',
      'error',
      'forked',
      'unknown',
    ];
    const nodes = projectConversationNodes(
      kinds.map((kind, i) => turnEnd(i + 1, kind)),
    );
    expect(
      nodes.map((node) =>
        node.kind === 'notice' ? [node.tone, node.text] : node.kind,
      ),
    ).toEqual([
      ['warning', '本轮已中断。'],
      ['warning', '本轮达到输出上限，回复可能不完整。'],
      ['danger', '本轮发生错误，请稍后重试。'],
      ['info', '派生前的轮次在此结束。'],
    ]);
  });

  test('entries without a usable sequence are ignored', () => {
    expect(
      projectConversationNodes([
        null,
        { type: 'event' },
        { type: 'event', event: { type: 'user/message' } },
        { type: 'event', event: { seq: '1', type: 'user/message', data: {} } },
      ]),
    ).toEqual([]);
  });

  test('unchanged entries keep their node objects across publications', () => {
    const cache = createProjectionCache();
    const first = user(1, '一'),
      second = assistant(2, [{ type: 'text', text: '二' }]);
    const before = projectConversationNodes([first, second], cache);
    const after = projectConversationNodes(
      [first, second, delta(3, 'x')],
      cache,
    );
    expect(after[0]).toBe(before[0]);
    expect(after[1]).toBe(before[1]);
    expect(after[2]).toMatchObject({ key: 'live-a1', text: 'x' });
  });

  test('a result arriving in a later publication merges into the cached call', () => {
    const cache = createProjectionCache();
    const first = call(1, 'c1', 'Read'),
      second = result(2, 'c1', 'result-returned');
    const [open] = projectConversationNodes([first], cache);
    const [merged] = projectConversationNodes([first, second], cache);
    expect(open).toMatchObject({ status: 'running' });
    expect(merged).toMatchObject({
      key: 't-1',
      status: 'result-returned',
      endSeq: 2,
    });
    const [again] = projectConversationNodes([first, second], cache);
    expect(again).toBe(merged);
  });
});

describe('conversation formatters', () => {
  test('durations and usage read as short text', () => {
    expect(formatDuration(0, 90)).toBe('0.1s');
    expect(formatDuration(0, 8200)).toBe('8.2s');
    expect(formatDuration(0, 12_000)).toBe('12s');
    expect(formatDuration(0, 62_000)).toBe('1m 02s');
    expect(formatUsage({ inputTokens: 2, outputTokens: 3 })).toBe('5 tokens');
    expect(formatUsage({ totalTokens: 9 })).toBe('9 tokens');
    expect(formatUsage({})).toBeUndefined();
  });
});
