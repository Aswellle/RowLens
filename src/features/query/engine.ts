/**
 * Pure query engine: literal search terms (global or column-targeted) +
 * per-column literal filters + stable sort, executed while streaming row
 * batches (data contract §4, ADR-034).
 *
 * Runs identically inside the query worker (cursor-fed batches) and the
 * no-worker fallback (repository windows), so query semantics have exactly
 * one implementation. The matched-index list is capped by a verified limit:
 * exceeding it returns an explicit `limit` result — never a silent truncation.
 */
import type { ColumnId, RowIndex } from '../dataset/types';
import { sortIndicesStable } from './literal';
import { sortIndicesNumeric } from './numeric';
import type { SortDirection } from './types';
import type { QueryRequestSpec } from './protocol';
import type { SearchTerm } from './search';

export type EngineRow = {
  rowIndex: RowIndex;
  values: Record<ColumnId, string | null>;
};

export type EngineSort = {
  /** Index into the spec's column-id list. */
  columnIndex: number;
  direction: SortDirection;
  /** Explicit numeric mode (ADR-035); the engine never infers it. */
  numeric: boolean;
};

export type QueryEngineSpec = {
  /** Dataset column ids in display order. */
  columns: readonly ColumnId[];
  /** One term per whitespace-separated token; all must match (ADR-034). */
  searchTerms: readonly SearchTerm[];
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
  /**
   * Optional case-folded value lookup used by search and filters. When
   * provided, the engine consults it instead of folding each cell on every
   * comparison — lets a worker amortise folding into a per-dataset cache.
   */
  foldedAt?: (row: EngineRow, columnId: ColumnId) => string | null;
  /**
   * Optional per-row cell overrides (user edits). Applied before search,
   * filters, sort keys and cleaning, so every downstream stage sees the edited
   * value — an edited cell can make a row match a search it previously missed.
   */
  overrideFor?: (rowIndex: RowIndex) => Record<ColumnId, string> | undefined;
};

export type EngineResult =
  | { status: 'done'; rowIndices: RowIndex[]; matched: number; totalRows: number }
  | { status: 'limit'; matched: number; limit: number }
  | { status: 'cancelled'; scanned: number };

type ActiveFilter = { columnId: ColumnId; foldedNeedle: string };

/** A search term resolved against the spec's column list, needle pre-folded. */
type PreparedTerm = {
  kind: SearchTerm['kind'];
  foldedText: string;
  /** Set only for column-targeted terms: every column sharing that header. */
  columnIds?: readonly (ColumnId | undefined)[];
};

export async function runQueryEngine(
  batches: AsyncIterable<readonly EngineRow[]>,
  spec: QueryEngineSpec,
  options: EngineOptions,
): Promise<EngineResult> {
  const activeFilters: ActiveFilter[] = Object.entries(spec.columnFilters)
    .filter((entry): entry is [ColumnId, string] => entry[1] !== '' && entry[1] !== undefined)
    .map(([columnId, needle]) => ({
      columnId,
      foldedNeedle: (needle as string).toLocaleLowerCase('en-US'),
    }));
  /**
   * Search prepared once: which columns each term may match, with the needle
   * folded. A column-targeted term folds only its own columns, so a scoped
   * search reads fewer cache entries than a global one.
   */
  const searchTerms: PreparedTerm[] = spec.searchTerms.map((term) => {
    if (term.kind === 'columns') {
      return {
        kind: 'columns',
        foldedText: term.text.toLocaleLowerCase('en-US'),
        columnIds: term.columnIndexes.map((index) => spec.columns[index]),
      };
    }
    return { kind: 'all', foldedText: term.text.toLocaleLowerCase('en-US') };
  });
  const hasSearch = searchTerms.length > 0;
  const sortColumnId = spec.sort ? spec.columns[spec.sort.columnIndex] : undefined;

  const matchedIndices: RowIndex[] = [];
  const sortKeys = new Map<RowIndex, string | null>();
  let totalRows = 0;
  let exceeded = false;
  let sinceProgress = 0;
  const progressEvery = options.progressEvery ?? 5000;

  readLoop: for await (const batch of batches) {
    if (options.isCancelled?.()) return { status: 'cancelled', scanned: totalRows };

    for (const scannedRow of batch) {
      totalRows += 1;
      // Edits are applied first so search, filters, sort and cleaning all see
      // the value the user is actually looking at.
      const override = options.overrideFor?.(scannedRow.rowIndex);
      const row =
        override === undefined
          ? scannedRow
          : { ...scannedRow, values: { ...scannedRow.values, ...override } };
      if (hasSearch) {
        // Every term must match; a term matches when ANY of its columns does.
        let allTermsMatch = true;
        for (const term of searchTerms) {
          const candidates = term.columnIds ?? spec.columns;
          let found = false;
          for (const id of candidates) {
            if (id === undefined) continue;
            const folded =
              options.foldedAt !== undefined
                ? options.foldedAt(row, id)
                : ((row.values[id] ?? null)?.toLocaleLowerCase('en-US') ?? null);
            if (folded !== null && folded.includes(term.foldedText)) {
              found = true;
              break;
            }
          }
          if (!found) {
            allTermsMatch = false;
            break;
          }
        }
        if (!allTermsMatch) continue;
      }
      let matches = true;
      for (const filter of activeFilters) {
        const folded =
          options.foldedAt !== undefined
            ? options.foldedAt(row, filter.columnId)
            : ((row.values[filter.columnId] ?? null)?.toLocaleLowerCase('en-US') ?? null);
        if (folded === null || !folded.includes(filter.foldedNeedle)) {
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

  // The sort type is the user's explicit choice (ADR-035): numeric mode
  // parses keys and partitions what does not parse; the plain mode keeps the
  // contract's UTF-16 string order. Both are stable.
  const rowIndices = spec.sort
    ? spec.sort.numeric
      ? sortIndicesNumeric(
          matchedIndices,
          (rowIndex) => sortKeys.get(rowIndex) ?? null,
          spec.sort.direction,
        )
      : sortIndicesStable(
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
    searchTerms: spec.searchTerms,
    columnFilters: spec.columnFilters,
  };
  if (spec.sort) engineSpec.sort = spec.sort;
  return engineSpec;
}
