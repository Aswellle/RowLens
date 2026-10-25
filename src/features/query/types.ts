/**
 * Query configuration contracts (search / column filter / stable sort).
 *
 * Contract source: PRD FR-04 and docs/03-data-processing-contracts.md §4:
 * - Search and filters are literal, case-insensitive substrings; the input is
 *   never interpreted as a regular expression.
 * - An empty filter value means "no restriction on this column".
 * - Sorting is stable UTF-16 string order; equal values keep original
 *   rowIndex order; missing values sort last in both directions.
 */
import type { ColumnId } from '../dataset/types';

export type SortDirection = 'asc' | 'desc';

export type SortSpec = {
  columnId: ColumnId;
  direction: SortDirection;
};

export type QueryConfig = {
  /** Global literal substring across all columns; empty/undefined = no search. */
  search: string;
  /** Per-column literal substring filters; empty string entries are ignored. */
  columnFilters: Readonly<Record<ColumnId, string>>;
  /** Currently active sort; absent = original import order. */
  sort?: SortSpec;
};
