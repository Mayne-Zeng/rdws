import {
  createHmac,
  timingSafeEqual,
  randomUUID,
  createHash,
} from 'node:crypto';
export const LEASE_MS = 20_000;
export interface Grant {
  aud: string;
  purpose: 'browser' | 'create' | 'fork' | 'service';
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
      !['browser', 'create', 'fork', 'service'].includes(value.purpose) ||
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
export function actionAllowed(
  grant: Grant,
  action: string,
  args: Record<string, unknown> = {},
  now = Date.now(),
) {
  if (grant.expiresAt <= now || grant.purpose === 'service') return false;
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
      request.content.every(
        (part) =>
          isRecord(part) &&
          onlyKeys(part, ['type', 'text']) &&
          part.type === 'text' &&
          typeof part.text === 'string' &&
          part.text.length <= 8000 &&
          !part.text.trimStart().startsWith('/'),
      )
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
