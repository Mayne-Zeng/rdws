import {
  createHmac,
  timingSafeEqual,
  randomUUID,
  createHash,
} from 'node:crypto';
export const LEASE_MS = 20_000;
export const RDWS_TOOL_GUARD_DENIAL = {
  name: 'RdwsToolGuardError',
  code: 'RDWS_TOOLS_DISABLED',
} as const;
export interface Grant {
  aud: string;
  purpose: 'browser' | 'create' | 'fork' | 'service' | 'image-prompt';
  issuedAt: number;
  expiresAt: number;
  nonce: string;
  userId?: string;
  authSessionId?: string;
  requirementId?: string;
  workspaceId?: string;
  cwd?: string;
  readSessionIds?: string[];
  ownSessionIds?: string[];
  operation?: string;
  bodyHash?: string;
  runId?: string;
  requestId?: string;
  hostGeneration?: string;
  sourceSessionId?: string;
  atSeq?: number;
  agentPreset?: string | null;
}
export function signGrant(
  key: string,
  input: Omit<Grant, 'issuedAt' | 'expiresAt' | 'nonce'>,
  now = Date.now(),
  lease = LEASE_MS,
) {
  const grant: Grant = {
    ...input,
    issuedAt: now,
    expiresAt: now + lease,
    nonce: randomUUID(),
  };
  const payload = Buffer.from(JSON.stringify(grant)).toString('base64url');
  return `${payload}.${createHmac('sha256', key).update(payload).digest('base64url')}`;
}
export function verifyGrant(
  key: string,
  token: unknown,
  aud: string,
  now = Date.now(),
): Grant | undefined {
  if (typeof token !== 'string' || token.length > 32000) return;
  const [payload, signature, ...rest] = token.split('.');
  if (!payload || !signature || rest.length) return;
  const expected = createHmac('sha256', key).update(payload).digest();
  const actual = Buffer.from(signature, 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
    return;
  try {
    const value = JSON.parse(
      Buffer.from(payload, 'base64url').toString(),
    ) as Grant;
    if (
      value.aud !== aud ||
      !['browser', 'create', 'fork', 'service', 'image-prompt'].includes(
        value.purpose,
      ) ||
      !Number.isFinite(value.issuedAt) ||
      !Number.isFinite(value.expiresAt) ||
      value.expiresAt <= now ||
      value.issuedAt > now + 1000 ||
      value.expiresAt - value.issuedAt > LEASE_MS ||
      value.expiresAt <= value.issuedAt ||
      typeof value.nonce !== 'string'
    )
      return;
    return value;
  } catch {
    return;
  }
}
export const bodyHash = (body: unknown) =>
  createHash('sha256').update(JSON.stringify(body)).digest('hex');
export type NativeImageType =
  'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
export const nativeImageType = (value: unknown): value is NativeImageType =>
  value === 'image/png' ||
  value === 'image/jpeg' ||
  value === 'image/webp' ||
  value === 'image/gif';
export const imageStageHash = (mediaType: NativeImageType, bytes: Uint8Array) =>
  bodyHash([
    mediaType,
    bytes.byteLength,
    createHash('sha256').update(bytes).digest('hex'),
  ]);
export const imagePromptHash = (request: Record<string, unknown>) =>
  bodyHash([
    request.sessionId,
    request.requestId,
    request.mode,
    (request.content as Record<string, unknown>[]).map((part) =>
      part.type === 'text' ? ['text', part.text] : ['file', part.receiptId],
    ),
  ]);

export const nativeLoginBinding = (
  authSessionId: string,
  projectId: string,
  requirementId: string,
) =>
  bodyHash(['rdws-native-login-v1', authSessionId, projectId, requirementId]);
const reads = new Set([
  'session/page',
  'session/events',
  'session/follow',
  'session/state',
  'session/observeState',
  'session/observeEvent',
  'session/observeProjections',
  'session/projections',
  'session/projection',
  'session/observeProjection',
  'session/summary',
]);
export const globals = new Set([
  'session/list',
  'session/control',
  'session/modelCatalog',
  'commands/list',
  'commands/catalog',
  'remoteAccess/follow',
  '$events',
]);
export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
export function onlyKeys(value: unknown, keys: string[]) {
  return (
    isRecord(value) && Object.keys(value).every((key) => keys.includes(key))
  );
}
export function targetSession(args: Record<string, unknown>) {
  const request = isRecord(args.request) ? args.request : args;
  if (typeof request.sessionId === 'string' && request.address === undefined)
    return request.sessionId;
  if (
    isRecord(request.address) &&
    request.sessionId === undefined &&
    request.address.kind === 'session' &&
    typeof request.address.sessionId === 'string' &&
    onlyKeys(request.address, ['kind', 'sessionId'])
  )
    return request.address.sessionId;
  return undefined;
}
const promptText = (part: unknown) =>
  isRecord(part) &&
  onlyKeys(part, ['type', 'text']) &&
  part.type === 'text' &&
  typeof part.text === 'string' &&
  part.text.length <= 8000 &&
  !part.text.trimStart().startsWith('/');

const imageReceipt = (part: unknown) =>
  isRecord(part) &&
  onlyKeys(part, ['type', 'receiptId']) &&
  part.type === 'file' &&
  typeof part.receiptId === 'string' &&
  /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(part.receiptId);

export function actionAllowed(
  grant: Grant,
  action: string,
  args: Record<string, unknown> = {},
  now = Date.now(),
) {
  if (grant.expiresAt <= now || grant.purpose === 'service') return false;
  if (grant.purpose === 'image-prompt') {
    const request = args.request;
    return (
      action === 'session/prompt' &&
      onlyKeys(args, ['request']) &&
      isRecord(request) &&
      onlyKeys(request, ['sessionId', 'requestId', 'mode', 'content']) &&
      grant.ownSessionIds?.length === 1 &&
      grant.ownSessionIds[0] === request.sessionId &&
      grant.readSessionIds?.length === 1 &&
      grant.readSessionIds[0] === request.sessionId &&
      typeof grant.requestId === 'string' &&
      request.requestId === grant.requestId &&
      request.mode === 'queue' &&
      Array.isArray(request.content) &&
      request.content.length > 1 &&
      request.content.length <= 8 &&
      request.content.filter(imageReceipt).length === 1 &&
      request.content.every((part) => promptText(part) || imageReceipt(part)) &&
      request.content.some(
        (part) => promptText(part) && part.text.trim().length > 0,
      ) &&
      grant.bodyHash === imagePromptHash(request)
    );
  }
  if (grant.purpose === 'fork')
    return (
      action === 'session/fork' &&
      onlyKeys(args, ['request']) &&
      onlyKeys(args.request, ['sessionId', 'atSeq', 'allowMigration']) &&
      isRecord(args.request) &&
      typeof grant.sourceSessionId === 'string' &&
      Number.isSafeInteger(grant.atSeq) &&
      Number(grant.atSeq) >= 0 &&
      args.request.sessionId === grant.sourceSessionId &&
      args.request.atSeq === grant.atSeq &&
      args.request.allowMigration === false
    );
  if (action === 'session/create')
    return (
      grant.purpose === 'create' &&
      onlyKeys(args, ['request']) &&
      isRecord(args.request) &&
      onlyKeys(args.request, ['workspaceId', 'agentPreset']) &&
      args.request.workspaceId === grant.workspaceId &&
      args.request.agentPreset === (grant.agentPreset ?? undefined)
    );
  if (grant.purpose !== 'browser') return false;
  if (globals.has(action))
    return (
      Object.keys(args).every(
        (key) => key === 'request' || key === '_request',
      ) &&
      (!args.request ||
        onlyKeys(args.request, ['includeArchived', 'limit', 'query']))
    );
  const id = targetSession(args);
  if (!id || !grant.readSessionIds?.includes(id)) return false;
  const request = isRecord(args.request) ? args.request : args;
  if (reads.has(action))
    return (
      onlyKeys(args, ['request', 'sessionId', 'signal']) &&
      onlyKeys(request, [
        'sessionId',
        'address',
        'beforeSeq',
        'throughSeq',
        'limit',
        'keys',
        'key',
        'projections',
        'cursor',
        'pageSize',
        'allowMigration',
        'afterSeq',
        'assistantStream',
        'activate',
        'maxMessages',
        'turnWindow',
      ])
    );
  if (action === 'session/cancel')
    return (
      !!grant.ownSessionIds?.includes(id) && onlyKeys(request, ['sessionId'])
    );
  if (action === 'session/prompt')
    return (
      !!grant.ownSessionIds?.includes(id) &&
      onlyKeys(request, [
        'sessionId',
        'content',
        'mode',
        'requestId',
        'clientTimeZone',
      ]) &&
      ['queue', 'steer'].includes(String(request.mode)) &&
      Array.isArray(request.content) &&
      request.content.length > 0 &&
      request.content.length <= 8 &&
      request.content.some(
        (part) =>
          isRecord(part) &&
          typeof part.text === 'string' &&
          part.text.trim().length > 0,
      ) &&
      request.content.every(promptText)
    );
  return false;
}
export function resourceRoles(grant: Grant) {
  if (grant.purpose === 'service') return [];
  const condition = ({
    action,
    args,
  }: {
    action: string;
    args?: Record<string, unknown>;
  }) =>
    actionAllowed(grant, action, args ?? {})
      ? { kind: 'allow' }
      : { kind: 'deny', reason: 'rdws-scope' };
  if (grant.purpose === 'image-prompt')
    return (grant.ownSessionIds ?? []).map((id) => ({
      role: {
        name: 'rdws-image-prompt',
        resource: 'session',
        actions: ['session/prompt'],
      },
      resource: { kind: 'session', id },
      condition,
    }));
  if (grant.purpose === 'create')
    return [
      {
        role: {
          name: 'rdws-create',
          resource: 'workspace',
          actions: ['session/create'],
        },
        resource: { kind: 'workspace', id: grant.workspaceId },
        condition,
      },
    ];
  if (grant.purpose === 'fork')
    return [
      {
        role: {
          name: 'rdws-fork',
          resource: 'session',
          actions: ['session/fork'],
        },
        resource: { kind: 'session', id: grant.sourceSessionId },
        condition,
      },
    ];
  const expiry = () =>
    Date.now() < grant.expiresAt
      ? { kind: 'allow' }
      : { kind: 'deny', reason: 'rdws-expired' };
  return [
    {
      role: { name: 'rdws-catalog', resource: 'global', actions: [...globals] },
      resource: { kind: 'global' },
      condition: expiry,
    },
    ...(grant.readSessionIds ?? []).map((id) => ({
      role: {
        name: 'rdws-read',
        resource: 'session',
        actions: [
          ...reads,
          'session/list',
          'session/control',
          'event:api-session/added',
          'event:api-session/removed',
          'event:api-session/status',
          'event:api-session/activity',
          'event:api-session/error',
        ],
      },
      resource: { kind: 'session', id },
      condition: expiry,
    })),
    ...(grant.ownSessionIds ?? []).map((id) => ({
      role: {
        name: 'rdws-own',
        resource: 'session',
        actions: ['session/prompt', 'session/cancel'],
      },
      resource: { kind: 'session', id },
      condition,
    })),
  ];
}
