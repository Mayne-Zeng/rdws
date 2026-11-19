import { isRecord } from './access.ts';
import { inboxList, publicContent, publicFields } from './session-view.ts';

export const modelFailure = '本轮模型请求失败，请稍后重试。';
const progress = { turn: 'integer', step: 'integer' } as const;

function usage(value: unknown) {
  if (isRecord(value))
    return publicFields(value, {
      inputTokens: 'integer',
      outputTokens: 'integer',
      totalTokens: 'integer',
      cacheReadTokens: 'integer',
      cacheWriteTokens: 'integer',
      reasoningTokens: 'integer',
    });
}

function messageBody(value: unknown) {
  return Array.isArray(value)
    ? value.flatMap((part) => {
        if (
          isRecord(part) &&
          part.type === 'reasoning' &&
          typeof part.text === 'string'
        )
          return [{ type: 'reasoning', text: part.text }];
        return publicContent([part]);
      })
    : [];
}

function finishReason(value: unknown) {
  if (!isRecord(value))
    return {
      kind: 'error',
      failure: { code: 'UNKNOWN', message: modelFailure },
    };
  switch (value.kind) {
    case 'error':
    case 'aborted':
      return {
        kind: value.kind,
        failure: {
          code: 'UNKNOWN',
          message: value.kind === 'aborted' ? '模型请求已中止。' : modelFailure,
        },
      };
    case 'stop':
    case 'tool-calls':
    case 'max-tokens':
      return { kind: value.kind };
    default:
      return {
        kind: 'error',
        failure: { code: 'UNKNOWN', message: modelFailure },
      };
  }
}

function publicChunk(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return;
  const { type, index } = value;
  if (type === 'finish') return { type, reason: finishReason(value.reason) };
  if (type === 'usage') return { type, usage: usage(value.usage) };
  if (!Number.isSafeInteger(index) || Number(index) < 0) return;
  if (
    (type === 'text-delta' || type === 'reasoning-delta') &&
    typeof value.text === 'string'
  )
    return { type, index, text: value.text };
  if (type === 'block-start')
    return {
      type,
      index,
      blockType: publicFields(value, {
        blockType: ['text', 'reasoning', 'image', 'file', 'tool-call'],
      }).blockType,
    };
  if (type === 'block-end') {
    const block = messageBody([value.block])[0];
    return { type, index, block: block ?? { type: 'text', text: '' } };
  }
  if (type === 'tool-call-delta' && typeof value.id === 'string')
    return { type, index, id: value.id, argumentsDelta: '' };
}

export function publicAssistantRecords(value: unknown) {
  if (!Array.isArray(value)) return;
  const records = value.map((row: unknown) => {
    if (!isRecord(row)) return;
    const { type } = row;
    if (type === 'chunk' && Number.isSafeInteger(row.time)) {
      const chunk = publicChunk(row.chunk);
      if (chunk) return { type, time: row.time, chunk };
      return;
    }
    if (
      !Array.isArray(row.dt) ||
      !row.dt.every(Number.isSafeInteger) ||
      !Number.isSafeInteger(row.time0) ||
      !Number.isSafeInteger(row.index)
    )
      return;
    const timed = { type, time0: row.time0, index: row.index, dt: row.dt };
    if (
      (type === 'text-chunks' || type === 'reasoning-chunks') &&
      Array.isArray(row.texts) &&
      row.texts.length === row.dt.length + 1 &&
      row.texts.every((text) => typeof text === 'string')
    )
      return { ...timed, texts: row.texts };
    if (
      type === 'tool-call-chunks' &&
      typeof row.id === 'string' &&
      Array.isArray(row.args) &&
      row.args.length === row.dt.length + 1
    )
      return { ...timed, id: row.id, args: row.args.map(() => '') };
  });
  if (records.every((record) => record !== undefined)) return records;
}

export function publicAssistantFrame(value: unknown) {
  if (
    !isRecord(value) ||
    typeof value.attemptId !== 'string' ||
    !Number.isSafeInteger(value.revision)
  )
    return;
  const fields = publicFields(value, {
    type: ['start', 'chunk', 'end'],
    attemptId: 'text',
    revision: 'integer',
  });
  if (value.type === 'start')
    return {
      ...fields,
      ...publicFields(value, { ...progress, startedAfterSeq: 'integer' }),
    };
  if (!Number.isSafeInteger(value.index)) return;
  if (value.type === 'chunk' && Number.isSafeInteger(value.time)) {
    const chunk = publicChunk(value.chunk);
    if (chunk)
      return { ...fields, index: value.index, time: value.time, chunk };
  }
  if (value.type === 'end' && isRecord(value.outcome)) {
    const { outcome } = value;
    if (outcome.kind === 'abandoned')
      return { ...fields, index: value.index, outcome: { kind: 'abandoned' } };
    if (
      outcome.kind === 'committed' &&
      Number.isSafeInteger(outcome.seq) &&
      (outcome.eventType === 'assistant/attempt' ||
        outcome.eventType === 'assistant/message')
    )
      return {
        ...fields,
        index: value.index,
        outcome: {
          kind: 'committed',
          eventType: outcome.eventType,
          seq: outcome.seq,
        },
      };
  }
}

