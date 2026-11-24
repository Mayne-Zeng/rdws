import { memo, useEffect, useRef, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  formatClock,
  formatDuration,
  formatUsage,
  toolStatusLabels,
  type AssistantNode,
  type ConversationNode,
  type UsageSummary,
} from './conversation-nodes.ts';

// A still-streaming body is parsed at most this often, and falls back to plain
// text past this length until the message settles.
const liveParseIntervalMs = 80;
const liveParseLimit = 20000;
const nodeOrigin = 'http://localhost/';

type HastNode = {
  type?: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
};
type LinkTarget =
  | { kind: 'text' }
  | { kind: 'page'; href: string }
  | { kind: 'link'; href: string; host: string; external: boolean };

// Only web addresses become links. Other protocols, addresses the renderer
// cleared and unparseable targets stay as their visible text.
function linkTarget(href: unknown): LinkTarget {
  if (typeof href !== 'string' || !href) return { kind: 'text' };
  if (href.startsWith('#')) return { kind: 'page', href };
  let url: URL;
  try {
    url = new URL(
      href,
      typeof location === 'undefined' ? nodeOrigin : location.href,
    );
  } catch {
    return { kind: 'text' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    return { kind: 'text' };
  return {
    kind: 'link',
    href: url.href,
    host: url.host,
    external: typeof location !== 'undefined' && url.origin !== location.origin,
  };
}
const externalLink = { target: '_blank', rel: 'noopener noreferrer' } as const;

async function copyText(text: string) {
  try {
    if (typeof navigator === 'undefined' || !navigator.clipboard) return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
function CopyButton({ text, label }: { text: string; label: string }) {
  const [state, setState] = useState<'idle' | 'done' | 'failed'>('idle');
  const timer = useRef<number>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  if (!text) return null;
  return (
    <button
      type="button"
      className="copy-button"
      onClick={() => {
        void copyText(text).then((copied) => {
          setState(copied ? 'done' : 'failed');
          window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => setState('idle'), 1600);
        });
      }}
    >
      {state === 'idle' ? label : state === 'done' ? '已复制' : '复制失败'}
    </button>
  );
}
function MarkdownLink({
  href,
  children,
}: {
  href?: string;
  children?: ReactNode;
}) {
  const target = linkTarget(href);
  if (target.kind === 'text')
    return <span className="md-unlinked">{children}</span>;
  if (target.kind === 'page') return <a href={target.href}>{children}</a>;
  return (
    <a href={target.href} {...externalLink}>
      {children}
      {target.external && <span className="md-host">{target.host}</span>}
    </a>
  );
}
// Model output never loads a remote image: the reference is shown as a link.
function MarkdownImage({ src, alt }: { src?: string; alt?: string }) {
  const target = linkTarget(src);
  const label = `图片${alt ? `：${alt}` : ''}`;
  if (target.kind !== 'link')
    return <span className="md-image md-unlinked">{label}</span>;
  return (
    <a className="md-image" href={target.href} {...externalLink}>
      {label}
      <span className="md-host">{target.host}</span>
    </a>
  );
}
function codeText(node?: HastNode): string {
  const code = node?.children?.[0];
  const source =
    code?.type === 'element' && code.tagName === 'code' ? code : node;
  return (source?.children ?? []).map((child) => child.value ?? '').join('');
}
function CodeBlock({
  children,
  node,
}: {
  children?: ReactNode;
  node?: unknown;
}) {
  const text = codeText(node as HastNode | undefined);
  return (
    <div className="md-code">
      <pre>{children}</pre>
      <CopyButton text={text} label="复制代码" />
    </div>
  );
}
// Footnote anchors are generated from labels, so two messages with the same
// labels would share ids. Only those generated ids are scoped per message;
// explicit in-page links are left exactly as written.
function scopeIds(prefix: string) {
  const generated = (value: unknown): value is string =>
    typeof value === 'string' &&
    (value.startsWith('user-content-') || value === 'footnote-label');
  const scope = (value: string) => `${prefix}${value}`;
  const walk = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    const node = value as HastNode | null;
    if (!node || typeof node !== 'object') return;
    const { properties } = node;
    if (properties) {
      if (generated(properties.id)) properties.id = scope(properties.id);
      for (const key of ['aria-describedby', 'aria-labelledby']) {
        const current = properties[key];
        if (typeof current === 'string')
          properties[key] = current
            .split(/\s+/)
            .map((item) => (generated(item) ? scope(item) : item))
            .join(' ');
        else if (Array.isArray(current))
          properties[key] = current.map((item) =>
            generated(item) ? scope(item) : item,
          );
      }
      // An in-page reference keeps its fragment, unlike an element id.
      const { href } = properties;
      if (typeof href === 'string' && generated(href.slice(1)))
        properties.href = `#${prefix}${href.slice(1)}`;
    }
    node.children?.forEach(walk);
  };
  return (tree: unknown) => {
    walk(tree);
  };
}
// Every element the Markdown pipeline can emit. A missing entry silently
// drops that element together with its content, so the rendering test covers
// each block and inline form.
const allowedElements = [
  'a',
  'blockquote',
  'br',
  'code',
  'del',
  'em',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'img',
  'input',
  'li',
  'ol',
  'p',
  'pre',
  'section',
  'strong',
  'sup',
  'table',
  'tbody',
  'td',
  'th',
  'thead',
  'tr',
  'ul',
];
const markdownComponents = {
  a: MarkdownLink,
  img: MarkdownImage,
  pre: CodeBlock,
};
export const MarkdownBody = memo(function MarkdownBody({
  text,
  seq,
}: {
  text: string;
  seq: number;
}) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[[scopeIds, `${seq}-`]]}
      allowedElements={allowedElements}
      components={markdownComponents}
    >
      {text}
    </ReactMarkdown>
  );
});
function useLiveText(text: string, live: boolean) {
  const [shown, setShown] = useState(text);
  const last = useRef(0),
    timer = useRef<number>(undefined);
  useEffect(() => {
    window.clearTimeout(timer.current);
    if (!live) {
      setShown(text);
      return;
    }
    const wait = Math.max(0, liveParseIntervalMs - (Date.now() - last.current));
    timer.current = window.setTimeout(() => {
      last.current = Date.now();
      setShown(text);
    }, wait);
    return () => window.clearTimeout(timer.current);
  }, [text, live]);
  return shown;
}
const usageTitle = (usage: UsageSummary) =>
  [
    usage.inputTokens !== undefined && `输入 ${usage.inputTokens}`,
    usage.outputTokens !== undefined && `输出 ${usage.outputTokens}`,
    usage.cacheReadTokens !== undefined && `缓存读取 ${usage.cacheReadTokens}`,
  ]
    .filter(Boolean)
    .join(' · ');

