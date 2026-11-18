export const roleLabels: Record<string, string> = {
  project_admin: '项目管理员',
  requirement_manager: '需求经理',
  developer: '开发人员',
  tester: '测试人员',
};
const paths = {
  grid: 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
  folder: 'M3 7h7l2 2h9v11H3z M3 7V4h7l2 3',
  chat: 'M4 4h16v12H9l-5 4z',
  file: 'M5 3h9l5 5v13H5z M14 3v6h5 M8 13h8 M8 17h6',
  plus: 'M12 5v14 M5 12h14',
  arrow: 'M5 12h14 M13 6l6 6-6 6',
  check: 'M5 12l4 4L19 6',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12 M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
  layers: 'M3 8l9-5 9 5-9 5z M3 12l9 5 9-5 M3 16l9 5 9-5',
  menu: 'M4 6h16 M4 12h16 M4 18h16',
  branch:
    'M8.5 6h5.5a4 4 0 0 1 4 4v1 M6 8.5v7 M8.5 6a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0 M8.5 18a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0 M20.5 13.5a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0',
  user: 'M15.5 8a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0 M5 20v-1a5 5 0 0 1 5-5h4a5 5 0 0 1 5 5v1',
  lock: 'M7 10h10a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2 M8 10V7a4 4 0 0 1 8 0v3 M12 14v3',
  eyeOff:
    'M3 3l18 18 M10 6.2A10 10 0 0 1 12 6c6.5 0 10 6 10 6a13.3 13.3 0 0 1-2.6 3.1 M6.1 7.8A14 14 0 0 0 2 12s3.5 6 10 6c1.7 0 3.2-.4 4.5-1.1',
  terminal: 'M3 5h18v14H3z M7 9l3 3-3 3 M14 15h3',
  shield: 'M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z M9 12l2 2 4-4',
  clock: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0 M12 7v5l3 2',
} as const;
export function Icon({ name }: { name: keyof typeof paths }) {
  return (
    <svg
      className="icon"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}
export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    if (init?.signal?.aborted) throw error;
    throw Object.assign(
      new Error('连接中断，操作结果尚未确认，请重试原操作。'),
      { resultUnknown: true },
    );
  }
  let value;
  try {
    value = await response.json();
  } catch (error) {
    if (init?.signal?.aborted) throw error;
    throw Object.assign(
      new Error('响应内容未能完整读取，操作结果尚未确认，请重试原操作。'),
      { resultUnknown: true },
    );
  }
  if (!response.ok)
    throw Object.assign(new Error(value.error ?? '服务暂时不可用，请重试'), {
      resultUnknown: response.status >= 500,
      status: response.status,
    });
  return value as T;
}
