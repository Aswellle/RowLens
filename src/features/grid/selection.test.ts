// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  MAX_COPY_CELLS,
  boundsOf,
  buildSelectionTsv,
  collapsed,
  edgeScrollDelta,
  escapeTsvField,
  isInBounds,
  rangeBetween,
  selectAllRows,
  selectRow,
  selectionSize,
} from './selection';

describe('selection bounds', () => {
  it('normalizes a range regardless of drag direction', () => {
    const forward = boundsOf(rangeBetween({ row: 1, column: 1 }, { row: 3, column: 2 }), 10, 5);
    const backward = boundsOf(rangeBetween({ row: 3, column: 2 }, { row: 1, column: 1 }), 10, 5);
    expect(forward).toEqual({ top: 1, left: 1, bottom: 3, right: 2 });
    expect(backward).toEqual(forward);
  });

  it('spans the full row width when an endpoint is the record header', () => {
    const fromHeader = boundsOf(
      rangeBetween({ row: 2, column: -1 }, { row: 2, column: -1 }),
      10,
      4,
    );
    expect(fromHeader).toEqual({ top: 2, left: 0, bottom: 2, right: 3 });

    // A header row dragged down to a data cell covers whole rows.
    const dragged = boundsOf(rangeBetween({ row: 2, column: -1 }, { row: 4, column: 1 }), 10, 4);
    expect(dragged).toEqual({ top: 2, left: 0, bottom: 4, right: 3 });
  });

  it('anchors a row selection on the header so dragging keeps whole rows', () => {
    const row = selectRow(2);
    expect(row).toEqual({ anchor: { row: 2, column: -1 }, focus: { row: 2, column: -1 } });
    const dragged = boundsOf(rangeBetween(row.anchor, { row: 5, column: 2 }), 10, 4);
    expect(dragged).toEqual({ top: 2, left: 0, bottom: 5, right: 3 });
  });

  it('clamps to the current view instead of trusting stale positions', () => {
    // A selection can outlive a shrinking result set or hidden columns.
    const stale = boundsOf(rangeBetween({ row: 0, column: 0 }, { row: 900, column: 40 }), 5, 3);
    expect(stale).toEqual({ top: 0, left: 0, bottom: 4, right: 2 });
  });

  it('reports an empty rectangle for an empty view', () => {
    const empty = boundsOf(selectAllRows(0, 8), 0, 8);
    expect(empty).toEqual({ top: 0, left: 0, bottom: -1, right: -1 });
    expect(selectionSize(empty)).toEqual({ rows: 0, columns: 0, cells: 0 });
  });

  it('counts a whole-row and a whole-view selection', () => {
    expect(selectionSize(boundsOf(selectRow(3), 10, 4))).toEqual({
      rows: 1,
      columns: 4,
      cells: 4,
    });
    expect(selectionSize(boundsOf(selectAllRows(10, 4), 10, 4))).toEqual({
      rows: 10,
      columns: 4,
      cells: 40,
    });
  });

  it('answers containment only inside the rectangle', () => {
    const bounds = boundsOf(collapsed({ row: 2, column: 1 }), 10, 4);
    expect(isInBounds(bounds, 2, 1)).toBe(true);
    expect(isInBounds(bounds, 1, 1)).toBe(false);
    expect(isInBounds(bounds, 2, 2)).toBe(false);
  });

  it('keeps the copy cap as a documented constant', () => {
    expect(MAX_COPY_CELLS).toBe(100_000);
  });
});

describe('TSV serialization', () => {
  it('joins cells with tabs and rows with CRLF', () => {
    const tsv = buildSelectionTsv(
      { top: 0, left: 0, bottom: 1, right: 1 },
      (row, column) => `${row}:${column}`,
    );
    expect(tsv).toBe('0:0\t0:1\r\n1:0\t1:1');
  });

  it('quotes fields containing tabs, newlines or quotes', () => {
    expect(escapeTsvField('plain')).toBe('plain');
    expect(escapeTsvField('a\tb')).toBe('"a\tb"');
    expect(escapeTsvField('a\nb')).toBe('"a\nb"');
    expect(escapeTsvField('say "hi"')).toBe('"say ""hi"""');
  });

  it('copies a single cell without a trailing separator', () => {
    const tsv = buildSelectionTsv({ top: 4, left: 2, bottom: 4, right: 2 }, () => 'only');
    expect(tsv).toBe('only');
  });

  it('copies values verbatim, including leading zeros and formula text', () => {
    const values = ['00123', '=SUM(A1:A2)', ''];
    const tsv = buildSelectionTsv({ top: 0, left: 0, bottom: 0, right: 2 }, (_row, column) =>
      String(values[column]),
    );
    expect(tsv).toBe('00123\t=SUM(A1:A2)\t');
  });
});

describe('drag edge scrolling', () => {
  // Viewport spans 100..500, edge zone 32px on each side.
  const start = 100;
  const end = 500;

  it('does not scroll while the pointer is inside the view', () => {
    expect(edgeScrollDelta(300, start, end)).toBe(0);
    expect(edgeScrollDelta(150, start, end)).toBe(0);
    expect(edgeScrollDelta(450, start, end)).toBe(0);
  });

  it('scrolls up/left above the top edge and down/right below the bottom edge', () => {
    expect(edgeScrollDelta(80, start, end)).toBeLessThan(0);
    expect(edgeScrollDelta(520, start, end)).toBeGreaterThan(0);
  });

  it('speeds up the further the pointer moves past the edge', () => {
    const near = edgeScrollDelta(120, start, end);
    const far = edgeScrollDelta(60, start, end);
    expect(Math.abs(far)).toBeGreaterThan(Math.abs(near));
    // Bounded so a drag cannot teleport the selection across the dataset.
    expect(Math.abs(edgeScrollDelta(-5000, start, end))).toBeLessThanOrEqual(16);
  });

  it('never scrolls in a viewport too small to have an inside', () => {
    expect(edgeScrollDelta(110, 100, 150)).toBe(0);
    expect(edgeScrollDelta(20, 100, 150)).toBe(0);
  });
});
