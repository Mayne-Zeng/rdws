import { useLayoutEffect, useRef, useState } from 'react';
import { Alert, Button, Loading } from 'tdesign-react';
import { Icon } from '../lib/ui.tsx';
import './design-system.css';

const colors = [
  ['--brand', '品牌主色'],
  ['--brand-dark', '交互强调'],
  ['--ink', '正文'],
  ['--muted', '辅助文字'],
  ['--canvas', '工作画布'],
  ['--paper', '容器背景'],
  ['--rail', '导航背景'],
  ['--line', '容器边线'],
] as const;

const dimensions = [
  ['--content-w', '内容最大宽度'],
  ['--gutter', '内容边距'],
  ['--rail-w', '导航宽度'],
  ['--control-h', '标准控件高度'],
  ['--radius-sm', '小圆角'],
  ['--radius-md', '中圆角'],
  ['--radius-lg', '大圆角'],
] as const;

const typeSamples = [
  ['record-id', '编号', 'D-1042'],
  ['muted', '辅助说明', '最近更新'],
  ['', '界面正文', '需求背景与范围'],
  ['top-title', '顶栏标题', '需求档案'],
] as const;

const breakpoints = [
  { min: 821, label: '≥ 821px', rail: '展开侧栏', control: '30px' },
  { min: 621, label: '621–820px', rail: '图标侧栏', control: '30px' },
  { min: 0, label: '≤ 620px', rail: '离屏导航', control: '40px' },
] as const;

type DesignValues = {
  tokens: Record<string, string>;
  fonts: Record<string, string>;
  theme: string;
  width: number;
};

