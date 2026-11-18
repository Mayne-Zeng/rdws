import { appendFileSync } from 'node:fs';
export const name = 'rdws-probe-observer';
export function apply(ctx, config) {
  ctx.on(
    'agent/assistant-stream',
    ({ agent, frame }) => {
      const record = {
        sessionId: String(agent.session.id),
        type: frame.type,
        receivedAt: Date.now(),
      };
      if (frame.type === 'chunk') {
        record.chunkType = frame.chunk.type;
        if (typeof frame.chunk.text === 'string')
          record.textLength = frame.chunk.text.length;
      }
      appendFileSync(config.path, JSON.stringify(record) + '\n', {
        mode: 0o600,
      });
    },
    { global: true },
  );
}
