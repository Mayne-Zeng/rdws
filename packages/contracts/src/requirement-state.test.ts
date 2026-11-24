import { expect, test } from 'vitest';
import {
  requirementStateLabels,
  requirementStateOf,
  requirementStates,
  stageLabels,
  stagesOfState,
  type Stage,
} from './index.ts';

const stages = Object.keys(stageLabels) as Stage[];

test('every current stage is in progress and no status is invented', () => {
  expect(stages.map((stage) => requirementStateOf(stage))).toEqual(
    stages.map(() => 'active'),
  );
  expect(stagesOfState('active')).toEqual(stages);
  // Review and archive hold their place until a later task sources them.
  expect(stagesOfState('review')).toEqual([]);
  expect(stagesOfState('archived')).toEqual([]);
});

test('each status has a label and the sidebar and list share the mapping', () => {
  expect(Object.keys(requirementStateLabels)).toEqual([...requirementStates]);
  expect(requirementStateLabels).toEqual({
    active: '进行中',
    review: '待评审',
    archived: '已归档',
  });
  for (const state of requirementStates)
    for (const stage of stagesOfState(state))
      expect(requirementStateOf(stage)).toBe(state);
});
