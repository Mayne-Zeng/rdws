import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sessionRpc } from '@rdws/dsh/sessions';
import { NativeWebHost } from '@rdws/dsh/web';
import { expect, test, vi } from 'vitest';
import { capabilityRelease } from '../../dsh/host/presets.ts';
import { nativeReady } from '../helpers/native-ready.ts';

const files = [
  ['plugin', 'rdws/acceptance-session-guidance', 'session-guidance.mjs'],
  ['skill', 'rdws/requirement-acceptance-checklist', 'checklist.mjs'],
  ['mcp', 'rdws/requirement-readonly-mcp', 'requirement-readonly-mcp.mjs'],
] as const;
const expectedGuidance =
  '验收会话提示\n需要准备验收时，按当前需求的验收标准逐项列出已提供的验证证据及出处，并标出待验证项。以实际证据判断已验证结果，整理可供人工确认的草稿。';
const expectedChecklist = [
  '按当前需求的验收标准逐条整理清单草稿。',
  '每条列出验收标准、用户提供的测试证据及出处、已验证结果或待验证事项。',
  '标准或证据缺失时标为待验证，写明需要补充的材料或验证步骤，交由用户确认。',
].join('\n');
const empty = {
  guidance: [],
  userCatalog: [],
  modelPromptListsSkill: false,
  skill: null,
  offlineMcp: null,
  tools: [],
};

