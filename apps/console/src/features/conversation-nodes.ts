// Pure projection from the Native event window to conversation nodes. Only
// append-origin user and assistant messages become visible messages: the
// model-visible surface is not a human transcript, so replacement copies are
// skipped and never hide what the reader already saw.
export type UsageSummary = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
};
export type ToolStatus =
  | 'running'
  | 'result-returned'
  | 'result-error'
  | 'blocked'
  | 'not-started'
  | 'outcome-unknown';
export type AssistantNode = Extract<ConversationNode, { kind: 'assistant' }>;
export type ConversationNode =
  | {
      kind: 'user';
      key: string;
      seq: number;
      time?: number;
      text: string;
    }
  | {
      kind: 'assistant';
      key: string;
      seq: number;
      time?: number;
      text: string;
      live: boolean;
      model?: string;
      usage?: UsageSummary;
      interrupted: boolean;
    }
  | {
      kind: 'tool';
      key: string;
      seq: number;
      time?: number;
      name?: string;
      turn?: number;
      step?: number;
      status: ToolStatus;
      endSeq?: number;
      endTime?: number;
    }
  | {
      kind: 'notice';
      key: string;
      seq: number;
      time?: number;
      tone: 'info' | 'warning' | 'danger';
      text: string;
    };
type ToolNode = Extract<ConversationNode, { kind: 'tool' }>;
type CallSlot = {
  place: Positioned;
  call: ToolEvent['call'];
  open: ToolNode;
  merged: WeakMap<object, ToolNode>;
};

export const toolStatusLabels: Record<ToolStatus, string> = {
  running: '运行中',
  'result-returned': '已完成',
  'result-error': '出错',
  blocked: '已阻止',
  'not-started': '未启动',
  'outcome-unknown': '结果未知',
};
type NoticeNode = Extract<ConversationNode, { kind: 'notice' }>;
const notices: Record<string, Pick<NoticeNode, 'tone' | 'text'>> = {
  interrupted: { tone: 'warning', text: '本轮已中断。' },
  aborted: { tone: 'warning', text: '本轮已中止。' },
  'max-tokens': { tone: 'warning', text: '本轮达到输出上限，回复可能不完整。' },
  error: { tone: 'danger', text: '本轮发生错误，请稍后重试。' },
  forked: { tone: 'info', text: '派生前的轮次在此结束。' },
};
const usageFields = [
  'inputTokens',
  'outputTokens',
  'totalTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'reasoningTokens',
] as const;

