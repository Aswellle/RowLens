import { describe, expect, it } from 'vitest';
import type { ColumnId } from '../dataset/types';
import { runQueryEngine, type EngineRow, type QueryEngineSpec } from './engine';
import type { SearchTerm } from './search';

const COLUMNS: ColumnId[] = ['c0', 'c1', 'c2'];

function rows(table: (string | null)[][]): EngineRow[] {
  return table.map((values, rowIndex) => ({
    rowIndex,
    values: Object.fromEntries(COLUMNS.map((id, i) => [id, values[i] ?? null])) as Record<
      ColumnId,
      string | null
    >,
  }));
}

async function* batchesOf(batches: EngineRow[][]): AsyncGenerator<EngineRow[]> {
  for (const batch of batches) yield batch;
}

/** Term helpers keep the spec literals readable. */
const all = (text: string): SearchTerm => ({ kind: 'all', text });
const scoped = (index: number, text: string): SearchTerm => ({
  kind: 'columns',
  columnIndexes: [index],
  text,
});

async function run(
  table: (string | null)[][],
  spec: Partial<QueryEngineSpec>,
  options: {
    matchLimit?: number;
    isCancelled?: () => boolean;
    foldedAt?: (row: EngineRow, columnId: ColumnId) => string | null;
  } = {},
) {
  const engineOptions: {
    matchLimit: number;
    isCancelled?: () => boolean;
    foldedAt?: (row: EngineRow, columnId: ColumnId) => string | null;
  } = { matchLimit: options.matchLimit ?? 1000 };
  if (options.isCancelled) engineOptions.isCancelled = options.isCancelled;
  if (options.foldedAt) engineOptions.foldedAt = options.foldedAt;
  return runQueryEngine(
    batchesOf([rows(table)]),
    {
      columns: COLUMNS,
      searchTerms: [],
      columnFilters: {},
      ...spec,
    },
    engineOptions,
  );
}

describe('runQueryEngine matching', () => {
  const table = [
    ['open', 'emea', 'P1'],
    ['closed', 'amer', 'P2'],
    ['pending', 'emea', 'P3'],
    ['open', 'apac', 'P2'],
  ];

  it('returns all rows when no predicates are set', async () => {
    const result = await run(table, {});
    expect(result).toEqual({
      status: 'done',
      rowIndices: [0, 1, 2, 3],
      matched: 4,
      totalRows: 4,
    });
  });

  it('global search matches case-insensitively across every column', async () => {
    const result = await run(table, { searchTerms: [all('EMEA')] });
    expect(result.status).toBe('done');
    if (result.status === 'done') expect(result.rowIndices).toEqual([0, 2]);
  });

  it('column filters are literal substrings; empty entries are ignored', async () => {
    const result = await run(table, {
      columnFilters: { c0: 'open', c1: '', c2: 'P2' },
    });
    expect(result.status).toBe('done');
    if (result.status === 'done') expect(result.rowIndices).toEqual([3]);
    // 'open' + 'P1' matches row 0.
    const second = await run(table, { columnFilters: { c0: 'open', c2: 'P1' } });
    if (second.status === 'done') expect(second.rowIndices).toEqual([0]);
  });

  it('combines search with column filters (AND semantics)', async () => {
    const result = await run(table, { searchTerms: [all('e')], columnFilters: { c0: 'open' } });
    expect(result.status).toBe('done');
    if (result.status === 'done') expect(result.rowIndices).toEqual([0, 3]);
  });

  it('a column-targeted term matches only that column', async () => {
    // 'open' appears in column 0 of rows 0 and 3; a global search for 'open'
    // would match the same rows here, so the differentiator is a value that
    // exists only in another column.
    const scopedResult = await run(table, { searchTerms: [scoped(1, 'amer')] });
    expect(scopedResult.status).toBe('done');
    if (scopedResult.status === 'done') expect(scopedResult.rowIndices).toEqual([1]);

    // The same text lives in column 1 only, so scoping to column 0 finds nothing.
    const wrongColumn = await run(table, { searchTerms: [scoped(0, 'amer')] });
    if (wrongColumn.status === 'done') expect(wrongColumn.rowIndices).toEqual([]);
  });

  it('multiple terms AND together across different columns', async () => {
    const result = await run(table, { searchTerms: [scoped(0, 'open'), scoped(1, 'emea')] });
    if (result.status === 'done') expect(result.rowIndices).toEqual([0]);
  });

  it('a scoped search reads only its own column from the folded cache', async () => {
    // The foldedAt hook records which columns were consulted; a scoped term
    // must not fold unrelated columns (fewer cache reads on large datasets).
    const foldedColumns = new Set<ColumnId>();
    const result = await run(
      table,
      { searchTerms: [scoped(2, 'P2')] },
      {
        foldedAt: (_row, columnId) => {
          foldedColumns.add(columnId);
          return null;
        },
      },
    );
    expect(result.status).toBe('done');
    expect([...foldedColumns]).toEqual(['c2']);
  });

  it('treats missing cell values as non-matching for filters and search', async () => {
    const sparse = [
      ['a', null, 'x'],
      ['a', 'b', 'x'],
    ];
    const filtered = await run(sparse, { columnFilters: { c1: 'b' } });
    if (filtered.status === 'done') expect(filtered.rowIndices).toEqual([1]);
    const searched = await run(sparse, { searchTerms: [all('b')] });
    if (searched.status === 'done') expect(searched.rowIndices).toEqual([1]);
  });
});

