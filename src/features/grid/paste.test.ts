// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { blockWidth, describePaste, parseClipboardGrid, planPaste } from './paste';

describe('parseClipboardGrid', () => {
  it('parses a simple tab-separated block', () => {
    expect(parseClipboardGrid('a\tb\r\nc\td')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  it('accepts LF, CRLF and a lone CR as row separators', () => {
    const expected = [
      ['a', 'b'],
      ['c', 'd'],
    ];
    expect(parseClipboardGrid('a\tb\nc\td')).toEqual(expected);
    expect(parseClipboardGrid('a\tb\r\nc\td')).toEqual(expected);
    expect(parseClipboardGrid('a\tb\rc\td')).toEqual(expected);
  });

  it('drops the trailing line break instead of pasting a blank row', () => {
    expect(parseClipboardGrid('a\r\nb\r\n')).toEqual([['a'], ['b']]);
    expect(parseClipboardGrid('a\n')).toEqual([['a']]);
  });

  it('keeps blank lines inside the block as empty rows', () => {
    expect(parseClipboardGrid('a\n\nb')).toEqual([['a'], [''], ['b']]);
  });

  it('reads quoted fields containing tabs, newlines and doubled quotes', () => {
    expect(parseClipboardGrid('"a\tb"\t"line1\nline2"\t"say ""hi"""')).toEqual([
      ['a\tb', 'line1\nline2', 'say "hi"'],
    ]);
  });

  it('keeps empty fields so column positions stay aligned', () => {
    expect(parseClipboardGrid('a\t\tc')).toEqual([['a', '', 'c']]);
    expect(parseClipboardGrid('\t\t')).toEqual([['', '', '']]);
  });

  it('returns nothing for empty text', () => {
    expect(parseClipboardGrid('')).toEqual([]);
  });

  it('treats a lone quote inside an unquoted field literally', () => {
    expect(parseClipboardGrid('say "hi" now')).toEqual([['say "hi" now']]);
  });

  it('keeps values verbatim, including spaces and leading zeros', () => {
    expect(parseClipboardGrid('  007  \t=SUM(A1)')).toEqual([['  007  ', '=SUM(A1)']]);
  });

  it('reports the widest row of a ragged block', () => {
    expect(blockWidth([['a'], ['b', 'c', 'd'], []])).toBe(3);
    expect(blockWidth([])).toBe(0);
  });
});

describe('planPaste', () => {
  // A 10×5 visible view.
  const single = { top: 2, left: 1, bottom: 2, right: 1 };

  it('anchors a block at the active cell and spills right and down', () => {
    const plan = planPaste(
      [
        ['a', 'b'],
        ['c', 'd'],
      ],
      single,
      10,
      5,
    );
    expect(plan.tiled).toBe(false);
    expect(plan.cells).toEqual([
      { row: 2, column: 1, value: 'a' },
      { row: 2, column: 2, value: 'b' },
      { row: 3, column: 1, value: 'c' },
      { row: 3, column: 2, value: 'd' },
    ]);
    expect(plan.clippedRows).toBe(0);
    expect(plan.clippedColumns).toBe(0);
  });

  it('repeats a block to fill a multi-cell selection', () => {
    const plan = planPaste([['x']], { top: 0, left: 0, bottom: 2, right: 1 }, 10, 5);
    expect(plan.tiled).toBe(true);
    expect(plan.cells).toHaveLength(6);
    expect(plan.cells.every((cell) => cell.value === 'x')).toBe(true);
    expect(plan.cells.at(-1)).toEqual({ row: 2, column: 1, value: 'x' });
  });

  it('tiles a two-value block across a wider selection', () => {
    const plan = planPaste([['a', 'b']], { top: 0, left: 0, bottom: 1, right: 3 }, 10, 5);
    expect(plan.cells.map((cell) => cell.value)).toEqual(['a', 'b', 'a', 'b', 'a', 'b', 'a', 'b']);
  });

  it('clips at the view edge instead of wrapping to a hidden row', () => {
    // Two rows of a block pasted at the last visible row: the second is clipped.
    const plan = planPaste([['a'], ['b']], { top: 9, left: 0, bottom: 9, right: 0 }, 10, 5);
    expect(plan.cells).toEqual([{ row: 9, column: 0, value: 'a' }]);
    expect(plan.clippedRows).toBe(1);
    expect(plan.clippedColumns).toBe(0);
  });

  it('clips columns that fall outside the view', () => {
    const plan = planPaste([['a', 'b', 'c']], { top: 0, left: 3, bottom: 0, right: 3 }, 10, 5);
    expect(plan.cells).toEqual([
      { row: 0, column: 3, value: 'a' },
      { row: 0, column: 4, value: 'b' },
    ]);
    expect(plan.clippedColumns).toBe(1);
  });

  it('pads a ragged block with empty values', () => {
    const plan = planPaste([['a', 'b'], ['c']], single, 10, 5);
    expect(plan.cells.map((cell) => cell.value)).toEqual(['a', 'b', 'c', '']);
  });

  it('plans nothing for empty input or an empty view', () => {
    expect(planPaste([], single, 10, 5).cells).toEqual([]);
    expect(planPaste([['a']], { top: 0, left: 0, bottom: -1, right: -1 }, 0, 5).cells).toEqual([]);
  });
});

describe('describePaste', () => {
  it('reports the pasted count in singular and plural', () => {
    expect(
      describePaste({
        cells: [{ row: 0, column: 0, value: 'a' }],
        clippedRows: 0,
        clippedColumns: 0,
        tiled: false,
      }),
    ).toBe('Pasted 1 cell.');
    expect(
      describePaste({
        cells: [
          { row: 0, column: 0, value: 'a' },
          { row: 0, column: 1, value: 'b' },
        ],
        clippedRows: 0,
        clippedColumns: 0,
        tiled: false,
      }),
    ).toBe('Pasted 2 cells.');
  });

  it('says what was not pasted when the block overflowed the view', () => {
    const message = describePaste({
      cells: [{ row: 0, column: 0, value: 'a' }],
      clippedRows: 3,
      clippedColumns: 2,
      tiled: false,
    });
    expect(message).toContain('Pasted 1 cell.');
    expect(message).toContain('3 row(s) and 2 column(s) outside the view');
    expect(message).toContain('were not pasted');
  });

  it('handles an empty plan', () => {
    expect(describePaste({ cells: [], clippedRows: 0, clippedColumns: 0, tiled: false })).toBe(
      'Nothing to paste.',
    );
  });
});
