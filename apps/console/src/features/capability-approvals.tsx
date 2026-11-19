import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Loading } from 'tdesign-react';
import type {
  CapabilityApprovalList,
  CapabilityKind,
  ManagementCommand,
} from '@rdws/contracts';
import { capabilityKindLabels } from '@rdws/contracts';
import { api } from '../lib/ui.tsx';
type ApprovalIntent = Omit<
  Extract<ManagementCommand, { kind: 'capability.approval' }>,
  'commandId'
>;

export function CapabilityApprovals({
  locked,
  change,
}: {
  locked: boolean;
  change: (input: ApprovalIntent) => Promise<void>;
}) {
  const query = useQuery({
    queryKey: ['administration', 'capability-approvals'],
    queryFn: ({ signal }) =>
      api<CapabilityApprovalList>('/api/management/capability-approvals', {
        signal,
      }),
  });
  const [kind, setKind] = useState<CapabilityKind | ''>('');
  const [reference, setReference] = useState('');
  const [revision, setRevision] = useState('');
  function register(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!kind || locked || !query.data || query.isError) return;
    void change({
      kind: 'capability.approval',
      capabilityKind: kind,
      reference: reference.trim(),
      revision: revision.trim(),
      approved: true,
    });
  }

  return (
    <section
      className="document-section"
      aria-labelledby="capability-approvals-title"
    >
      <h2 id="capability-approvals-title">平台能力白名单</h2>
      <p className="muted">
        登记已审核的能力标识和版本。会话执行沿用现有权限。
      </p>
      {query.isPending && <Loading text="正在读取白名单" />}
      {query.isError && (
        <div className="inline-feedback">
          <Alert
            theme="error"
            message="白名单读取失败，重试读取可核对当前状态。"
          />
          <Button
            tag="button"
            variant="outline"
            loading={query.isFetching}
            onClick={() => void query.refetch()}
          >
            重试读取白名单
          </Button>
        </div>
      )}
      {query.data && !query.isError && (
        <>
          <form className="business-form" onSubmit={register}>
            <fieldset className="form-section task-fields" disabled={locked}>
              <label htmlFor="capability-kind">能力类别</label>
              <select
                id="capability-kind"
                required
                value={kind}
                onChange={(event) =>
                  setKind(event.target.value as CapabilityKind | '')
                }
              >
                <option value="">选择类别</option>
                {Object.entries(capabilityKindLabels).map(([id, label]) => (
                  <option key={id} value={id}>
                    {label}
                  </option>
                ))}
              </select>
              <label htmlFor="capability-reference">来源／能力标识</label>
              <input
                id="capability-reference"
                value={reference}
                maxLength={160}
                required
                placeholder="例如 platform/summary-skill"
                onChange={(event) => setReference(event.target.value)}
              />
              <label htmlFor="capability-revision">审核版本</label>
              <input
                id="capability-revision"
                value={revision}
                maxLength={128}
                required
                placeholder="例如 1.2.0"
                onChange={(event) => setRevision(event.target.value)}
              />
              <div className="form-actions">
                <Button
                  tag="button"
                  type="submit"
                  disabled={
                    locked || !kind || !reference.trim() || !revision.trim()
                  }
                >
                  登记审核版本
                </Button>
              </div>
            </fieldset>
          </form>
          {query.data.approvals.length ? (
            <div role="list" aria-label="审核版本清单">
              {query.data.approvals.map((entry) => (
                <div
                  className="context-task"
                  role="listitem"
                  key={JSON.stringify([
                    entry.kind,
                    entry.reference,
                    entry.revision,
                  ])}
                >
                  <div className="prose-text">
                    <strong>{entry.reference}</strong>
                    <p className="muted">
                      {capabilityKindLabels[entry.kind]} · {entry.revision} ·{' '}
                      {entry.approved ? '已登记' : '已停用'}
                    </p>
                  </div>
                  {entry.approved && (
                    <Button
                      tag="button"
                      variant="outline"
                      disabled={locked}
                      onClick={() =>
                        void change({
                          kind: 'capability.approval',
                          capabilityKind: entry.kind,
                          reference: entry.reference,
                          revision: entry.revision,
                          approved: false,
                        })
                      }
                    >
                      停用审核版本
                    </Button>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p className="muted">暂无审核登记。</p>
          )}
        </>
      )}
    </section>
  );
}