describe('runQueryEngine sorting', () => {
  const table = [
    ['b', '1'],
    ['a', '2'],
    ['b', '3'],
    [null, '4'],
    ['a', '5'],
  ];

  it('sorts ascending, keeping equal values in original order', async () => {
    const result = await run(table, { sort: { columnIndex: 0, direction: 'asc' } });
    expect(result.status === 'done' && result.rowIndices).toEqual([1, 4, 0, 2, 3]);
  });

  it('sorts descending with missing values still last and ties stable', async () => {
    const result = await run(table, { sort: { columnIndex: 0, direction: 'desc' } });
    expect(result.status === 'done' && result.rowIndices).toEqual([0, 2, 1, 4, 3]);
  });

  it('sorts after filtering', async () => {
    const result = await run(table, {
      columnFilters: { c0: 'a' },
      sort: { columnIndex: 1, direction: 'desc' },
    });
    expect(result.status === 'done' && result.rowIndices).toEqual([4, 1]);
  });

  it('sorts by UTF-16 string order without numeric inference', async () => {
    const numeric = [
      ['9', 'x'],
      ['10', 'x'],
      ['00123', 'x'],
    ];
    const result = await run(numeric, { sort: { columnIndex: 0, direction: 'asc' } });
    expect(result.status === 'done' && result.rowIndices).toEqual([2, 1, 0]);
  });
});

describe('runQueryEngine limits and cancellation', () => {
  function wideTable(count: number): string[][] {
    return Array.from({ length: count }, () => ['v', 'v', 'v']);
  }

  it('reports an explicit limit instead of silently truncating', async () => {
    const result = await run(wideTable(50), {}, { matchLimit: 10 });
    expect(result).toEqual({ status: 'limit', matched: 11, limit: 10 });
  });

  it('stops scanning between batches when cancelled', async () => {
    const engineOptions: { matchLimit: number; isCancelled?: () => boolean } = {
      matchLimit: 1000,
    };
    let calls = 0;
    engineOptions.isCancelled = () => {
      calls += 1;
      return calls > 1; // let the first batch through, cancel before the second
    };
    const result = await runQueryEngine(
      batchesOf([rows(wideTable(10)), rows(wideTable(10))]),
      { columns: COLUMNS, searchTerms: [], columnFilters: {} },
      engineOptions,
    );
    expect(result.status).toBe('cancelled');
    if (result.status === 'cancelled') expect(result.scanned).toBe(10);
  });

  it('emits progress during long scans', async () => {
    const progress: Array<[number, number]> = [];
    const result = await runQueryEngine(
      batchesOf([rows(wideTable(12))]),
      { columns: COLUMNS, searchTerms: [], columnFilters: {} },
      {
        matchLimit: 1000,
        progressEvery: 5,
        onProgress: (scanned, matched) => progress.push([scanned, matched]),
      },
    );
    expect(result.status).toBe('done');
    expect(progress.length).toBeGreaterThan(0);
    expect(progress.at(-1)).toEqual([12, 12]);
  });
});