export function DesignSystemPage({
  back,
  logout,
  logoutBusy,
  logoutError,
}: {
  back: () => void;
  logout: () => void;
  logoutBusy: boolean;
  logoutError: string;
}) {
  const content = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const [values, setValues] = useState<DesignValues>();
  const [recovered, setRecovered] = useState(false);

  useLayoutEffect(() => {
    const root = document.documentElement;
    const previousTitle = document.title;
    const samples =
      content.current!.querySelectorAll<HTMLElement>('[data-font-sample]');
    function readStyles() {
      const style = getComputedStyle(root);
      setValues({
        tokens: Object.fromEntries(
          [...colors, ...dimensions].map(([name]) => [
            name,
            style.getPropertyValue(name).trim(),
          ]),
        ),
        fonts: Object.fromEntries(
          Array.from(samples, (sample) => [
            sample.dataset.fontSample!,
            getComputedStyle(sample).fontSize,
          ]),
        ),
        theme: root.getAttribute('theme-mode') === 'dark' ? '深色' : '浅色',
        width: window.innerWidth,
      });
    }
    const observer = new MutationObserver(readStyles);
    observer.observe(root, {
      attributes: true,
      attributeFilter: ['theme-mode'],
    });
    window.addEventListener('resize', readStyles);
    readStyles();
    document.title = 'RDWS · 设计系统';
    heading.current?.focus({ preventScroll: true });
    return () => {
      document.title = previousTitle;
      observer.disconnect();
      window.removeEventListener('resize', readStyles);
    };
  }, []);

  const activeBreakpoint = breakpoints.find(
    ({ min }) => (values?.width ?? 0) >= min,
  );

  return (
    <main className="shell design-page">
      <header className="topbar">
        <strong className="design-wordmark">RDWS</strong>
        <Button tag="button" variant="outline" onClick={back}>
          返回工作台
        </Button>
        <Button
          tag="button"
          variant="text"
          loading={logoutBusy}
          onClick={logout}
        >
          退出登录
        </Button>
      </header>
      <div className="workspace-scroll">
        <div className="content-width" ref={content}>
          {logoutError && <Alert theme="error" message={logoutError} />}
          <div className="page-heading core-page-heading design-heading">
            <div>
              <h1 ref={heading} tabIndex={-1} data-font-sample="页面标题">
                设计系统
              </h1>
              <p className="muted">查看工作台实际使用的样式与组件。</p>
            </div>
            <span className="pill brand-pill">{values?.theme}主题</span>
          </div>

          <section className="design-section" aria-labelledby="design-colors">
            <h2 id="design-colors">色彩令牌</h2>
            <ul className="design-colors">
              {colors.map(([name, label]) => (
                <li key={name}>
                  <span
                    aria-hidden="true"
                    className="design-swatch"
                    style={{ backgroundColor: `var(${name})` }}
                  />
                  <div>
                    <strong>{label}</strong>
                    <code>{name}</code>
                    <code data-testid={`design-token-${name.slice(2)}`}>
                      {values?.tokens[name]}
                    </code>
                  </div>
                </li>
              ))}
            </ul>
          </section>

          <div className="design-pair">
            <section className="design-section" aria-labelledby="design-type">
              <h2 id="design-type">字阶</h2>
              <dl className="design-values">
                {typeSamples.map(([className, label, sample]) => (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd>
                      <span className={className} data-font-sample={label}>
                        {sample}
                      </span>
                      <code>{values?.fonts[label]}</code>
                    </dd>
                  </div>
                ))}
                <div>
                  <dt>页面标题</dt>
                  <dd>
                    <code>{values?.fonts['页面标题']}</code>
                  </dd>
                </div>
              </dl>
            </section>
            <section className="design-section" aria-labelledby="design-layout">
              <h2 id="design-layout">布局尺寸</h2>
              <dl className="design-values">
                {dimensions.map(([name, label]) => (
                  <div key={name}>
                    <dt>
                      {label}
                      <code>{name}</code>
                    </dt>
                    <dd>
                      <code data-testid={`design-token-${name.slice(2)}`}>
                        {values?.tokens[name]}
                      </code>
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          </div>

          <section
            className="design-section"
            aria-labelledby="design-breakpoints"
          >
            <h2 id="design-breakpoints">响应式断点</h2>
            <table className="design-breakpoints">
              <thead>
                <tr>
                  <th scope="col">视口宽度</th>
                  <th scope="col">导航</th>
                  <th scope="col">控件高度</th>
                </tr>
              </thead>
              <tbody>
                {breakpoints.map((breakpoint) => (
                  <tr
                    key={breakpoint.label}
                    aria-current={breakpoint === activeBreakpoint || undefined}
                  >
                    <th scope="row">{breakpoint.label}</th>
                    <td>
                      {breakpoint.rail}
                      {breakpoint === activeBreakpoint && (
                        <span className="design-current">当前</span>
                      )}
                    </td>
                    <td>{breakpoint.control}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section className="design-section" aria-labelledby="design-states">
            <h2 id="design-states">组件状态</h2>
            <p className="muted">示例仅在本页运行。</p>
            <div className="design-examples">
              <div>
                <h3>加载</h3>
                <Loading text="正在读取需求" />
              </div>
              <div>
                <h3>忙碌</h3>
                <Button tag="button" theme="primary" loading disabled>
                  处理中
                </Button>
              </div>
              <div>
                <h3>空态</h3>
                <div className="empty-state compact">
                  <Icon name="folder" />
                  <p>暂无可展示的需求。</p>
                </div>
              </div>
              <div>
                <h3>无权</h3>
                <Alert theme="warning" message="需要项目管理员权限。" />
              </div>
              <div className="design-retry">
                <h3>失败与重试</h3>
                <Alert
                  className="design-retry-alert"
                  theme={recovered ? 'success' : 'error'}
                  message={
                    <span role={recovered ? 'status' : 'alert'}>
                      {recovered ? '示例已恢复' : '无法读取需求列表，请重试。'}
                    </span>
                  }
                  operation={
                    <Button
                      tag="button"
                      variant="outline"
                      onClick={() => setRecovered(!recovered)}
                    >
                      {recovered ? '重置示例' : '重试示例'}
                    </Button>
                  }
                />
              </div>
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}
