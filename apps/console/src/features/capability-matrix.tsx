import { useMemo } from 'react';
import {
  capabilityMatrix,
  capabilitySubjectLabels,
  capabilitySubjects,
  roles,
  type CapabilitySubject,
} from '@rdws/contracts';

const subjectOfRole: Record<(typeof roles)[number], CapabilitySubject> = {
  project_admin: 'project_admin',
  requirement_manager: 'requirement_manager',
  developer: 'developer',
  tester: 'tester',
};
// Read-only reference: what each role may do in the workbench. The server
// decides every request; conditions name what it will additionally check.
export function CapabilityMatrixSection({
  projectRoles,
}: {
  projectRoles: string[];
}) {
  const subjects = useMemo(
    () =>
      [
        ...new Set(
          projectRoles
            .map((role) => subjectOfRole[role as (typeof roles)[number]])
            .filter(Boolean),
        ),
      ] as CapabilitySubject[],
    [projectRoles],
  );
  return (
    <>
      <section className="document-section" aria-labelledby="capability-matrix">
        <div className="section-heading">
          <div>
            <h2 id="capability-matrix">能力矩阵</h2>
            <p className="muted">
              各角色在工作台可以执行的操作；具体以服务端判定为准。
            </p>
          </div>
        </div>
        <div className="info-panel matrix-panel">
          <table className="capability-matrix" aria-label="能力矩阵">
            <thead>
              <tr>
                <th scope="col">能力</th>
                {capabilitySubjects.map((subject) => (
                  <th scope="col" key={subject}>
                    {capabilitySubjectLabels[subject]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {capabilityMatrix.map((row) => (
                <tr key={row.id}>
                  <th scope="row">{row.label}</th>
                  {capabilitySubjects.map((subject) => {
                    const condition = (
                      row.allowed as Record<string, string | undefined>
                    )[subject];
                    return (
                      <td key={subject}>
                        {condition === undefined ? (
                          <span className="muted">—</span>
                        ) : condition ? (
                          <span title={condition}>允许*</span>
                        ) : (
                          <span className="matrix-yes">允许</span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted matrix-note">
            * 表示还须满足附加条件（如需求参与者、开发负责人或本人会话）。
          </p>
        </div>
      </section>
      <section className="document-section" aria-labelledby="own-capabilities">
        <div className="section-heading">
          <div>
            <h2 id="own-capabilities">当前身份可执行</h2>
            <p className="muted">
              按你在本项目中的角色
              {subjects.length ? '整理' : '：当前项目角色没有对应能力'}。
            </p>
          </div>
        </div>
        <div className="info-panel">
          <dl className="detail-grid own-capabilities">
            {capabilityMatrix.map((row) => {
              const holder = subjects.find((subject) =>
                Object.hasOwn(
                  row.allowed as Record<CapabilitySubject, string | undefined>,
                  subject,
                ),
              );
              const condition = holder
                ? (
                    row.allowed as Record<CapabilitySubject, string | undefined>
                  )[holder]
                : undefined;
              return (
                <div style={{ display: 'contents' }} key={row.id}>
                  <dt>{row.label}</dt>
                  <dd>
                    {holder === undefined ? (
                      <span className="muted">—</span>
                    ) : condition ? (
                      <span className="pill warn" title={condition}>
                        允许 · 有附加条件
                      </span>
                    ) : (
                      <span className="pill ok">允许</span>
                    )}
                  </dd>
                </div>
              );
            })}
          </dl>
        </div>
      </section>
    </>
  );
}
