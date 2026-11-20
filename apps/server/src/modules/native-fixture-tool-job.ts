import { randomUUID } from 'node:crypto';
import { bodyHash } from '@rdws/dsh/access';
import { businessError, type Actor } from './business.ts';
import type {
  createOwnedWriteHandoff,
  WriteHandoffScope,
} from './write-handoff.ts';

type Broker = ReturnType<typeof createOwnedWriteHandoff>;
type Invocation = Parameters<Broker['execute']>[1];
type State = 'ready' | 'pending' | 'ok' | 'aborted' | 'failed' | 'unknown';
type Control = 'begin' | 'status' | 'cancel';

export const fixtureToolOperations = [
  'fixture-tool-begin',
  'fixture-tool-status',
  'fixture-tool-cancel',
] as const;

const denied = () => businessError(403, '原生工具作业未获授权');

export class NativeFixtureToolJob {
  readonly commandId = randomUUID();
  private readonly scope: WriteHandoffScope;
  private readonly invocation: Invocation;
  private readonly contextVersion: number;
  private readonly controller = new AbortController();
  private authorization?: {
    digest: string;
    expiresAt: number;
    current: () => boolean;
  };
  private state: State = 'ready';
  private pending?: Promise<void>;
  private reading = false;
  private readonly hostClosed = () => this.cancel();

  constructor(
    private readonly options: {
      scope: WriteHandoffScope;
      grant: { generation: string; contextVersion: number };
      broker: Broker;
      repositoryId: string;
      request: Invocation['request'];
      hostSignal: AbortSignal;
      onOutput?: Parameters<Broker['execute']>[2];
    },
  ) {
    if (process.env.RDWS_MODE !== 'test' || process.platform !== 'darwin')
      denied();
    this.scope = structuredClone(options.scope);
    this.contextVersion = options.grant.contextVersion;
    this.invocation = {
      generation: options.grant.generation,
      commandId: this.commandId,
      repositoryId: options.repositoryId,
      request: structuredClone(options.request),
    };
    options.hostSignal.addEventListener('abort', this.hostClosed, {
      once: true,
    });
    if (options.hostSignal.aborted) this.cancel();
  }

  offer(
    who: Actor,
    requirementId: string,
    sessionId: string,
    contextVersion: number | undefined,
    digest: string,
    expiresAt: number,
    current: () => boolean,
  ) {
    if (
      this.authorization ||
      this.controller.signal.aborted ||
      this.scope.who.userId !== who.userId ||
      this.scope.who.authSessionId !== who.authSessionId ||
      this.scope.requirementId !== requirementId ||
      this.scope.sessionId !== sessionId ||
      contextVersion !== this.contextVersion
    )
      return denied();
    this.authorization = { digest, expiresAt, current };
    return this.commandId;
  }

  private start() {
    if (this.state !== 'ready') return;
    const permit = this.authorization;
    const current = () =>
      permit &&
      !this.controller.signal.aborted &&
      !this.options.hostSignal.aborted &&
      permit.expiresAt > Date.now() &&
      permit.current();
    if (!current()) return denied();
    this.state = 'pending';
    this.pending = this.options.broker
      .execute(
        this.scope,
        this.invocation,
        this.options.onOutput,
        this.controller.signal,
        (contextVersion) => {
          if (!current() || contextVersion !== this.contextVersion)
            this.controller.abort();
        },
      )
      .then(
        (receipt) => {
          if (receipt.status !== 'finished') this.state = 'unknown';
          else {
            const { status } = receipt.result;
            this.state =
              status === 'ok' || status === 'aborted' ? status : 'failed';
          }
        },
        () => {
          this.state = 'unknown';
        },
      );
  }

  async control(
    operation: Control,
    input: Record<string, unknown>,
    canRead: (scope: WriteHandoffScope) => Promise<void>,
  ) {
    const { jobId, ...body } = input;
    if (
      jobId !== this.commandId ||
      !this.authorization ||
      bodyHash(body) !== this.authorization.digest
    )
      return denied();
    if (operation === 'begin') {
      this.start();
      return { accepted: true };
    }
    if (operation === 'cancel') {
      this.cancel();
      return { accepted: true };
    }
    if (this.reading) return denied();
    this.reading = true;
    try {
      await canRead(this.scope);
      return { state: this.state };
    } finally {
      this.reading = false;
    }
  }

  cancel() {
    this.controller.abort();
    if (this.state === 'ready') this.state = 'aborted';
  }

  async close() {
    this.cancel();
    this.options.hostSignal.removeEventListener('abort', this.hostClosed);
    await this.pending;
    if (this.state === 'unknown')
      throw new Error(
        'Native fixture execution could not be confirmed stopped',
      );
  }
}
