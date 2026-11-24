import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Loading } from 'tdesign-react';
import { authClient } from '../lib/auth.ts';
import { api } from '../lib/ui.tsx';

// §11.23 E1/E2: the changes view renders evidence fields only. A
// 「已提交」 badge appears exactly when the three pieces of evidence
// exist (a parseable commit hash, the append-only snapshot row and the
// finished write.execute receipt) and the anchor recomputes; a
// 「已交付」 badge appears only when the committed evidence is complete
// AND a merge record exists — a merge row without its execution evidence
// renders no badge at all. There is no
// committed or delivered boolean anywhere in the DTO (E2), and this
// view has no initiation state that could read as committed (E3).
export type DeliveryChanges = {
  current: {
    repositoryId: string;
    head: string;
    status:
      { entries: { path: string; code: string }[] } | { omitted: 'protected' };
    diff:
      { text: string; total: number; next?: string } | { omitted: 'protected' };
  };
  historical: {
    repositoryId: string;
    candidates: {
      snapshotSeq: number;
      commitHash: string;
      parentHead: string;
      baseCommit: string;
      paths: { path: string; type: string; digest: string | null }[];
      contentDigest: string;
      messageSha256: string;
      commandId: string;
      committedBy: string;
      recordedAt: string;
      anchor: { digest: string; matches: boolean };
      receipt: { commandId: string; state: string } | null;
      merges: {
        environment: string;
        cherryPickCommit: string;
        mergeCommit: string | null;
      }[];
    }[];
  };
};

const committedEvidence = (candidate: {
  commitHash: string;
  anchor: { matches: boolean };
  receipt: { commandId: string; state: string } | null;
}) =>
  /^[0-9a-f]{40}$/.test(candidate.commitHash) &&
  candidate.anchor.matches &&
  candidate.receipt !== null &&
  candidate.receipt.state === 'finished';

export function RequirementChanges({ id }: { id: string }) {
  const userId = authClient.useSession().data?.user.id;
  const repositoryId = 'app';
  const [cursor, setCursor] = useState<string>();
  const base =
    '/api/requirements/' +
    encodeURIComponent(id) +
    '/changes?repositoryId=' +
    encodeURIComponent(repositoryId);
  const query = useQuery({
    queryKey: ['requirement-changes', userId, id],
    queryFn: ({ signal }) => api<DeliveryChanges>(base, { signal }),
    enabled: !!userId,
    refetchOnMount: 'always',
  });
  const continued = useQuery({
    queryKey: ['requirement-changes-page', userId, id, cursor],
    queryFn: ({ signal }) =>
      api<DeliveryChanges>(
        base + '&cursor=' + encodeURIComponent(cursor ?? ''),
        { signal },
      ),
    enabled: !!userId && cursor !== undefined,
  });
  if (query.isPending) return <Loading text="正在读取变更" />;
  if (query.isError)
    return (
      <section
        className="document-section info-panel"
        aria-labelledby="requirement-changes"
      >
        <div className="panel-heading">
          <h2 id="requirement-changes" tabIndex={-1}>
            变更查看
          </h2>
        </div>
        <Alert
          theme="error"
          message="变更查看暂不可用（需要工作树与执行通道就绪）。"
        />
      </section>
    );
  const { current, historical } = query.data;
  const diffView = current.diff;
  const nextCursor = 'next' in diffView ? diffView.next : undefined;
  const continuedText =
    cursor !== undefined &&
    continued.data &&
    'text' in continued.data.current.diff
      ? continued.data.current.diff.text
      : '';
  return (
    <section
      className="document-section info-panel"
      aria-labelledby="requirement-changes"
    >
      <div className="panel-heading">
        <h2 id="requirement-changes" tabIndex={-1}>
          变更查看
        </h2>
        <span className="pill">采样 head {current.head.slice(0, 12)}</span>
      </div>
      <h3>当前候选</h3>
      {'omitted' in current.status ? (
        <Alert theme="warning" message="status 含保护位置，整份无正文。" />
      ) : current.status.entries.length === 0 ? (
        <p className="muted">工作树与最近一次采样一致，无未提交变更。</p>
      ) : (
        <ul data-testid="changes-status">
          {current.status.entries.map((entry) => (
            <li key={entry.code + entry.path}>
              <code>{entry.code}</code> {entry.path}
            </li>
          ))}
        </ul>
      )}
      <h3>diff</h3>
      {'omitted' in current.diff ? (
        <Alert theme="warning" message="diff 含保护位置，整份无正文。" />
      ) : (
        <pre className="prose-text" data-testid="changes-diff">
          {'text' in current.diff ? current.diff.text + continuedText : ''}
        </pre>
      )}
      {nextCursor !== undefined && (
        <Button
          onClick={() => setCursor(nextCursor)}
          aria-label="读取下一页 diff"
        >
          读取下一页
        </Button>
      )}
      <div className="panel-heading">
        <h3>历史候选</h3>
      </div>
      {historical.candidates.length === 0 ? (
        <p className="muted">暂无已提交候选。</p>
      ) : (
        historical.candidates.map((candidate) => (
          <article
            key={candidate.commitHash + ':' + candidate.snapshotSeq}
            data-testid="delivery-candidate"
          >
            <dl className="detail-grid">
              <dt>候选</dt>
              <dd>
                #{candidate.snapshotSeq}{' '}
                {committedEvidence(candidate) && (
                  <span className="pill">已提交</span>
                )}
                {committedEvidence(candidate) &&
                  candidate.merges.length > 0 && (
                    <span className="pill">已交付</span>
                  )}
              </dd>
              <dt>提交</dt>
              <dd>
                <code>{candidate.commitHash}</code>
              </dd>
              <dt>冻结基线</dt>
              <dd>
                <code>{candidate.baseCommit}</code>
              </dd>
              <dt>路径数</dt>
              <dd>{candidate.paths.length}</dd>
            </dl>
          </article>
        ))
      )}
    </section>
  );
}
