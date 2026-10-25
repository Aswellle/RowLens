/**
 * Pure query engine: literal global search + per-column literal filters +
 * stable sort, executed while streaming row batches (data contract §4).
 *
 * Runs identically inside the query worker (cursor-fed batches) and the
 * no-worker fallback (repository windows), so query semantics have exactly
 * one implementation. The matched-index list is capped by a verified limit:
 * exceeding it returns an explicit `limit` result — never a silent truncation.
 */
import type { ColumnId, RowIndex } from '../dataset/types';
import { matchesLiteral, rowMatchesSearch, sortIndicesStable } from './literal';
import type { SortDirection } from './types';
import type { QueryRequestSpec } from './protocol';

export type EngineRow = {
  rowIndex: RowIndex;
  values: Record<ColumnId, string | null>;
};

export type EngineSort = {
  /** Index into the spec's column-id list. */
  columnIndex: number;
  direction: SortDirection;
};

export type QueryEngineSpec = {
  /** Dataset column ids in display order. */
  columns: readonly ColumnId[];
  search: string;
  /** Non-empty entries are literal substring filters on that column. */
  columnFilters: Readonly<Partial<Record<ColumnId, string>>>;
  sort?: EngineSort;
};

export type EngineOptions = {
  matchLimit: number;
  onProgress?: (scanned: number, matched: number) => void;
  isCancelled?: () => boolean;
  /** Progress/reporting granularity in rows. */
  progressEvery?: number;
  /**
   * Optional cleaning pass applied to each row after search/filter match and
   * before sort-key capture; returning undefined drops the row. Sort keys and
   * the surviving index list therefore reflect cleaned values.
   */
  transform?: (row: EngineRow) => EngineRow | undefined;
};

export type EngineResult =
  | { status: 'done'; rowIndices: RowIndex[]; matched: number; totalRows: number }
  | { status: 'limit'; matched: number; limit: number }
  | { status: 'cancelled'; scanned: number };

type ActiveFilter = { columnId: ColumnId; needle: string };

export async function runQueryEngine(
  batches: AsyncIterable<readonly EngineRow[]>,
  spec: QueryEngineSpec,
  options: EngineOptions,
): Promise<EngineResult> {
  const activeFilters: ActiveFilter[] = Object.entries(spec.columnFilters)
    .filter((entry): entry is [ColumnId, string] => entry[1] !== '' && entry[1] !== undefined)
    .map(([columnId, needle]) => ({ columnId, needle: needle as string }));
  const hasSearch = spec.search !== '';
  const sortColumnId = spec.sort ? spec.columns[spec.sort.columnIndex] : undefined;

  const matchedIndices: RowIndex[] = [];
  const sortKeys = new Map<RowIndex, string | null>();
  let totalRows = 0;
  let exceeded = false;
  let sinceProgress = 0;
  const progressEvery = options.progressEvery ?? 5000;

  readLoop: for await (const batch of batches) {
    if (options.isCancelled?.()) return { status: 'cancelled', scanned: totalRows };

    for (const row of batch) {
      totalRows += 1;
      if (hasSearch) {
        const cells = spec.columns.map((id) => row.values[id] ?? null);
        if (!rowMatchesSearch(cells, spec.search)) continue;
      }
      let matches = true;
      for (const filter of activeFilters) {
        const value = row.values[filter.columnId] ?? null;
        if (!matchesLiteral(value, filter.needle)) {
          matches = false;
          break;
        }
      }
      if (!matches) continue;

      let effective: EngineRow = row;
      if (options.transform) {
        const transformed = options.transform(row);
        if (transformed === undefined) continue; // dropped by a cleaning step
        effective = transformed;
      }

      matchedIndices.push(effective.rowIndex);
      if (spec.sort && sortColumnId !== undefined) {
        sortKeys.set(effective.rowIndex, effective.values[sortColumnId] ?? null);
      }
      if (matchedIndices.length > options.matchLimit) {
        exceeded = true;
        break readLoop;
      }
    }

    sinceProgress += batch.length;
    if (sinceProgress >= progressEvery) {
      sinceProgress = 0;
      options.onProgress?.(totalRows, matchedIndices.length);
    }
  }

  if (exceeded) {
    return { status: 'limit', matched: matchedIndices.length, limit: options.matchLimit };
  }

  const rowIndices = spec.sort
    ? sortIndicesStable(
        matchedIndices,
        (rowIndex) => sortKeys.get(rowIndex) ?? null,
        spec.sort.direction,
      )
    : matchedIndices;

  return {
    status: 'done',
    rowIndices,
    matched: matchedIndices.length,
    totalRows,
  };
}

/** Adapt the wire spec to the engine spec (keeps optional keys exact). */
export function requestToEngineSpec(spec: QueryRequestSpec): QueryEngineSpec {
  const engineSpec: QueryEngineSpec = {
    columns: spec.columns,
    search: spec.search,
    columnFilters: spec.columnFilters,
  };
  if (spec.sort) engineSpec.sort = spec.sort;
  return engineSpec;
}
