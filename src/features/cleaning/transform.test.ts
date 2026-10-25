import { describe, expect, it } from 'vitest';
import type { ColumnId } from '../dataset/types';
import type { EngineRow } from '../query/engine';
import { createCleaningTransform } from './transform';
import type { CleaningStep } from './types';

const COLUMNS: ColumnId[] = ['c0', 'c1', 'c2'];

function row(rowIndex: number, values: (string | null)[]): EngineRow {
  const record: Record<ColumnId, string | null> = {};
  values.forEach((value, i) => {
    record[COLUMNS[i] ?? ''] = value;
  });
  return { rowIndex, values: record };
}

function runAll(steps: CleaningStep[], rows: EngineRow[]) {
  const transform = createCleaningTransform(steps, COLUMNS);
  const survivors = [];
  for (const input of rows) {
    const output = transform.process(input);
    if (output) survivors.push(output);
  }
  return { survivors, summaries: transform.summaries() };
}

const TRIM_ALL: CleaningStep = {
  id: 's1',
  type: 'trim',
  enabled: true,
  scope: { kind: 'all-columns' },
};

describe('trim', () => {
  it('trims only leading and trailing whitespace, counting changed cells', () => {
    const { survivors, summaries } = runAll(
      [TRIM_ALL],
      [row(0, ['  pad  ', 'keep inner  space', null]), row(1, ['clean', 'also clean', 'x'])],
    );
    expect(survivors[0]?.values.c0).toBe('pad');
    expect(survivors[0]?.values.c1).toBe('keep inner  space'); // inner spaces kept
    expect(survivors[0]?.values.c2).toBeNull(); // nulls untouched
    expect(survivors[1]?.values.c0).toBe('clean');
    expect(summaries).toEqual([{ stepId: 's1', rowsRemoved: 0, cellsChanged: 1 }]);
  });

  it('scopes to selected columns only', () => {
    const step: CleaningStep = {
      ...TRIM_ALL,
      scope: { kind: 'columns', columnIds: ['c1'] },
    };
    const { survivors } = runAll([step], [row(0, ['  x  ', '  y  ', '  z  '])]);
    expect(survivors[0]?.values.c0).toBe('  x  ');
    expect(survivors[0]?.values.c1).toBe('y');
    expect(survivors[0]?.values.c2).toBe('  z  ');
  });
});

describe('remove empty rows', () => {
  const STEP: CleaningStep = {
    id: 's1',
    type: 'remove-empty-rows',
    enabled: true,
    scope: { kind: 'all-columns' },
  };

  it('removes rows whose values are all null, empty or whitespace', () => {
    const { survivors, summaries } = runAll(
      [STEP],
      [
        row(0, ['a', 'b', 'c']),
        row(1, ['', '   ', null]),
        row(2, [null, null, null]),
        row(3, ['a', '', '']),
      ],
    );
    expect(survivors.map((r) => r.rowIndex)).toEqual([0, 3]);
    expect(summaries[0]?.rowsRemoved).toBe(2);
  });

  it('with a column scope, other columns having values does not save the row', () => {
    const step: CleaningStep = {
      ...STEP,
      scope: { kind: 'columns', columnIds: ['c0', 'c1'] },
    };
    const { survivors } = runAll(
      [step],
      [row(0, ['', '', 'important']), row(1, ['', 'x', 'important'])],
    );
    expect(survivors.map((r) => r.rowIndex)).toEqual([1]);
  });

  it('a blank row survives when no columns are in scope', () => {
    const step: CleaningStep = {
      ...STEP,
      scope: { kind: 'columns', columnIds: [] },
    };
    const { survivors } = runAll([step], [row(0, [null, null, null])]);
    expect(survivors).toHaveLength(1);
  });
});

describe('remove duplicates', () => {
  const STEP: CleaningStep = {
    id: 's1',
    type: 'remove-duplicates',
    enabled: true,
    keys: { kind: 'all-columns' },
    compare: 'exact',
  };

  it('keeps the first occurrence in order and reports removed rows', () => {
    const { survivors, summaries } = runAll(
      [STEP],
      [row(0, ['a', '1']), row(1, ['a', '1']), row(2, ['a', '2']), row(3, ['a', '1'])],
    );
    expect(survivors.map((r) => r.rowIndex)).toEqual([0, 2]);
    expect(summaries[0]?.rowsRemoved).toBe(2);
  });

  it('key-column mode ignores differences outside the keys', () => {
    const step: CleaningStep = {
      ...STEP,
      keys: { kind: 'columns', columnIds: ['c0'] },
    };
    const { survivors } = runAll(
      [step],
      [row(0, ['k', 'x']), row(1, ['k', 'y']), row(2, ['z', 'z'])],
    );
    expect(survivors.map((r) => r.rowIndex)).toEqual([0, 2]);
  });

  it('exact comparison treats padded values as distinct; trimmed does not', () => {
    const rows = [row(0, ['a', '1']), row(1, [' a', '1'])];
    expect(runAll([STEP], rows).survivors).toHaveLength(2);
    const trimmed: CleaningStep = { ...STEP, compare: 'trimmed' };
    expect(runAll([trimmed], rows).survivors).toHaveLength(1);
  });

  it('distinguishes value tuples that would collide under naive joining', () => {
    // ["a\u0000b","c"] vs ["a","b\u0000c"] must not collide.
    const { survivors } = runAll([STEP], [row(0, ['a\u0000b', 'c']), row(1, ['a', 'b\u0000c'])]);
    expect(survivors).toHaveLength(2);
  });
});