// Stable node identities across window publications: one entry object keeps
// its node object, so unchanged messages skip re-rendering their Markdown.
export type ProjectionCache = {
  messages: WeakMap<object, ConversationNode | null>;
  calls: WeakMap<object, CallSlot>;
  results: WeakMap<object, ToolNode>;
};
export function createProjectionCache(): ProjectionCache {
  return {
    messages: new WeakMap(),
    calls: new WeakMap(),
    results: new WeakMap(),
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function textOf(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .flatMap((part) => {
      const block = record(part);
      return block?.type === 'text' && typeof block.text === 'string'
        ? [block.text]
        : [];
    })
    .join('');
}
function integer(value: unknown) {
  return typeof value === 'number' && Number.isSafeInteger(value)
    ? value
    : undefined;
}
function usageOf(value: unknown): UsageSummary | undefined {
  const usage = record(value);
  if (!usage) return undefined;
  const picked: UsageSummary = {};
  for (const field of usageFields) {
    const amount = integer(usage[field]);
    if (amount !== undefined) picked[field] = amount;
  }
  return Object.keys(picked).length ? picked : undefined;
}
function toolStatus(value: unknown): ToolStatus {
  return typeof value === 'string' && Object.hasOwn(toolStatusLabels, value)
    ? (value as ToolStatus)
    : 'outcome-unknown';
}
type Positioned = { seq: number; time?: number };
function positioned(event: Record<string, unknown>): Positioned | undefined {
  const seq = integer(event.seq);
  return seq === undefined ? undefined : { seq, time: integer(event.time) };
}
function nodeFor(
  event: Record<string, unknown>,
  surfaceOp: unknown,
  place: Positioned,
): ConversationNode | null {
  const data = record(event.data);
  if (!data) return null;
  switch (event.type) {
    case 'user/message': {
      const source = record(data.source);
      if (surfaceOp !== 'append' || source?.kind !== 'user') return null;
      const message = record(data.message);
      const text = textOf(message?.content ?? data.content);
      return text
        ? {
            kind: 'user',
            key: `u-${place.seq}`,
            seq: place.seq,
            time: place.time,
            text,
          }
        : null;
    }
    case 'assistant/message': {
      if (surfaceOp !== 'append') return null;
      const message = record(data.message);
      const text = textOf(message?.content);
      if (!text) return null;
      const source = record(message?.source);
      const provider = source?.provider,
        model = source?.model;
      return {
        kind: 'assistant',
        key: `a-${place.seq}`,
        seq: place.seq,
        time: place.time,
        text,
        live: false,
        ...(typeof provider === 'string' && typeof model === 'string'
          ? { model: `${provider} / ${model}` }
          : {}),
        usage: usageOf(data.usage),
        interrupted: data.interrupted === true,
      };
    }
    case 'turn/end': {
      const kind = record(data.reason)?.kind,
        notice =
          typeof kind === 'string' && Object.hasOwn(notices, kind)
            ? notices[kind]
            : undefined;
      return notice
        ? {
            kind: 'notice',
            key: `n-${place.seq}`,
            seq: place.seq,
            time: place.time,
            ...notice,
          }
        : null;
    }
    default:
      return null;
  }
}
type ToolEvent = {
  event: object;
  place: Positioned;
  call?: { callId?: string; name?: string; turn?: number; step?: number };
  result?: { callId?: string; status: ToolStatus };
};
function toolEvent(
  event: Record<string, unknown>,
  surfaceOp: unknown,
  place: Positioned,
): ToolEvent | undefined {
  const data = record(event.data);
  if (!data) return undefined;
  const base = { event, place };
  if (event.type === 'tool/call') {
    const turn = integer(data.turn),
      step = integer(data.step);
    return {
      ...base,
      call: {
        ...(typeof data.callId === 'string' ? { callId: data.callId } : {}),
        ...(typeof data.name === 'string' ? { name: data.name } : {}),
        ...(turn !== undefined ? { turn } : {}),
        ...(step !== undefined ? { step } : {}),
      },
    };
  }
  // Only an appended result is conversation material; pruned copies are not.
  if (event.type !== 'tool/result' || surfaceOp !== 'append') return undefined;
  const message = record(data.message),
    source = record(message?.source);
  if (
    !message ||
    message.role !== 'tool' ||
    source?.kind !== 'tool' ||
    source.callId !== message.toolCallId
  )
    return undefined;
  return {
    ...base,
    result: {
      ...(typeof message.toolCallId === 'string'
        ? { callId: message.toolCallId }
        : {}),
      status: toolStatus(data.status),
    },
  };
}
// A paired card sits at its call; a result that has no call in the window
// stands alone.
function toolNode(
  call: { place: Positioned; info: ToolEvent['call'] } | undefined,
  result?: ToolEvent,
): ToolNode {
  const place = call?.place ?? result!.place;
  const info = call?.info;
  return {
    kind: 'tool',
    key: `t-${place.seq}`,
    seq: place.seq,
    time: place.time,
    ...(info?.name !== undefined ? { name: info.name } : {}),
    ...(info?.turn !== undefined ? { turn: info.turn } : {}),
    ...(info?.step !== undefined ? { step: info.step } : {}),
    status: result?.result?.status ?? 'running',
    ...(result ? { endSeq: result.place.seq, endTime: result.place.time } : {}),
  };
}

export function projectConversationNodes(
  entries: readonly unknown[],
  cache: ProjectionCache = createProjectionCache(),
): ConversationNode[] {
  const nodes: ConversationNode[] = [];
  // callId -> the call's slot and where its node sits in `nodes`.
  const open = new Map<string, { slot: CallSlot; index: number }>();
  const live = new Map<string, AssistantNode>();
  for (const value of entries) {
    const entry = record(value),
      event = record(entry?.event);
    if (!event) continue;
    const place = positioned(event);
    if (entry?.type === 'transient') {
      // Only text deltas accumulate; block frames repeat whole blocks and
      // reasoning stays out of the visible transcript.
      const data = record(event.data),
        chunk = record(data?.chunk);
      if (
        !place ||
        chunk?.type !== 'text-delta' ||
        typeof chunk.text !== 'string' ||
        typeof data?.attemptId !== 'string'
      )
        continue;
      let node = live.get(data.attemptId);
      if (!node) {
        node = {
          kind: 'assistant',
          key: `live-${data.attemptId}`,
          seq: place.seq,
          time: place.time,
          text: '',
          live: true,
          interrupted: false,
        };
        live.set(data.attemptId, node);
        nodes.push(node);
      }
      node.text += chunk.text;
      continue;
    }
    if (entry?.type !== 'event' || !place) continue;
    const tool = toolEvent(event, event.surfaceOp, place);
    if (tool) {
      if (tool.call) {
        let slot = cache.calls.get(tool.event);
        if (!slot) {
          slot = {
            place: tool.place,
            call: tool.call,
            open: toolNode({ place: tool.place, info: tool.call }),
            merged: new WeakMap(),
          };
          cache.calls.set(tool.event, slot);
        }
        // A call without a usable id cannot be paired; it stays on its own.
        if (tool.call.callId && !open.has(tool.call.callId))
          open.set(tool.call.callId, { slot, index: nodes.length });
        nodes.push(slot.open);
      } else if (tool.result) {
        const callId = tool.result.callId
          ? open.get(tool.result.callId)
          : undefined;
        if (callId) {
          const slot = callId.slot;
          const merged =
            slot.merged.get(tool.event) ??
            (() => {
              const combined = toolNode(
                { place: slot.place, info: slot.call },
                tool,
              );
              slot.merged.set(tool.event, combined);
              return combined;
            })();
          nodes[callId.index] = merged;
          if (tool.result.callId) open.delete(tool.result.callId);
        } else {
          let standalone = cache.results.get(tool.event);
          if (!standalone) {
            standalone = toolNode(undefined, tool);
            cache.results.set(tool.event, standalone);
          }
          nodes.push(standalone);
        }
      }
      continue;
    }
    if (cache.messages.has(event)) {
      const cached = cache.messages.get(event);
      if (cached) nodes.push(cached);
      continue;
    }
    const node = nodeFor(event, event.surfaceOp, place);
    cache.messages.set(event, node);
    if (node) nodes.push(node);
  }
  return nodes;
}

export function formatClock(time: number, seconds = false) {
  return new Date(time).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    ...(seconds ? { second: '2-digit' } : {}),
    hour12: false,
  });
}
export function formatDuration(from: number, to: number) {
  const ms = Math.max(0, to - from);
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total}s`;
  return `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, '0')}s`;
}
export function formatUsage(usage: UsageSummary) {
  const total = usage.totalTokens;
  if (total !== undefined) return `${total} tokens`;
  return usage.inputTokens !== undefined && usage.outputTokens !== undefined
    ? `${usage.inputTokens + usage.outputTokens} tokens`
    : undefined;
}