function eventData(type: string, value: Record<string, unknown>) {
  switch (type) {
    case 'turn/start':
    case 'step/start':
    case 'step/end':
      return publicFields(value, progress);
    case 'turn/end': {
      const { reason } = value;
      if (!isRecord(reason)) return;
      let outcome: Record<string, unknown> = {
        kind: 'error',
        error: { code: 'UNKNOWN', message: modelFailure },
      };
      if (reason.kind === 'error')
        outcome = {
          kind: 'error',
          error: { code: 'UNKNOWN', message: modelFailure },
        };
      else if (reason.kind === 'aborted')
        outcome = { kind: 'aborted', reason: { kind: 'legacy' } };
      else if (
        ['completed', 'blocked', 'max-tokens', 'interrupted', 'forked'].some(
          (kind) => kind === reason.kind,
        )
      )
        outcome = { kind: reason.kind };
      return { ...publicFields(value, progress), reason: outcome };
    }
    case 'user/message': {
      const { source, id, role, content } = value;
      if (!isRecord(source) || source.kind !== 'rdws-context')
        return inboxList([value])[0];
      if (
        typeof id !== 'string' ||
        role !== 'user' ||
        !Array.isArray(content) ||
        content.length !== 1 ||
        !isRecord(content[0]) ||
        content[0].type !== 'text' ||
        typeof content[0].text !== 'string'
      )
        return;
      return {
        id,
        role,
        source: {
          kind: 'rdws-context',
          form: 'notice',
          summary: '当前需求业务状态',
          ...publicFields(source, {
            requirementId: 'text',
            contextVersion: 'integer',
            ...progress,
          }),
        },
        content: [{ type: 'text', text: content[0].text }],
      };
    }
    case 'assistant/attempt':
    case 'assistant/message': {
      const stream = publicAssistantRecords(value.stream);
      if (!stream) return;
      const base = { ...publicFields(value, progress), stream };
      if (type === 'assistant/attempt') return base;
      const { message } = value;
      if (
        !isRecord(message) ||
        typeof message.id !== 'string' ||
        !isRecord(message.source)
      )
        return;
      return {
        ...base,
        message: {
          id: message.id,
          role: 'assistant',
          source: {
            kind: 'model',
            ...publicFields(message.source, {
              provider: 'text',
              model: 'text',
            }),
          },
          content: messageBody(message.content),
        },
        ...(value.interrupted === true ? { interrupted: true } : {}),
        usage: usage(value.usage),
      };
    }
    case 'agent/inbox/spliced':
      if (
        Number.isSafeInteger(value.start) &&
        (value.target === 'next-turn' || value.target === 'next-step')
      )
        return {
          ...publicFields(value, {
            target: ['next-turn', 'next-step'],
            start: 'integer',
            removedCount: 'integer',
            outcome: ['canceled'],
          }),
          inserted: inboxList(value.inserted),
        };
      return;
    case 'model/selection':
      return publicFields(value, {
        provider: 'text',
        model: 'text',
        reasoningEffort: 'text',
      });
    case 'request/context':
      return publicFields(value, {
        provider: 'text',
        model: 'text',
        contextWindow: 'integer',
        systemPromptUpdate: ['in-history'],
      });
    case 'llm/retry':
      return {
        ...publicFields(value, {
          ...progress,
          retryId: 'text',
          provider: 'text',
          mode: ['normal', 'always'],
          retry: 'integer',
          maxRetries: 'integer',
          delayMs: 'finite',
        }),
        failure: { code: 'UNKNOWN', message: modelFailure },
      };
    case 'llm/retry-started':
      return publicFields(value, {
        ...progress,
        retryId: 'text',
        retry: 'integer',
      });
    case 'session/end-seed':
      return value.inherited === true ? { inherited: true } : {};
  }
}

export function publicHistoryEntry(entry: unknown) {
  if (!isRecord(entry) || entry.type !== 'event' || !isRecord(entry.event))
    return;
  const { event } = entry;
  if (
    typeof event.seq !== 'number' ||
    !Number.isSafeInteger(event.seq) ||
    event.seq < 0 ||
    !Number.isSafeInteger(event.time)
  )
    return;
  const { type, seq, time } = event;
  const placeholder = {
    type: 'event',
    event: { type: 'rdws/redacted', seq, time, ignorable: true, data: {} },
  };
  if (typeof type !== 'string' || !isRecord(event.data)) return placeholder;
  const data = eventData(type, event.data);
  if (!data) return placeholder;
  let surfaceOp: unknown;
  if (type === 'user/message' || type === 'assistant/message') {
    const operation = event.surfaceOp;
    if (operation === 'append') surfaceOp = operation;
    else if (
      isRecord(operation) &&
      operation.op === 'replace' &&
      Number.isSafeInteger(operation.startSeq) &&
      Number.isSafeInteger(operation.endSeq) &&
      Number(operation.startSeq) >= 0 &&
      Number(operation.endSeq) >= 0 &&
      Number(operation.startSeq) < seq &&
      Number(operation.endSeq) < seq
    )
      surfaceOp = {
        op: 'replace',
        startSeq: operation.startSeq,
        endSeq: operation.endSeq,
      };
    else return placeholder;
  }
  let sourceEventSeqs: number[] | undefined;
  if (
    type === 'user/message' &&
    Array.isArray(event.sourceEventSeqs) &&
    event.sourceEventSeqs.length > 0 &&
    event.sourceEventSeqs.every(
      (ref): ref is number =>
        Number.isSafeInteger(ref) && ref >= 0 && ref < seq,
    ) &&
    new Set(event.sourceEventSeqs).size === event.sourceEventSeqs.length
  )
    sourceEventSeqs = event.sourceEventSeqs;
  return {
    type: 'event',
    event: { type, seq, time, data, surfaceOp, sourceEventSeqs },
  };
}

export function publicHistory(value: unknown) {
  if (!Array.isArray(value)) return;
  const records = value.map(publicHistoryEntry);
  if (records.every((record) => record !== undefined)) return records;
}
