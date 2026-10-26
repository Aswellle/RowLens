/**
 * Clipboard paste into the grid (ADR-026).
 *
 * Parsing and planning are pure: the grid only decides *where* the paste
 * starts, and the parent only commits the resulting cell values. Keeping the
 * two apart means the tiling/clipping rules can be tested without a DOM, and
 * the paste never has to guess at what the user can see.
 *
 * Format: tab-separated with RFC 4180 quoting, which is exactly what RowLens
 * writes to the clipboard and what Excel, Numbers and Sheets put there. A
 * quoted field may contain tabs, newlines and doubled quotes. Values are taken
 * verbatim — no trimming, no type coercion — because a paste is data entry,
 * not a cleaning step.
 */
import type { SelectionBounds } from './selection';

export type PasteCell = { row: number; column: number; value: string };

export type PastePlan = {
  cells: PasteCell[];
  /** Rows/columns of the pasted block that fell outside the view. */
  clippedRows: number;
  clippedColumns: number;
  /** True when a multi-cell selection repeated the block to fill it. */
  tiled: boolean;
};

/**
 * Parses clipboard text into a rectangular grid of strings.
 *
 * Trailing line terminators are dropped: nearly every source ends with one,
 * and treating it as an empty row would paste a blank line under the data.
 * Blank lines *inside* the block are preserved as empty rows.
 */
export function parseClipboardGrid(text: string): string[][] {
  if (text === '') return [];
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let index = 0;

  const endField = (): void => {
    row.push(field);
    field = '';
  };
  const endRow = (): void => {
    endField();
    rows.push(row);
    row = [];
  };

  while (index < text.length) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        quoted = false;
        index += 1;
        continue;
      }
      field += char;
      index += 1;
      continue;
    }
    if (char === '"' && field === '') {
      quoted = true;
      index += 1;
      continue;
    }
    if (char === '\t') {
      endField();
      index += 1;
      continue;
    }
    if (char === '\r') {
      // CRLF and a lone CR both end the record.
      endRow();
      index += text[index + 1] === '\n' ? 2 : 1;
      continue;
    }
    if (char === '\n') {
      endRow();
      index += 1;
      continue;
    }
    field += char;
    index += 1;
  }

  // A block that ended with a line break has already flushed its last row.
  const endedWithBreak = text.endsWith('\n') || text.endsWith('\r');
  if (!endedWithBreak) endRow();

  return rows;
}

/** Width of the widest row; a ragged block pads with empty strings. */
export function blockWidth(block: readonly (readonly string[])[]): number {
  let width = 0;
  for (const row of block) width = Math.max(width, row.length);
  return width;
}

/**
 * Plans a paste into the current selection.
 *
 * - A single-cell selection anchors the block at that cell and spills right
 *   and down, which is how spreadsheets behave when one cell is active.
 * - A multi-cell selection is filled by repeating the block, so pasting one
 *   value into a 3×2 selection fills all six cells.
 * - Anything that would land outside the visible rows/columns is dropped and
 *   counted, never wrapped: a paste must not silently write to a row the user
 *   cannot see.
 */
export function planPaste(
  block: readonly (readonly string[])[],
  bounds: SelectionBounds,
  rowCount: number,
  columnCount: number,
): PastePlan {
  const width = blockWidth(block);
  const height = block.length;
  if (height === 0 || width === 0 || rowCount <= 0 || columnCount <= 0) {
    return { cells: [], clippedRows: 0, clippedColumns: 0, tiled: false };
  }

  const selectionRows = bounds.bottom - bounds.top + 1;
  const selectionColumns = bounds.right - bounds.left + 1;
  const tiled = selectionRows > 1 || selectionColumns > 1;

  // Target area: the selection when it is a real rectangle, otherwise the
  // block's own size starting at the active cell.
  const targetRows = tiled ? selectionRows : height;
  const targetColumns = tiled ? selectionColumns : width;

  const availableRows = rowCount - bounds.top;
  const availableColumns = columnCount - bounds.left;
  const usableRows = Math.min(targetRows, availableRows);
  const usableColumns = Math.min(targetColumns, availableColumns);

  const cells: PasteCell[] = [];
  for (let r = 0; r < usableRows; r += 1) {
    const sourceRow = block[r % height];
    for (let c = 0; c < usableColumns; c += 1) {
      const value = sourceRow?.[c % width] ?? '';
      cells.push({ row: bounds.top + r, column: bounds.left + c, value });
    }
  }

  return {
    cells,
    clippedRows: Math.max(0, targetRows - usableRows),
    clippedColumns: Math.max(0, targetColumns - usableColumns),
    tiled,
  };
}

/** Human-readable summary of what a paste will do, for the status line. */
export function describePaste(plan: PastePlan): string {
  if (plan.cells.length === 0) return 'Nothing to paste.';
  const count = plan.cells.length.toLocaleString('en-US');
  const clipped: string[] = [];
  if (plan.clippedRows > 0) clipped.push(`${plan.clippedRows} row(s)`);
  if (plan.clippedColumns > 0) clipped.push(`${plan.clippedColumns} column(s)`);
  const suffix =
    clipped.length > 0
      ? ` ${clipped.join(' and ')} outside the view ${clipped.length === 1 ? 'was' : 'were'} not pasted.`
      : '';
  return `Pasted ${count} cell${plan.cells.length === 1 ? '' : 's'}.${suffix}`;
}
