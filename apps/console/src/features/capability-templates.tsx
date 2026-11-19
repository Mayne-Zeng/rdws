import { useEffect, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Loading } from 'tdesign-react';
import {
  capabilityKey,
  capabilityKindLabels,
  type CapabilityTemplateList,
  type CapabilityTemplateManagement,
  type CapabilityVersion,
  type ManagementCommand,
  type ManagementResult,
} from '@rdws/contracts';
import { api } from '../lib/ui.tsx';

type Save = Extract<ManagementCommand, { kind: 'capability.template.save' }>;
type Draft = Pick<
  Save,
  'templateId' | 'expectedRevision' | 'name' | 'description' | 'capabilities'
>;
type Template = CapabilityTemplateList['templates'][number];
type Editor = {
  locked: boolean;
  save: (input: Omit<Save, 'commandId'>) => Promise<void>;
  pending?: ManagementCommand;
  result?: {
    projectId: string;
    status: NonNullable<ManagementResult['template']>['status'];
  };
};
function label(item: CapabilityVersion) {
  return `${capabilityKindLabels[item.kind]} · ${item.reference} · ${item.revision}`;
}

export function CapabilityTemplates({
  projectId,
  editor,
}: {
  projectId: string;
  editor?: Editor;
}) {
  const mode = editor ? 'management' : 'member';
  const query = useQuery({
    queryKey: ['administration', 'capability-templates', mode, projectId],
    queryFn: ({ signal }) =>
      api<CapabilityTemplateList | CapabilityTemplateManagement>(
        `${editor ? '/api/management/projects' : '/api/projects'}/${projectId}/capability-templates`,
        { signal },
      ),
  });
  const [draft, setDraft] = useState<Draft>();
  const pending = editor?.pending;
  useEffect(() => {
    if (
      pending?.kind === 'capability.template.save' &&
      pending.projectId === projectId &&
      Array.isArray(pending.capabilities)
    ) {
      const { templateId, expectedRevision, name, description, capabilities } =
        pending;
      setDraft({
        templateId,
        expectedRevision,
        name,
        description,
        capabilities,
      });
    }
  }, [pending, projectId]);
  const outcome = editor?.result;
  useEffect(() => {
    if (
      outcome?.projectId === projectId &&
      (outcome.status === 'saved' || outcome.status === 'unchanged')
    )
      setDraft(undefined);
  }, [outcome, projectId]);

  function edit(row: Template) {
    setDraft({
      templateId: row.templateId,
      expectedRevision: row.revision,
      name: row.name,
      description: row.description,
      capabilities: row.capabilities.map(({ kind, reference, revision }) => ({
        kind,
        reference,
        revision,
      })),
    });
  }
  const options =
    query.data && 'options' in query.data ? query.data.options : [];
  const active = new Set(options.map(capabilityKey));
  const unavailable =
    draft?.capabilities.filter((item) => !active.has(capabilityKey(item))) ??
    [];
  const picked = new Set(draft?.capabilities.map(capabilityKey));
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      !editor ||
      editor.locked ||
      !draft?.name.trim() ||
      !query.data ||
      query.isError ||
      unavailable.length
    )
      return;
    void editor.save({ kind: 'capability.template.save', ...draft, projectId });
  }

  return (
    <section
      className="document-section"
      aria-labelledby="capability-templates-title"
    >
      {editor ? (
        <h2 id="capability-templates-title">项目能力模板</h2>
      ) : (
        <h1 id="capability-templates-title">能力模板</h1>
      )}
      {query.isPending && <Loading text="正在读取能力模板" />}
      {query.isError && (
        <div className="inline-feedback">
          <Alert theme="error" message="能力模板读取失败。" />
          <Button
            tag="button"
            variant="outline"
            loading={query.isFetching}
            onClick={() => void query.refetch()}
          >
            重试读取模板
          </Button>
        </div>
      )}
      {query.data && !query.isError && (
        <>
          {editor && (
            <Button
              tag="button"
              disabled={editor.locked}
              onClick={() =>
                setDraft({ name: '', description: '', capabilities: [] })
              }
            >
              新建能力模板
            </Button>
          )}
          {query.data.templates.length === 0 && (
            <p className="muted">暂无能力模板。</p>
          )}
          <div role="list" aria-label="模板清单">
            {query.data.templates.map((row) => (
              <div
                className="context-task"
                role="listitem"
                key={row.templateId}
              >
                <div className="prose-text">
                  <strong>{row.name}</strong>
                  <p className="muted">
                    第 {row.revision} 版
                    {row.capabilities.some((item) => !item.approved)
                      ? ' · 需修订'
                      : ''}
                  </p>
                  {row.description && <p>{row.description}</p>}
                  {row.capabilities.map((item) => (
                    <p className="muted" key={capabilityKey(item)}>
                      {label(item)}
                      {item.approved ? '' : ' · 已停用'}
                    </p>
                  ))}
                </div>
                {editor && (
                  <Button
                    tag="button"
                    variant="outline"
                    disabled={editor.locked}
                    onClick={() => edit(row)}
                  >
                    编辑模板
                  </Button>
                )}
              </div>
            ))}
          </div>
        </>
      )}
      {editor && draft && (
        <form className="business-form" onSubmit={submit}>
          <fieldset
            className="form-section task-fields"
            disabled={editor.locked || query.isError || !query.data}
          >
            <legend>
              {draft.expectedRevision
                ? `编辑第 ${draft.expectedRevision} 版`
                : '模板信息'}
            </legend>
            <label htmlFor="capability-template-name">模板名称</label>
            <input
              id="capability-template-name"
              value={draft.name}
              maxLength={80}
              required
              onChange={(event) =>
                setDraft({ ...draft, name: event.target.value })
              }
            />
            <label htmlFor="capability-template-description">模板说明</label>
            <textarea
              id="capability-template-description"
              value={draft.description}
              maxLength={1000}
              onChange={(event) =>
                setDraft({ ...draft, description: event.target.value })
              }
            />
            <p className="muted">审核版本</p>
            {options.length === 0 && unavailable.length === 0 && (
              <p className="muted">暂无可选审核版本。</p>
            )}
            {[...options, ...unavailable].map((item) => {
              const key = capabilityKey(item);
              return (
                <label key={key} className="prose-text">
                  <input
                    type="checkbox"
                    checked={picked.has(key)}
                    disabled={!picked.has(key) && picked.size >= 64}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        capabilities: event.target.checked
                          ? [...draft.capabilities, item]
                          : draft.capabilities.filter(
                              (value) => capabilityKey(value) !== key,
                            ),
                      })
                    }
                  />{' '}
                  {label(item)}
                  {active.has(key) ? '' : ' · 已停用'}
                </label>
              );
            })}
            {unavailable.length > 0 && (
              <p className="muted">取消已停用版本后可以保存。</p>
            )}
            <div className="form-actions">
              <Button
                tag="button"
                type="submit"
                disabled={!draft.name.trim() || unavailable.length > 0}
              >
                保存模板版本
              </Button>
              <Button
                tag="button"
                variant="text"
                onClick={() => setDraft(undefined)}
              >
                取消编辑
              </Button>
            </div>
          </fieldset>
        </form>
      )}
    </section>
  );
}
