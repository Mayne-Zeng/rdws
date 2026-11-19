import { useEffect, useState, useSyncExternalStore } from 'react';
import type { NativeRuntime, SessionBinding } from '../lib/native.ts';

function modelLabel(value: unknown) {
  if (!value || typeof value !== 'object') return;
  const { provider, model } = value as { provider?: unknown; model?: unknown };
  if (
    typeof provider === 'string' &&
    provider &&
    typeof model === 'string' &&
    model
  )
    return `${provider} / ${model}`;
}

export function SessionModelStatus({
  binding,
  runtime,
}: {
  binding: SessionBinding;
  runtime: NativeRuntime;
}) {
  const selection = binding.session.projections.faceOf('modelSelection');
  const projection = useSyncExternalStore(
    selection.subscribe.bind(selection),
    selection.getSnapshot.bind(selection),
  );
  const next =
    projection && typeof projection === 'object' && 'next' in projection
      ? projection.next
      : undefined;
  const connection = runtime.root.get('connection') as {
    generation: {
      subscribe: (listener: () => void) => () => void;
      getSnapshot: () => unknown;
    };
  };
  const generation = useSyncExternalStore(
    connection.generation.subscribe.bind(connection.generation),
    connection.generation.getSnapshot.bind(connection.generation),
  );
  const [fallback, setFallback] = useState<{
    generation: unknown;
    runtime: NativeRuntime;
    label?: string;
  }>();
  const needsDefault = next === null;
  useEffect(() => {
    if (!needsDefault || !generation) return;
    let active = true;
    async function loadDefault() {
      const result = await runtime.root.get('remote')?.session.modelCatalog();
      if (active)
        setFallback({
          generation,
          runtime,
          label: result?.ok ? modelLabel(result.value.default) : undefined,
        });
    }
    void loadDefault().catch(() => {
      if (active) setFallback({ generation, runtime });
    });
    return () => {
      active = false;
    };
  }, [generation, needsDefault, runtime]);

  const recorded = modelLabel(next);
  const defaultLabel =
    generation &&
    fallback?.generation === generation &&
    fallback.runtime === runtime
      ? fallback.label
      : undefined;
  return (
    <footer
      className="statusbar prose-text"
      aria-label="当前会话状态"
      data-testid="active-session-model"
    >
      <p>
        模型 ·{' '}
        {recorded
          ? `已记录 ${recorded}`
          : needsDefault && defaultLabel
            ? `实例默认 ${defaultLabel}`
            : '待确认'}
      </p>
    </footer>
  );
}