const UserMessage = memo(function UserMessage({
  node,
  own,
}: {
  node: Extract<ConversationNode, { kind: 'user' }>;
  own: boolean;
}) {
  return (
    <div className="message from-user" data-seq={node.seq}>
      <div className="message-body plain">{node.text}</div>
      <footer className="message-foot">
        <span>{own ? '你' : '用户'}</span>
        {node.time !== undefined && <time>{formatClock(node.time)}</time>}
        <CopyButton text={node.text} label="复制消息" />
      </footer>
    </div>
  );
});
const AssistantMessage = memo(function AssistantMessage({
  node,
}: {
  node: AssistantNode;
}) {
  // The settled body keeps its own text; only a live one is throttled.
  const text = useLiveText(node.text, node.live);
  const plain = node.live && text.length > liveParseLimit;
  const usage = node.usage && !node.live ? formatUsage(node.usage) : undefined;
  // Markdown trims trailing whitespace; put it back so the body text equals
  // the recorded message character for character.
  const trailing = plain ? '' : (text.match(/\s+$/)?.[0] ?? '');
  return (
    <div
      className="message"
      data-live={node.live ? 'true' : 'false'}
      data-seq={node.seq}
    >
      <header className="message-head">
        <span className="message-role">
          助手{node.live ? ' · 正在生成' : ''}
        </span>
        {node.model && !node.live && (
          <span className="muted">{node.model}</span>
        )}
        {node.time !== undefined && <time>{formatClock(node.time)}</time>}
      </header>
      <div className={plain ? 'message-body plain' : 'message-body markdown'}>
        {plain ? (
          text
        ) : (
          <>
            <MarkdownBody text={text} seq={node.seq} />
            {trailing}
          </>
        )}
      </div>
      {(!node.live || usage !== undefined || node.interrupted) && (
        <footer className="message-foot">
          {usage && (
            <span
              className="muted"
              title={node.usage ? usageTitle(node.usage) : ''}
            >
              {usage}
            </span>
          )}
          {node.interrupted && <span className="muted">回复被中断</span>}
          {!node.live && <CopyButton text={node.text} label="复制消息" />}
        </footer>
      )}
    </div>
  );
});
type ToolNode = Extract<ConversationNode, { kind: 'tool' }>;
const toolTone: Record<ToolNode['status'], string> = {
  running: '',
  'result-returned': '',
  'result-error': 'danger',
  blocked: 'danger',
  'not-started': 'warning',
  'outcome-unknown': 'warning',
};
const ToolCard = memo(function ToolCard({ node }: { node: ToolNode }) {
  const duration =
    node.endTime !== undefined && node.time !== undefined
      ? formatDuration(node.time, node.endTime)
      : undefined;
  return (
    <details className="tool-card" data-status={node.status}>
      <summary>
        <span className="tool-name">{node.name ?? '工具'}</span>
        <span className={`tool-status ${toolTone[node.status]}`}>
          {toolStatusLabels[node.status]}
        </span>
        {duration !== undefined && <span className="muted">{duration}</span>}
        {node.time !== undefined && <time>{formatClock(node.time, true)}</time>}
      </summary>
      <div className="tool-detail">
        <dl className="tool-facts">
          {node.turn !== undefined && (
            <>
              <dt>轮次</dt>
              <dd>{node.turn}</dd>
            </>
          )}
          {node.step !== undefined && (
            <>
              <dt>步骤</dt>
              <dd>{node.step}</dd>
            </>
          )}
          <dt>状态</dt>
          <dd>{toolStatusLabels[node.status]}</dd>
          {node.endTime !== undefined && (
            <>
              <dt>结束</dt>
              <dd>{formatClock(node.endTime, true)}</dd>
            </>
          )}
        </dl>
        <p className="muted">工具参数与结果不对外显示。</p>
      </div>
    </details>
  );
});
const TurnNotice = memo(function TurnNotice({
  node,
}: {
  node: Extract<ConversationNode, { kind: 'notice' }>;
}) {
  return (
    <p className={`turn-notice ${node.tone}`} role="status">
      {node.text}
    </p>
  );
});
export const ConversationStream = memo(function ConversationStream({
  nodes,
  own,
}: {
  nodes: ConversationNode[];
  own: boolean;
}) {
  return nodes.map((node) => {
    switch (node.kind) {
      case 'user':
        return <UserMessage key={node.key} node={node} own={own} />;
      case 'assistant':
        return <AssistantMessage key={node.key} node={node} />;
      case 'tool':
        return <ToolCard key={node.key} node={node} />;
      default:
        return <TurnNotice key={node.key} node={node} />;
    }
  });
});
