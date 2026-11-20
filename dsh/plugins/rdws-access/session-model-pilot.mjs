export function installSessionModelPilot(ctx, identity, runForMessage) {
  const pending = new WeakMap();
  const completed = new WeakMap();
  ctx.on(
    'session/event',
    (session, event) => {
      if (event.type === 'turn/end') pending.delete(session);
      if (event.type !== 'agent/inbox/spliced') return;
      const { outcome, removedCount, inserted } = event.data;
      if (outcome || !removedCount || inserted.length) return;
      const batch = pending.get(session) ?? { count: 0, messages: [] };
      batch.count += removedCount;
      pending.set(session, batch);
    },
    { global: true },
  );

  ctx.on(
    'agent/inbox/claimed',
    ({ agent, turn, message }) => {
      const batch = pending.get(agent.session);
      if (!batch) return;
      batch.messages.push(message);
      if (batch.messages.length !== batch.count) return;
      pending.delete(agent.session);
      const keys = batch.messages.map(identity);
      const runs = batch.messages.map((claimed) =>
        runForMessage(agent, claimed),
      );
      const model = runs[0]?.selection;
      if (
        !model ||
        !keys.every(Boolean) ||
        runs.length > 16 ||
        !runs.every(
          (run) =>
            run?.selection?.revision === model.revision &&
            run.selection.provider === model.provider &&
            run.selection.model === model.model,
        ) ||
        new Set(runs.map((run) => run.runId)).size !== runs.length
      ) {
        completed.set(agent, { turn, invalid: true });
        return;
      }
      try {
        agent.model.select({ provider: model.provider, model: model.model });
        completed.set(agent, {
          turn,
          keys,
          model,
          runIds: runs.map((run) => run.runId),
        });
      } catch {
        completed.set(agent, { turn, invalid: true });
      }
    },
    { global: true },
  );

  return (agent, turn, messages, modelSelection) => {
    const batch = completed.get(agent);
    if (batch) completed.delete(agent);
    if (!messages.length) return batch?.turn === turn ? undefined : [];
    if (
      !batch ||
      batch.invalid ||
      batch.turn !== turn ||
      batch.keys.length !== messages.length ||
      messages.some(
        (message, index) => identity(message) !== batch.keys[index],
      ) ||
      modelSelection.provider !== batch.model.provider ||
      modelSelection.model !== batch.model.model
    )
      return;
    return batch.runIds;
  };
}
