/**
 * Rectangular grid selection and clipboard serialization.
 *
 * Positions are *view positions*: `row` is an index into the current visible
 * list (after search/filter/sort), `column` is a visible data column. Column
 * -1 addresses the record header. A range with either endpoint on the record
 * header spans the full row width, which is how a row header behaves in
 * spreadsheets — the header itself is a selector, never copied data.
 *
 * Keeping this pure lets the grid component stay a renderer and lets the
 * copy format be tested without a DOM (docs/decisions.md ADR-024).
 */
export type CellPos = { row: number; column: number };

export type GridSelection = { anchor: CellPos; focus: CellPos };

/** Inclusive rectangle in view-position space. */
export type SelectionBounds = { top: number; left: number; bottom: number; right: number };

export type SelectionSize = { rows: number; columns: number; cells: number };

/**
 * Copy guard. A larger range is refused with an explanation instead of being
 * silently truncated; Export CSV is the path for big extracts.
 */
export const MAX_COPY_CELLS = 100_000;

export function collapsed(pos: CellPos): GridSelection {
  return { anchor: pos, focus: pos };
}

export function rangeBetween(anchor: CellPos, focus: CellPos): GridSelection {
  return { anchor, focus };
}

/**
 * Whole row, anchored on the record header. The header column is a selector:
 * an endpoint at -1 makes the range span every visible data column, and a
 * drag from here keeps extending full rows instead of shrinking to a
 * rectangle that happens to end at one column.
 */
export function selectRow(row: number): GridSelection {
  const pos = { row, column: -1 };
  return { anchor: pos, focus: pos };
}

/** Every visible row and column of the current result set. */
export function selectAllRows(rowCount: number, columnCount: number): GridSelection {
  return {
    anchor: { row: 0, column: 0 },
    focus: { row: Math.max(0, rowCount - 1), column: Math.max(0, columnCount - 1) },
  };
}

/**
 * Normalizes a selection into a clamped inclusive rectangle. Counts are
 * clamped rather than trusted: a stale selection can outlive a shrinking
 * result set or a hidden column, and copy must never read past the view.
 */
export function boundsOf(
  selection: GridSelection,
  rowCount: number,
  columnCount: number,
): SelectionBounds {
  if (rowCount <= 0 || columnCount <= 0) {
    return { top: 0, left: 0, bottom: -1, right: -1 };
  }
  const top = Math.min(selection.anchor.row, selection.focus.row);
  const bottom = Math.max(selection.anchor.row, selection.focus.row);
  const fullWidth = selection.anchor.column < 0 || selection.focus.column < 0;
  const left = fullWidth ? 0 : Math.min(selection.anchor.column, selection.focus.column);
  const right = fullWidth
    ? columnCount - 1
    : Math.max(selection.anchor.column, selection.focus.column);
  return {
    top: Math.max(0, Math.min(top, rowCount - 1)),
    bottom: Math.max(0, Math.min(bottom, rowCount - 1)),
    left: Math.max(0, Math.min(left, columnCount - 1)),
    right: Math.max(0, Math.min(right, columnCount - 1)),
  };
}

export function selectionSize(bounds: SelectionBounds): SelectionSize {
  const rows = Math.max(0, bounds.bottom - bounds.top + 1);
  const columns = Math.max(0, bounds.right - bounds.left + 1);
  return { rows, columns, cells: rows * columns };
}

export function isInBounds(bounds: SelectionBounds, row: number, column: number): boolean {
  return (
    row >= bounds.top && row <= bounds.bottom && column >= bounds.left && column <= bounds.right
  );
}

/**
 * Scroll step for a drag that reaches the viewport edge. Distance into the
 * edge zone sets the speed (1–`maxStep` px per frame), so a selection can
 * extend past the rendered window without a sudden jump. Returns 0 inside
 * the zone, negative above/left of it, positive below/right.
 */
export function edgeScrollDelta(
  pointer: number,
  start: number,
  end: number,
  threshold = 32,
  maxStep = 16,
): number {
  if (end - start <= threshold * 2) return 0; // too small to have an inside
  if (pointer < start + threshold) {
    const intensity = Math.min(1, (start + threshold - pointer) / threshold);
    return -Math.max(1, Math.round(maxStep * intensity));
  }
  if (pointer > end - threshold) {
    const intensity = Math.min(1, (pointer - (end - threshold)) / threshold);
    return Math.max(1, Math.round(maxStep * intensity));
  }
  return 0;
}

/**
 * Quotes a field for a tab-separated clipboard payload. Spreadsheets parse
 * quoted TSV, so embedded tabs/newlines survive instead of shifting columns.
 */
export function escapeTsvField(value: string): string {
  if (/[\t\r\n"]/.test(value)) {
    return `"${value.replaceAll('"', '""')}"`;
  }
  return value;
}

/**
 * Serializes a selection to TSV with CRLF row separators (the convention
 * Excel/Sheets accept without prompting). Values are taken verbatim from the
 * accessor, so cleaning transforms that affect the displayed value are
 * reflected — copying never reaches behind what the user sees.
 */
export function buildSelectionTsv(
  bounds: SelectionBounds,
  valueAt: (row: number, column: number) => string,
): string {
  const lines: string[] = [];
  for (let row = bounds.top; row <= bounds.bottom; row += 1) {
    const cells: string[] = [];
    for (let column = bounds.left; column <= bounds.right; column += 1) {
      cells.push(escapeTsvField(valueAt(row, column)));
    }
    lines.push(cells.join('\t'));
  }
  return lines.join('\r\n');
}
