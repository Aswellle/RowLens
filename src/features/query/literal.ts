/**
 * Pure query primitives: literal case-insensitive search and stable string
 * sort. These are the contract-critical helpers the Phase 3 query worker will
 * reuse; they must stay free of DOM and state.
 *
 * Contract source: docs/03-data-processing-contracts.md §4 — literal substring
 * match (never regex), stable UTF-16 string order, missing values last in both
 * directions, equal values keep original order.
 */
import type { RowIndex } from '../dataset/types';

/** Case-folded literal substring test. An empty needle matches everything. */
export function matchesLiteral(haystack: string | null | undefined, needle: string): boolean {
  if (needle === '') return true;
  if (haystack === null || haystack === undefined) return false;
  return haystack.toLocaleLowerCase('en-US').includes(needle.toLocaleLowerCase('en-US'));
}

/** True when any of the row's cell values matches the literal needle. */
export function rowMatchesSearch(values: ReadonlyArray<string | null>, needle: string): boolean {
  return values.some((value) => matchesLiteral(value, needle));
}

/**
 * Compare two cell values for sorting. Missing (null) values sort last in both
 * directions; present values compare by UTF-16 code units (default `<`).
 */
export function compareCellValues(a: string | null, b: string | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Stably sort row indices by one column's values. Equal values keep their
 * original relative order (guaranteed because we sort the index list, never
 * the rows), and the comparator never sees two equal keys swap.
 */
export function sortIndicesStable(
  indices: readonly RowIndex[],
  valueAt: (index: RowIndex) => string | null,
  direction: 'asc' | 'desc',
): RowIndex[] {
  const sign = direction === 'asc' ? 1 : -1;
  return [...indices].sort((i, j) => {
    const a = valueAt(i);
    const b = valueAt(j);
    // Missing values sort last in BOTH directions; ties keep original order.
    if (a === null || b === null) {
      if (a === null && b === null) return i < j ? -1 : i > j ? 1 : 0;
      return a === null ? 1 : -1;
    }
    const order = a < b ? -1 : a > b ? 1 : 0;
    if (order !== 0) return order * sign;
    return i < j ? -1 : i > j ? 1 : 0;
  });
}
