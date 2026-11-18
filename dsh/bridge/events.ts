export interface ProbeFrame {
  sessionId: string;
  type: string;
  chunkType?: string;
  textLength?: number;
  receivedAt: number;
}
export function summarizeFrames(frames: ProbeFrame[], completedAt: number) {
  const text = frames.filter(
    (frame) =>
      frame.type === 'chunk' &&
      frame.chunkType === 'text-delta' &&
      (frame.textLength ?? 0) > 0,
  );
  return {
    textChunks: text.length,
    textCharacters: text.reduce(
      (total, frame) => total + (frame.textLength ?? 0),
      0,
    ),
    firstTextAt: text[0]?.receivedAt ?? null,
    lastTextAt: text.at(-1)?.receivedAt ?? null,
    arrivedBeforeCompletion: text.some(
      (frame) => frame.receivedAt < completedAt,
    ),
    sessions: [...new Set(frames.map((frame) => frame.sessionId))],
  };
}
