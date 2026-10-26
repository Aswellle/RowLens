/**
 * Pure reduction of a query outcome into view state. Extracted so the
 * cancellation/supersession/busy rules are testable without a browser and
 * live in exactly one place.
 */
import type { QueryOutcome } from './client';
import type { StepSummary } from '../cleaning/types';

export type QueryViewState = {
  rowIndices: number[];
  stepSummaries: StepSummary[];
  queryBusy: boolean;
};

export type QueryNotice = { variant: 'warning' | 'error'; message: string };

export type QueryReduction<T extends QueryViewState> = {
  state: T;
  notice?: QueryNotice;
};

/**
 * Apply an outcome to the current view state.
 *
 * - done: replace the visible indices and per-step summaries, clear busy.
 * - limit: keep the previous view, warn, clear busy.
 * - failed: keep the previous view, error, clear busy.
 * - cancelled: keep the previous view, **clear busy** (a stuck busy marker
 *   would leave the Cancel button on screen forever).
 * - superseded: leave the state untouched — the superseding run owns it.
 */
export function reduceQueryOutcome<T extends QueryViewState>(
  state: T,
  outcome: QueryOutcome,
  describeFailure: (code: string, message: string) => string,
): QueryReduction<T> {
  switch (outcome.kind) {
    case 'done':
      return {
        state: {
          ...state,
          rowIndices: outcome.rowIndices,
          stepSummaries: outcome.stepSummaries ?? [],
          queryBusy: false,
        },
      };
    case 'limit':
      return {
        state: { ...state, queryBusy: false },
        notice: {
          variant: 'warning',
          message: `The query matched more than ${outcome.limit.toLocaleString('en-US')} rows. Narrow the search or filters to see results.`,
        },
      };
    case 'failed':
      return {
        state: { ...state, queryBusy: false },
        notice: {
          variant: 'error',
          message: describeFailure(outcome.error.code, outcome.error.message),
        },
      };
    case 'cancelled':
      return { state: { ...state, queryBusy: false } };
    case 'superseded':
      return { state };
  }
}
