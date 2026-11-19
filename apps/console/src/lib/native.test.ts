import { expectTypeOf, test } from 'vitest';
import type { SessionHistoryPage } from '@rdws/contracts';
import type { readSessionHistory } from './native.ts';

test('the Native history reader matches the shared session history contract', () => {
  expectTypeOf<
    Awaited<ReturnType<typeof readSessionHistory>>
  >().toEqualTypeOf<SessionHistoryPage>();
});
