/**
 * View-level projection of cleaning steps: the set of column ids whose values
 * are displayed trimmed. Trim is the only value-mutating step (empty-row and
 * dedupe change membership only; select-columns narrows the visible column
 * list separately), so the grid can cheaply mirror what exports produce by
 * trimming exactly these columns at read time.
 */
import type { ColumnId } from '../dataset/types';
import type { CleaningStep } from './types';

export function trimmedColumnSet(
  steps: readonly CleaningStep[],
  allColumnIds: readonly ColumnId[],
): Set<ColumnId> {
  const set = new Set<ColumnId>();
  for (const step of steps) {
    if (step.type !== 'trim' || !step.enabled) continue;
    if (step.scope.kind === 'all-columns') {
      for (const id of allColumnIds) set.add(id);
    } else {
      for (const id of step.scope.columnIds) set.add(id);
    }
  }
  return set;
}
