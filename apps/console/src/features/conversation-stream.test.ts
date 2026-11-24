import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import type { ConversationNode } from './conversation-nodes.ts';
import { ConversationStream } from './conversation-stream.tsx';

const time = Date.UTC(2026, 10, 24, 8, 0, 0);
const render = (nodes: ConversationNode[], own = true) =>
  renderToStaticMarkup(createElement(ConversationStream, { nodes, own }));
const reply = (text: string, extra: Partial<ConversationNode> = {}) =>
  ({
    kind: 'assistant',
    key: 'a-7',
    seq: 7,
    time,
    text,
    live: false,
    interrupted: false,
    ...extra,
  }) as ConversationNode;

describe('conversation stream rendering', () => {
  test('line-based text keeps its characters inside the body', () => {
    const text = 'RDWS_LONG_BEGIN\n1\n2\nRDWS_LONG_END';
    const markup = render([reply(text)]);
    expect(markup).toContain(
      `<div class="message-body markdown"><p>${text}</p></div>`,
    );
    // Trailing whitespace survives Markdown trimming.
    expect(render([reply('a\nb\n')])).toContain(
      '<div class="message-body markdown"><p>a\nb</p>\n</div>',
    );
  });

  test('every Markdown block and inline form survives the element allowlist', () => {
    const markup = render([
      reply(
        '# 标题\n\n| 项 | 值 |\n| - | - |\n| a | 1 |\n\n- x\n- [ ] y\n\n1. 一\n2. 二\n\n```js\nconsole.log(1)\n```\n\n> 引用\n\n---\n\n**粗** 与 `码` 和 ~~删~~',
      ),
    ]);
    for (const expected of [
      '<h1>标题</h1>',
      '<table>',
      '<th>项</th>',
      '<td>1</td>',
      '<ul',
      '<li>x</li>',
      'type="checkbox"',
      '<ol',
      '<li>一</li>',
      '<code class="language-js">console.log(1)',
      '<blockquote>',
      '<hr/>',
      '<strong>粗</strong>',
      '<code>码</code>',
      '<del>删</del>',
      '复制代码',
    ])
      expect(markup, expected).toContain(expected);
  });

  test('raw HTML stays text and never becomes an element', () => {
    const markup = render([
      reply('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>'),
    ]);
    expect(markup).not.toContain('<script');
    expect(markup).not.toContain('<img');
    expect(markup).toContain('&lt;script&gt;');
    expect(markup).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  test('only web addresses become links', () => {
    const markup = render([
      reply(
        '[x](https://example.com/p) [y](#frag) [z](javascript:alert(1)) [m](mailto:a@b.c) [i](irc://h) ![pic](https://example.com/a.png) ![x](data:image/png;base64,AAAA)',
      ),
    ]);
    expect(markup).toContain(
      '<a href="https://example.com/p" target="_blank" rel="noopener noreferrer">x</a>',
    );
    expect(markup).toContain('<a href="#frag">y</a>');
    expect(markup).not.toContain('javascript:');
    expect(markup).not.toContain('mailto:');
    expect(markup).not.toContain('irc:');
    expect(markup).not.toContain('data:');
    expect(markup.match(/<a /g)).toHaveLength(3);
    expect(markup).toContain('<span class="md-unlinked">z</span>');
    expect(markup).toContain('<span class="md-unlinked">m</span>');
    // A model-mentioned image is a reference, never a remote request.
    expect(markup).toContain(
      '<a class="md-image" href="https://example.com/a.png" target="_blank" rel="noopener noreferrer">图片：pic<span class="md-host">example.com</span></a>',
    );
    expect(markup).toContain(
      '<span class="md-image md-unlinked">图片：x</span>',
    );
  });

  test('the assistant body is the only direct block of its message', () => {
    const markup = render([reply('hi', { usage: { totalTokens: 12 } })]);
    expect(markup).toContain(
      '<div class="message" data-live="false" data-seq="7"><header class="message-head"><span class="message-role">助手</span><time>',
    );
    expect(markup.match(/<div/g)).toHaveLength(2);
    expect(markup).toContain('12 tokens');
    expect(markup).toContain('复制消息');
    expect(render([reply('x', { live: true })])).toContain('data-live="true"');
    expect(render([reply('x', { interrupted: true })])).toContain('回复被中断');
  });

  test('a long live body falls back to plain text until it settles', () => {
    const markup = render([reply('x'.repeat(20_001), { live: true })]);
    expect(markup).toContain('message-body plain');
    expect(render([reply('x'.repeat(20_001))])).toContain(
      'message-body markdown',
    );
  });

  test('tool cards and turn notices are not messages', () => {
    const markup = render([
      {
        kind: 'tool',
        key: 't-1',
        seq: 1,
        time,
        name: 'Read',
        turn: 1,
        step: 1,
        status: 'result-error',
        endSeq: 2,
        endTime: time + 1500,
      },
      {
        kind: 'notice',
        key: 'n-3',
        seq: 3,
        time,
        tone: 'warning',
        text: '本轮已中断。',
      },
    ]);
    expect(markup).toContain('data-status="result-error"');
    expect(markup).toContain('<span class="tool-name">Read</span>');
    expect(markup).toContain('<span class="tool-status danger">出错</span>');
    expect(markup).toContain('1.5s');
    expect(markup).toContain('工具参数与结果不对外显示。');
    expect(markup).toContain('class="turn-notice warning"');
    expect(markup).not.toContain('class="message');
  });

  test('user messages name the sender by ownership', () => {
    const node: ConversationNode = {
      kind: 'user',
      key: 'u-1',
      seq: 1,
      time,
      text: 'hi',
    };
    expect(render([node])).toContain(
      '<div class="message from-user" data-seq="1"><div class="message-body plain">hi</div><footer class="message-foot"><span>你</span>',
    );
    expect(render([node], false)).toContain('<span>用户</span>');
  });

  test('footnote anchors are scoped to the message', () => {
    const markup = render([reply('a[^1]\n\n[^1]: note')]);
    expect(markup).toContain('7-user-content-fn-1');
    expect(markup).toContain('href="#7-user-content-fn-1"');
    expect(markup).toContain('id="7-user-content-fn-1"');
  });
});