describe('runQueryEngine with cell edits', () => {
  const table = [
    ['open', 'emea', 'P1'],
    ['closed', 'latam', 'P2'],
    ['open', 'apac', 'P3'],
  ];

  it('searches the edited value instead of the stored one', async () => {
    const result = await runQueryEngine(
      batchesOf([rows(table)]),
      { columns: COLUMNS, searchTerms: [all('renamed')], columnFilters: {} },
      {
        matchLimit: 100,
        overrideFor: (rowIndex) => (rowIndex === 1 ? { c1: 'renamed' } : undefined),
      },
    );
    expect(result.status).toBe('done');
    if (result.status === 'done') expect(result.rowIndices).toEqual([1]);
  });

  it('stops matching a value the edit removed', async () => {
    const result = await runQueryEngine(
      batchesOf([rows(table)]),
      { columns: COLUMNS, searchTerms: [all('emea')], columnFilters: {} },
      {
        matchLimit: 100,
        // The first row's region is edited away from "emea".
        overrideFor: (rowIndex) => (rowIndex === 0 ? { c1: 'north' } : undefined),
      },
    );
    expect(result.status).toBe('done');
    if (result.status === 'done') expect(result.rowIndices).toEqual([]);
  });

  it('applies column filters to edited values', async () => {
    const result = await runQueryEngine(
      batchesOf([rows(table)]),
      { columns: COLUMNS, searchTerms: [], columnFilters: { c0: 'open' } },
      {
        matchLimit: 100,
        overrideFor: (rowIndex) => (rowIndex === 1 ? { c0: 'open' } : undefined),
      },
    );
    expect(result.status).toBe('done');
    if (result.status === 'done') expect(result.rowIndices).toEqual([0, 1, 2]);
  });

  it('sorts by the edited value', async () => {
    const result = await runQueryEngine(
      batchesOf([rows(table)]),
      {
        columns: COLUMNS,
        searchTerms: [],
        columnFilters: {},
        sort: { columnIndex: 1, direction: 'asc' },
      },
      {
        matchLimit: 100,
        // Row 2's region becomes the alphabetically first one.
        overrideFor: (rowIndex) => (rowIndex === 2 ? { c1: 'aardvark' } : undefined),
      },
    );
    expect(result.status).toBe('done');
    // aardvark (row 2), emea (row 0), latam (row 1).
    if (result.status === 'done') expect(result.rowIndices).toEqual([2, 0, 1]);
  });

  it('feeds the edited value to the cleaning transform', async () => {
    const seen: string[] = [];
    const result = await runQueryEngine(
      batchesOf([rows(table)]),
      { columns: COLUMNS, searchTerms: [], columnFilters: {} },
      {
        matchLimit: 100,
        overrideFor: (rowIndex) => (rowIndex === 0 ? { c2: '  padded  ' } : undefined),
        transform: (row) => {
          seen.push(row.values.c2 ?? '');
          return row;
        },
      },
    );
    expect(result.status).toBe('done');
    // Cleaning sees the edit before trimming it, exactly as the grid shows it.
    expect(seen[0]).toBe('  padded  ');
  });
});
