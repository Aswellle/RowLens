import { describe, expect, it } from 'vitest';
import { AppError } from '../../app/app-error';
import type { QueryOutcome } from './client';
import { reduceQueryOutcome, type QueryViewState } from './reduce-outcome';

const STATE: QueryViewState = {
  rowIndices: [0, 1, 2],
  stepSummaries: [{ stepId: 's1', rowsRemoved: 1, cellsChanged: 0 }],
  queryBusy: true,
};

const describeFailure = (code: string, message: string): string => `${code}: ${message}`;

function reduce(outcome: QueryOutcome) {
  return reduceQueryOutcome(STATE, outcome, describeFailure);
}

describe('reduceQueryOutcome', () => {
  it('replaces indices and summaries on done and clears busy', () => {
    const { state, notice } = reduce({
      kind: 'done',
      rowIndices: [5, 7],
      matched: 2,
      totalRows: 10,
      stepSummaries: [{ stepId: 's2', rowsRemoved: 0, cellsChanged: 3 }],
    });
    expect(state.rowIndices).toEqual([5, 7]);
    expect(state.stepSummaries[0]?.stepId).toBe('s2');
    expect(state.queryBusy).toBe(false);
    expect(notice).toBeUndefined();
  });

  it('clears busy and keeps the previous view when cancelled', () => {
    const { state, notice } = reduce({ kind: 'cancelled' });
    expect(state.queryBusy).toBe(false); // regression: stuck busy left Cancel on screen
    expect(state.rowIndices).toEqual([0, 1, 2]);
    expect(state.stepSummaries).toHaveLength(1);
    expect(notice).toBeUndefined();
  });

  it('keeps the previous view with a warning when the match limit is hit', () => {
    const { state, notice } = reduce({ kind: 'limit', matched: 200_001, limit: 200_000 });
    expect(state.queryBusy).toBe(false);
    expect(state.rowIndices).toEqual([0, 1, 2]);
    expect(notice?.variant).toBe('warning');
    expect(notice?.message).toContain('200,000');
  });

  it('keeps the previous view with an error message on failure', () => {
    const { state, notice } = reduce({
      kind: 'failed',
      error: new AppError('QUERY_FAILED', 'The query could not be completed.'),
    });
    expect(state.queryBusy).toBe(false);
    expect(state.rowIndices).toEqual([0, 1, 2]);
    expect(notice).toEqual({
      variant: 'error',
      message: 'QUERY_FAILED: The query could not be completed.',
    });
  });

  it('leaves the state untouched when superseded (the newer run owns it)', () => {
    const { state, notice } = reduce({ kind: 'superseded' });
    expect(state).toBe(STATE); // same reference: no re-render churn
    expect(notice).toBeUndefined();
  });
});
