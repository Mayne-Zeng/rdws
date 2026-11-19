import { isRecord } from './access.ts';

const fieldTypes = {
  text: (value: unknown) => typeof value === 'string',
  integer: (value: unknown) => Number.isSafeInteger(value),
  nullableInteger: (value: unknown) =>
    value === null || Number.isSafeInteger(value),
  flag: (value: unknown) => typeof value === 'boolean',
};

export function publicFields(
  value: Record<string, unknown>,
  fields: Record<string, keyof typeof fieldTypes | readonly string[]>,
) {
  return Object.fromEntries(
    Object.entries(fields).flatMap(([key, type]) => {
      const entry = value[key];
      const allowed =
        typeof type === 'string'
          ? fieldTypes[type](entry)
          : typeof entry === 'string' && type.includes(entry);
      return allowed ? [[key, entry]] : [];
    }),
  );
}

const mediaTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

function publicContent(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).flatMap<Record<string, unknown>>((part) => {
    if (part.type === 'text')
      return typeof part.text === 'string'
        ? [{ type: 'text', text: part.text }]
        : [];
    if (
      (part.type !== 'image' && part.type !== 'file') ||
      !isRecord(part.attachment)
    )
      return [];
    const { attachment } = part;
    if (
      typeof attachment.attachmentId !== 'string' ||
      typeof attachment.bytes !== 'number' ||
      !Number.isSafeInteger(attachment.bytes) ||
      attachment.bytes < 0
    )
      return [];
    const shared = {
      attachmentId: 'text',
      name: 'text',
      bytes: 'integer',
    } as const;
    if (part.type === 'file')
      return typeof attachment.name === 'string'
        ? [{ type: 'file', attachment: publicFields(attachment, shared) }]
        : [];
    if (
      typeof attachment.mediaType !== 'string' ||
      !mediaTypes.includes(attachment.mediaType) ||
      !Number.isSafeInteger(attachment.width) ||
      !Number.isSafeInteger(attachment.height)
    )
      return [];
    const original = attachment.originalDimensions;
    return [
      {
        type: 'image',
        ...(part.offloaded === true ? { offloaded: true } : {}),
        attachment: {
          ...publicFields(attachment, {
            ...shared,
            mediaType: mediaTypes,
            width: 'integer',
            height: 'integer',
          }),
          ...(isRecord(original) &&
          Number.isSafeInteger(original.width) &&
          Number.isSafeInteger(original.height)
            ? {
                originalDimensions: {
                  width: original.width,
                  height: original.height,
                },
              }
            : {}),
        },
      },
    ];
  });
}

export function publicSessionState(value: unknown) {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.cursor) ||
    typeof value.active !== 'boolean' ||
    typeof value.running !== 'boolean' ||
    !Array.isArray(value.pendingInput) ||
    (value.queue !== null && !Array.isArray(value.queue))
  )
    return;
  return {
    cursor: value.cursor,
    active: value.active,
    running: value.running,
    pendingInput: value.pendingInput.filter(
      (item) => item === 'approval' || item === 'question' || item === 'other',
    ),
    queue:
      value.queue === null
        ? null
        : value.queue.filter(isRecord).flatMap((item) => {
            const fields = publicFields(item, {
              id: 'text',
              placement: ['queued', 'steering', 'context'],
              rpcId: 'text',
            });
            return fields.id === undefined || fields.placement === undefined
              ? []
              : [
                  {
                    ...fields,
                    content: publicContent(item.content),
                  },
                ];
          }),
  };
}

function modelChoice(value: unknown) {
  if (value === null) return null;
  if (isRecord(value))
    return publicFields(value, {
      provider: 'text',
      model: 'text',
      reasoningEffort: 'text',
    });
}