describe('select columns', () => {
  const STEP: CleaningStep = {
    id: 's1',
    type: 'select-columns',
    enabled: true,
    columnIds: ['c2', 'c0'],
  };

  it('projects values and reports kept columns', () => {
    const { survivors, summaries } = runAll([STEP], [row(0, ['a', 'b', 'c'])]);
    expect(survivors[0]?.values).toEqual({ c2: 'c', c0: 'a' });
    expect('c1' in (survivors[0]?.values ?? {})).toBe(false);
    expect(summaries[0]?.columnsKept).toBe(2);
  });

  it('narrows what later all-columns steps see', () => {
    const dedupeAfterSelect: CleaningStep = {
      id: 's2',
      type: 'remove-duplicates',
      enabled: true,
      keys: { kind: 'all-columns' },
      compare: 'exact',
    };
    const { survivors } = runAll(
      [STEP, dedupeAfterSelect],
      [row(0, ['k', 'differs', 'v']), row(1, ['k', 'also differs', 'v'])],
    );
    // c1 dropped by select; remaining (c2,c0) equal -> second row is a dup.
    expect(survivors.map((r) => r.rowIndex)).toEqual([0]);
  });
});

describe('pipeline composition and serialisation', () => {
  const STEPS: CleaningStep[] = [
    TRIM_ALL,
    {
      id: 's2',
      type: 'remove-empty-rows',
      enabled: true,
      scope: { kind: 'all-columns' },
    },
    {
      id: 's3',
      type: 'remove-duplicates',
      enabled: true,
      keys: { kind: 'all-columns' },
      compare: 'trimmed',
    },
  ];

  const ROWS: EngineRow[] = [
    row(0, ['  a ', '', '  ']), // trims to (a,'','') -> all blank? c0='a' -> kept; dup-key later
    row(1, ['a', '   ', '']), // trims to (a,'','') -> duplicate of row 0
    row(2, [' ', '  ', null]), // trims to blanks -> removed by empty-rows
    row(3, ['b', 'x', 'y']), // unique
  ];

  it('runs steps sequentially with attributed summaries', () => {
    const { survivors, summaries } = runAll(STEPS, ROWS);
    expect(survivors.map((r) => r.rowIndex)).toEqual([0, 3]);
    expect(summaries).toEqual([
      // row0: 2 cells; row1: 1 cell; row2: 2 cells; row3: none.
      { stepId: 's1', rowsRemoved: 0, cellsChanged: 5 },
      { stepId: 's2', rowsRemoved: 1, cellsChanged: 0 },
      { stepId: 's3', rowsRemoved: 1, cellsChanged: 0 },
    ]);
  });

  it('reproduces identical results after a JSON round-trip', () => {
    const roundTripped = JSON.parse(JSON.stringify(STEPS)) as CleaningStep[];
    const first = runAll(STEPS, ROWS);
    const second = runAll(roundTripped, ROWS);
    expect(second.survivors).toEqual(first.survivors);
    expect(second.summaries).toEqual(first.summaries);
  });

  it('disabled steps are skipped but keep their configuration', () => {
    const disabled = STEPS.map((step) => (step.id === 's1' ? { ...step, enabled: false } : step));
    const { survivors, summaries } = runAll(disabled, ROWS);
    // s3 compares trimmed values itself, so rows 0 and 1 still collapse; the
    // point is that s1 no longer runs (no cells changed, absent from summaries)
    // while s2 still removes the blank row 2.
    expect(survivors.map((r) => r.rowIndex)).toEqual([0, 3]);
    expect(summaries).toEqual([
      { stepId: 's2', rowsRemoved: 1, cellsChanged: 0 },
      { stepId: 's3', rowsRemoved: 1, cellsChanged: 0 },
    ]);
  });
});
