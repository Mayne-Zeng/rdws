import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { consumeHistoryText } from './history-text.mjs';

const local = createRequire(import.meta.url);
const native = createRequire(local.resolve('@deepseek-ai/dsh/package.json'));
const { LlmRuntime } = await import(
  pathToFileURL(native.resolve('@deepseek-ai/dsh-llm')).href
);
const { DeepSeekAdapter } = await import(
  pathToFileURL(native.resolve('@deepseek-ai/dsh-llm-deepseek')).href
);

export default class HistoryTextRuntime extends LlmRuntime {
  delegates = new WeakMap();

  registerAdapter(providers, adapter) {
    if (Object.getPrototypeOf(adapter) !== DeepSeekAdapter.prototype)
      return super.registerAdapter(providers, adapter);
    let delegate = this.delegates.get(adapter);
    if (!delegate) {
      delegate = new Proxy(adapter, {
        get(target, key) {
          if (key === 'prepareCall')
            return async (...args) => {
              const prepared = await target.prepareCall(...args);
              return {
                ...prepared,
                stream: (options) =>
                  prepared.stream(consumeHistoryText(options)),
              };
            };
          const value = Reflect.get(target, key, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      this.delegates.set(adapter, delegate);
    }
    return super.registerAdapter(providers, delegate);
  }
}
