/**
 * The complete set of query inputs, and one fingerprint over them.
 *
 * App.tsx's query effect keys its re-runs on this fingerprint alone. Keeping
 * the field list and the derivation in one place is the lesson of ADR-035:
 * the sort key once omitted the numeric flag, the toggle silently did
 * nothing, and nothing but a jsdom probe caught it. A new query input now
 * has to enter through this type, where its absence is visible next to the
 * fields it must stand beside.
 */
import type { CleaningStep } from '../cleaning/types';
import type { ColumnId } from '../dataset/types';

export type QueryInputs = {
  datasetId: string;
  search: string;
  columnFilters: Record<ColumnId, string>;
  sort: { datasetIndex: number; direction: 'asc' | 'desc'; numeric: boolean } | null;
  cleaningSteps: readonly CleaningStep[];
  /** The edit overlay's revision, not the overlay itself. */
  editsRevision: number;
};

export function queryInputFingerprint(inputs: QueryInputs): string {
  return JSON.stringify([
    inputs.datasetId,
    inputs.search,
    inputs.columnFilters,
    inputs.sort,
    inputs.cleaningSteps,
    inputs.editsRevision,
  ]);
}