function inboxList(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).flatMap((message) => {
    if (
      typeof message.id !== 'string' ||
      message.role !== 'user' ||
      !isRecord(message.source)
    )
      return [];
    const source = publicFields(message.source, {
      kind: ['user', 'retry', 'context', 'model-selection'],
      rpcId: 'text',
      clientTimeZone: 'text',
    });
    if (source.kind === undefined) return [];
    return [
      {
        id: message.id,
        role: 'user',
        source,
        content: publicContent(message.content),
      },
    ];
  });
}

function projectionValue(key: string, value: unknown): unknown {
  if (key === 'title' || key === 'agentPreset' || key === 'workingDirectory')
    return value === null || typeof value === 'string' ? value : undefined;
  if (key === 'conversationContinuation')
    return value === null || Number.isSafeInteger(value) ? value : undefined;
  if (!isRecord(value)) return;
  switch (key) {
    case 'modelSelection':
      return {
        next: modelChoice(value.next),
        lastUsed: modelChoice(value.lastUsed),
      };
    case 'inbox':
      return {
        'next-step': inboxList(value['next-step']),
        'next-turn': inboxList(value['next-turn']),
      };
    case 'sessionListMetadata':
      return publicFields(value, {
        blank: 'flag',
        lastPromptAt: 'nullableInteger',
      });
    case 'imageLimits':
      return {
        ...publicFields(value, {
          maxImageBytes: 'integer',
          maxImagesPerMessage: 'integer',
          maxMessageImageBytes: 'integer',
          maxImagePixels: 'integer',
          maxImageDimension: 'integer',
        }),
        mediaTypes: Array.isArray(value.mediaTypes)
          ? value.mediaTypes.filter((type) => mediaTypes.includes(type))
          : [],
      };
  }
}

function projectionValues(value: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, entry]) => {
      const result = projectionValue(key, entry);
      return result === undefined ? [] : [[key, result]];
    }),
  );
}

export function publicProjectionBaseline(value: unknown) {
  if (!isRecord(value) || !isRecord(value.values)) return;
  const fields = publicFields(value, {
    asOfSeq: 'integer',
    kind: ['cached', 'sequenced', 'migration-required'],
  });
  if (
    (value.kind !== undefined && fields.kind === undefined) ||
    (fields.kind !== 'migration-required' && fields.asOfSeq === undefined)
  )
    return;
  return {
    ...fields,
    values: projectionValues(value.values),
  };
}

export function publicSessionSummary(value: unknown) {
  if (
    !isRecord(value) ||
    typeof value.sessionId !== 'string' ||
    typeof value.agentAvailable !== 'boolean' ||
    typeof value.running !== 'boolean' ||
    typeof value.blank !== 'boolean' ||
    !Number.isSafeInteger(value.updatedAt)
  )
    return;
  return {
    ...publicFields(value, {
      agentAvailable: 'flag',
      formatStatus: ['current', 'migration-required'],
      sessionId: 'text',
      updatedAt: 'integer',
      running: 'flag',
      blank: 'flag',
      parentSessionId: 'text',
      origin: ['subagent'],
      cwd: 'text',
    }),
    projections: publicProjectionBaseline(value.projections),
  };
}

export function publicControlProjection(value: Record<string, unknown>) {
  if (
    value.type === 'baseline' &&
    isRecord(value.value) &&
    isRecord(value.value.projections)
  )
    return {
      type: 'baseline',
      value: {
        projections: Object.fromEntries(
          Object.entries(value.value.projections).flatMap(([id, entry]) => {
            const baseline = publicProjectionBaseline(entry);
            return baseline ? [[id, baseline]] : [];
          }),
        ),
      },
    };
  if (
    value.type === 'projection' &&
    Number.isSafeInteger(value.seq) &&
    Array.isArray(value.changes)
  )
    return {
      ...publicFields(value, {
        type: ['projection'],
        sessionId: 'text',
        seq: 'integer',
      }),
      changes: value.changes.filter(isRecord).flatMap(({ key, val }) => {
        if (typeof key !== 'string') return [];
        const projected = projectionValue(key, val);
        return projected === undefined ? [] : [{ key, val: projected }];
      }),
    };
}