test.skipIf(process.platform !== 'darwin')(
  'isolated Native exposes precise acceptance candidates only in the bound preset and after restart',
  async () => {
    const root = await mkdtemp(
      join(await realpath(tmpdir()), 'rdws-acceptance-candidates-'),
    );
    const project = 'acceptance-fixture';
    const requirementId = randomUUID();
    const neighborId = randomUUID();
    const templateId = randomUUID();
    const config = join(root, 'config/projects', project, 'dsh');
    const profile = join(config, 'profiles', 'rdws');
    const request = join(root, 'observe.json');
    const response = join(root, 'observed.json');
    const observer = fileURLToPath(
      new URL(
        '../fixtures/rdws-acceptance-candidates-observer.mjs',
        import.meta.url,
      ),
    );
    let connections = 0;
    const supplier = createServer((socket) => {
      ++connections;
      socket.destroy();
    });
    let host: NativeWebHost | undefined;
    try {
      supplier.listen(0, '127.0.0.1');
      await once(supplier, 'listening');
      const endpoint = `http://127.0.0.1:${(supplier.address() as { port: number }).port}/v1`;
      const release = await Promise.all(
        files.map(async ([kind, reference, file]) => {
          const modulePath = await realpath(
            fileURLToPath(
              new URL(
                '../../dsh/candidates/requirement-acceptance/' + file,
                import.meta.url,
              ),
            ),
          );
          const sha256 = createHash('sha256')
            .update(await readFile(modulePath))
            .digest('hex');
          return { kind, reference, revision: 'fixture-1', modulePath, sha256 };
        }),
      );
      expect(
        release.some(({ reference }) =>
          capabilityRelease.some((entry) => entry.reference === reference),
        ),
      ).toBe(false);
      const wrongHashInput = join(root, 'wrong-hash.mjs');
      await writeFile(
        wrongHashInput,
        Buffer.concat([
          await readFile(release[0]!.modulePath),
          Buffer.from('\n'),
        ]),
        { mode: 0o600 },
      );
      const wrongHash = {
        ...release[0]!,
        reference: 'fixture/wrong-hash',
        modulePath: wrongHashInput,
      };
      const capabilities = release.map(({ kind, reference, revision }) => ({
        kind,
        reference,
        revision,
      }));
      await mkdir(profile, { recursive: true, mode: 0o700 });
      await writeFile(
        join(config, '.credentials.yaml'),
        'version: 1\nrefs: {}\n',
        { mode: 0o600 },
      );
      await writeFile(
        join(profile, 'cordis.patch.yml'),
        JSON.stringify([
          { id: 'session-title-llm', disabled: true },
          {
            id: 'llm-pi-ai',
            config: {
              providers: {
                'rdws-glm': {
                  api: 'openai-completions',
                  baseURL: endpoint,
                  models: [{ id: 'paused-acceptance-fixture' }],
                },
              },
            },
          },
          {
            insert: [
              {
                id: 'acceptance-observer',
                name: observer,
                config: { request, response },
              },
            ],
          },
        ]),
        { mode: 0o600 },
      );
      const makeHost = () =>
        new NativeWebHost(
          root,
          config,
          project,
          [...release, wrongHash],
          'paused',
        );
      const native = (host = makeHost());
      const owner = { userId: randomUUID(), authSessionId: randomUUID() };
      const workspace = await native.workspace(requirementId, '需求验收准备');
      const neighbor = await native.workspace(
        neighborId,
        'Unbound synthetic requirement',
      );
      const create = async (
        requirementId: string,
        workspace: { cwd: string; workspaceId: string },
        agentPreset?: string,
      ) => {
        const { sessionId } = (await sessionRpc(
          native,
          {
            ...owner,
            ...workspace,
            requirementId,
            purpose: 'create',
            agentPreset: agentPreset ?? null,
          },
          'session/create',
          {
            workspaceId: workspace.workspaceId,
            ...(agentPreset && { agentPreset }),
          },
        )) as { sessionId: string };
        return { sessionId, cwd: workspace.cwd };
      };
      const defaultSession = await create(requirementId, workspace);
      const outsideSession = await create(neighborId, neighbor);
      const preset = await native.preparePreset(requirementId, {
        templateId,
        revision: 1,
        capabilities,
      });
      expect(preset.capabilities.map(({ sha256 }) => sha256).sort()).toEqual(
        release.map(({ sha256 }) => sha256).sort(),
      );
      const boundSession = await create(requirementId, workspace, preset.id);
      const wrongScope = await native.fetch(
        '/api/session/create',
        {
          ...owner,
          ...neighbor,
          requirementId: neighborId,
          purpose: 'create',
          agentPreset: preset.id,
        },
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            type: 'client-request',
            method: 'session/create',
            rpcId: randomUUID(),
            payload: {
              args: {
                request: {
                  workspaceId: neighbor.workspaceId,
                  agentPreset: preset.id,
                },
              },
            },
          }),
        },
      );
      expect(wrongScope.status).toBe(403);
      await wrongScope.body?.cancel();
      await expect(
        native.preparePreset(requirementId, {
          templateId,
          revision: 2,
          capabilities: [
            {
              kind: wrongHash.kind,
              reference: wrongHash.reference,
              revision: wrongHash.revision,
            },
          ],
        }),
      ).rejects.toThrow('Native control unavailable');
      const expected = {
        guidance: [expectedGuidance],
        userCatalog: [
          {
            name: 'requirement-acceptance-checklist',
            description:
              '需求验收清单。按当前需求的验收标准和用户提供的测试证据整理草稿。',
            modelInvocable: false,
          },
        ],
        modelPromptListsSkill: false,
        skill: {
          invocation: { modelInvocable: false, userInvocable: true },
          content: expectedChecklist,
        },
        offlineMcp: {
          name: 'rdws-requirement-readonly-mcp',
          title: '需求资料只读',
          protocol: 'mcp',
          transport: null,
          source: {
            method: 'GET',
            route: '/api/requirements/:id',
            scope: 'current-requirement',
            responseKey: 'requirement',
            fields: ['title', 'description', 'acceptance'],
          },
        },
        tools: [],
      };
      async function inspect() {
        const id = randomUUID();
        const pending = request + '.next';
        await writeFile(
          pending,
          JSON.stringify({
            id,
            sessions: [boundSession, defaultSession, outsideSession],
          }),
          { mode: 0o600 },
        );
        await rename(pending, request);
        const report = await vi.waitFor(
          async () => {
            const report = JSON.parse(await readFile(response, 'utf8')) as {
              id: string;
              values: unknown[];
            };
            expect(report.id).toBe(id);
            return report;
          },
          { timeout: 5000, interval: 60 },
        );
        expect(report.values).toEqual([expected, empty, empty]);
      }
      await inspect();
      expect(connections).toBe(0);
      const running = await nativeReady(root, project);
      await unlink(request);
      await native.close();
      expect(() => process.kill(running.pid, 0)).toThrow(
        expect.objectContaining({ code: 'ESRCH' }),
      );
      const recovered = (host = makeHost());
      await recovered.ensurePreset(requirementId, preset.id);
      expect((await nativeReady(root, project)).generation).not.toBe(
        running.generation,
      );
      await inspect();
      await recovered.close();
      host = undefined;
      expect(connections).toBe(0);
    } finally {
      try {
        await host?.close();
        await rm(root, { recursive: true, force: true });
      } finally {
        if (supplier.listening)
          await new Promise<void>((resolve) => supplier.close(() => resolve()));
      }
    }
  },
  30_000,
);
