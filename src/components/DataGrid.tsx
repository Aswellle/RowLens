/**
 * Virtualized data grid built on @tanstack/react-virtual.
 *
 * Rendering is virtualized; querying is NOT this component's problem — it
 * receives a precomputed list of visible row indices (search/sort happen in
 * pure helpers / the query worker) and reads cells through a bounded
 * valueAt accessor. Nothing here pulls the whole table into React state (see
 * docs/decisions.md ADR-013).
 *
 * Semantics: WAI-ARIA grid pattern — role=grid/row/columnheader/gridcell,
 * aria-rowcount reflects the full dataset, rendered rows carry aria-rowindex,
 * sort state is exposed via aria-sort on the sorted column header.
 *
 * Interaction: roving tabindex over data cells and the row header (column -1).
 * Shift+arrows, Shift+click and drag extend a rectangular selection; Ctrl/Cmd+A
 * selects the whole view; Ctrl/Cmd+C copies the selection as TSV. Selection is
 * view-position based and clamped on read, so a shrinking result set can never
 * make copy read past what is displayed (ADR-024).
 */
import { useVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { RowIndex } from '../features/dataset/types';
import type { SortDirection } from '../features/query/types';
import { copyText } from '../features/grid/clipboard';
import {
  MAX_COPY_CELLS,
  boundsOf,
  buildSelectionTsv,
  collapsed,
  edgeScrollDelta,
  isInBounds,
  rangeBetween,
  selectAllRows,
  selectRow,
  selectionSize,
  type CellPos,
  type GridSelection,
} from '../features/grid/selection';

export type GridColumn = {
  id: string;
  label: string;
  /** Fixed pixel width; the grid scrolls horizontally when columns overflow. */
  width: number;
};

export type GridSort = {
  columnIndex: number;
  direction: SortDirection;
};

type DataGridProps = {
  columns: GridColumn[];
  /** Total records in the dataset (aria-rowcount), not the visible subset. */
  totalRowCount: number;
  /** Row indices currently visible (already searched/filtered/sorted). */
  visibleIndices: readonly RowIndex[];
  valueAt: (rowIndex: RowIndex, columnIndex: number) => string | null;
  /** Stable record label for the leading cell, e.g. "Record 12". */
  recordLabel: (rowIndex: RowIndex) => string;
  sort: GridSort | null;
  /** Cycle: click asc → desc → off; null clears the sort. */
  onSortChange: (sort: GridSort | null) => void;
};

const ROW_NUM_WIDTH = 110;
/** Row header column index in focus/selection coordinates. */
const HEADER_COLUMN = -1;

function focusSelector(row: number, column: number): string {
  return column === HEADER_COLUMN ? `[data-row-header="${row}"]` : `[data-cell="${row}-${column}"]`;
}

function samePos(a: CellPos, b: CellPos): boolean {
  return a.row === b.row && a.column === b.column;
}

export function DataGrid({
  columns,
  totalRowCount,
  visibleIndices,
  valueAt,
  recordLabel,
  sort,
  onSortChange,
}: DataGridProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: visibleIndices.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 36,
    overscan: 8,
  });

  const virtualRows = virtualizer.getVirtualItems();

  /**
   * Roving focus position over the *visible window* (row position, column
   * index; -1 is the record header). Arrow keys move it, Home/End jump within
   * a row, PageUp/PageDown by a screenful; the virtualizer scrolls the target
   * row into view so the focused cell always exists in the DOM.
   */
  const [focusPos, setFocusPos] = useState<CellPos>({ row: 0, column: 0 });
  const rowCount = visibleIndices.length;
  const columnCount = columns.length;
  const clampPos = (pos: CellPos): CellPos => ({
    row: Math.max(0, Math.min(pos.row, Math.max(0, rowCount - 1))),
    column: Math.max(HEADER_COLUMN, Math.min(pos.column, Math.max(HEADER_COLUMN, columnCount - 1))),
  });
  const clampedFocus = clampPos(focusPos);
  const focusRef = useRef(clampedFocus);
  focusRef.current = clampedFocus;

  /** Adopt a focus that arrived from the DOM (pointer, Tab, programmatic). */
  const adoptFocus = (pos: CellPos): void => {
    if (!samePos(focusRef.current, pos)) setFocusPos(pos);
  };

  const [selection, setSelection] = useState<GridSelection>(() => collapsed(clampedFocus));
  const [dragging, setDragging] = useState(false);
  const draggingRef = useRef(false);
  /** Latest pointer position over the grid, in client coordinates. */
  const dragPointerRef = useRef<{ x: number; y: number } | null>(null);

  /** Set when a keyboard move should focus the cell after the next render. */
  const pendingFocusRef = useRef(false);

  const [status, setStatus] = useState<string | null>(null);
  const statusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const announce = (message: string): void => {
    setStatus(message);
    if (statusTimerRef.current !== null) clearTimeout(statusTimerRef.current);
    statusTimerRef.current = setTimeout(() => setStatus(null), 4000);
  };
  useEffect(
    () => () => {
      if (statusTimerRef.current !== null) clearTimeout(statusTimerRef.current);
    },
    [],
  );

  const moveFocus = (row: number, column: number, extend: boolean): void => {
    const next = clampPos({ row, column });
    if (samePos(next, clampedFocus) && !extend) return;
    pendingFocusRef.current = true;
    setFocusPos(next);
    setSelection((current) => (extend ? { anchor: current.anchor, focus: next } : collapsed(next)));
    virtualizer.scrollToIndex(next.row, { align: 'auto' });
  };

  /**
   * Focus the roving cell once it exists in the rendered window.
   *
   * Focus is applied immediately and then checked on the next few frames: a
   * virtualized scroll pass can replace the row nodes right after we focus
   * them, which silently drops focus to <body>. The retry is deliberately
   * bounded and only fires when focus fell off the page — never when the user
   * moved it somewhere on purpose, or a later keypress would fight the user.
   */
  useEffect(() => {
    if (!pendingFocusRef.current) return;
    const container = scrollRef.current;
    if (!container) return;
    const selector = focusSelector(clampedFocus.row, clampedFocus.column);
    const initial = container.querySelector<HTMLElement>(selector);
    // Row not in the window yet — the next render (after scrolling) retries.
    if (!initial) return;
    initial.focus();
    pendingFocusRef.current = false;

    let frame = 0;
    let attempts = 0;
    const verify = (): void => {
      const active = document.activeElement;
      if (active !== null && active !== document.body) return; // focus stuck
      attempts += 1;
      if (attempts > 10) return;
      // Re-query: the row node may have been re-created by a scroll pass.
      container.querySelector<HTMLElement>(selector)?.focus();
      frame = requestAnimationFrame(verify);
    };
    frame = requestAnimationFrame(verify);
    return () => cancelAnimationFrame(frame);
  });

  // A new result set keeps the row position but the old rectangle no longer
  // describes those records; collapse to the active cell.
  const visibleKey = visibleIndices;
  useEffect(() => {
    setSelection(collapsed(focusRef.current));
  }, [visibleKey]);

  // Drag selection ends anywhere on the page, not just inside the grid.
  useEffect(() => {
    if (!dragging) return;
    const stop = (): void => {
      draggingRef.current = false;
      dragPointerRef.current = null;
      setDragging(false);
    };
    const track = (event: MouseEvent): void => {
      dragPointerRef.current = { x: event.clientX, y: event.clientY };
    };
    window.addEventListener('mouseup', stop);
    window.addEventListener('mousemove', track);
    return () => {
      window.removeEventListener('mouseup', stop);
      window.removeEventListener('mousemove', track);
    };
  }, [dragging]);

  /**
   * Resolves the grid position under a pointer. Used by auto-scroll while
   * dragging: after scrolling, the cell under the pointer is a different row,
   * so the selection follows the content instead of the mouse. When the
   * pointer sits over grid chrome (scrollbar, edge gutter) the nearest
   * rendered row in the scroll direction stands in, which is what the user
   * sees the pointer touching.
   */
  const pointerTarget = (x: number, y: number, scrolling: { dx: number; dy: number }): CellPos => {
    const element =
      typeof document.elementFromPoint === 'function' ? document.elementFromPoint(x, y) : null;
    const cellElement = element?.closest<HTMLElement>('[data-cell]');
    const cellRef = cellElement?.dataset.cell;
    if (cellRef !== undefined) {
      const [row, column] = cellRef.split('-').map(Number);
      if (row !== undefined && column !== undefined) return { row, column };
    }
    const headerElement = element?.closest<HTMLElement>('[data-row-header]');
    const headerRef = headerElement?.dataset.rowHeader;
    if (headerRef !== undefined) {
      const row = Number(headerRef);
      if (Number.isInteger(row)) return { row, column: HEADER_COLUMN };
    }
    const first = virtualRows[0];
    const last = virtualRows[virtualRows.length - 1];
    const row =
      scrolling.dy > 0 && last
        ? last.index
        : scrolling.dy < 0 && first
          ? first.index
          : clampedFocus.row;
    const column = scrolling.dx > 0 ? columnCount - 1 : scrolling.dx < 0 ? 0 : clampedFocus.column;
    return { row, column };
  };

  /**
   * Auto-scroll while dragging past the viewport edge. Without this a range
   * could never grow beyond the rendered window — the virtualizer only keeps
   * on-screen rows in the DOM. Each frame scrolls by a bounded step and
   * re-reads the cell now under the pointer.
   *
   * The frame loop runs outside React's render cycle, so it calls through a
   * ref to the newest closures; otherwise it would keep using the window and
   * selection from the render in which the drag started.
   */
  const dragStepRef = useRef<() => void>(() => {});
  dragStepRef.current = () => {
    const container = scrollRef.current;
    const pointer = dragPointerRef.current;
    if (!container || !pointer) return;
    const rect = container.getBoundingClientRect();
    const dx = edgeScrollDelta(pointer.x, rect.left, rect.right);
    const dy = edgeScrollDelta(pointer.y, rect.top, rect.bottom);
    if (dx === 0 && dy === 0) return;
    container.scrollLeft += dx;
    container.scrollTop += dy;
    extendTo(pointerTarget(pointer.x, pointer.y, { dx, dy }));
  };
  useEffect(() => {
    if (!dragging) return;
    let frame = 0;
    const step = (): void => {
      dragStepRef.current();
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [dragging]);

  const bounds = boundsOf(selection, rowCount, columnCount);
  const size = selectionSize(bounds);
  const hasRange = size.cells > 1;

  /** TSV for the current selection; shared by the button and the copy event. */
  const serializeSelection = (): string =>
    buildSelectionTsv(bounds, (row, column) => {
      const rowIndex = visibleIndices[row];
      if (rowIndex === undefined) return '';
      return valueAt(rowIndex, column) ?? '';
    });

  const tooManyToCopy = (): string =>
    `Selection has ${size.cells.toLocaleString('en-US')} cells — too many to copy at once. ` +
    'Narrow it, or use Export CSV.';

  const announceCopied = (copied: boolean): void => {
    announce(
      copied
        ? `Copied ${size.cells.toLocaleString('en-US')} cell${size.cells === 1 ? '' : 's'}.`
        : 'Copy failed — the clipboard is not available in this browser context.',
    );
  };

  const copySelection = (): void => {
    if (size.cells === 0) return;
    if (size.cells > MAX_COPY_CELLS) {
      announce(tooManyToCopy());
      return;
    }
    const tsv = serializeSelection();
    void copyText(tsv).then(announceCopied);
  };

  const onGridKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const { row, column } = clampedFocus;
    const page = Math.max(1, Math.floor((scrollRef.current?.clientHeight ?? 360) / 36) - 1);
    const extend = event.shiftKey;
    const selectAll = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a';
    if (selectAll) {
      // Focus deliberately stays on the active cell: jumping to the last row
      // would scroll the user away from where they were reading.
      setSelection(selectAllRows(rowCount, columnCount));
      event.preventDefault();
      return;
    }
    // Space on the record header (and Shift+Space anywhere) selects the whole
    // row — the keyboard equivalent of clicking the row header.
    if (event.key === ' ' && !event.metaKey && !event.ctrlKey && !event.altKey) {
      if (column === HEADER_COLUMN || extend) {
        setSelection(selectRow(row));
        event.preventDefault();
      }
      return;
    }
    if (event.key === 'Escape') {
      setSelection(collapsed(clampedFocus));
      return;
    }
    switch (event.key) {
      case 'ArrowDown':
        moveFocus(row + 1, column, extend);
        break;
      case 'ArrowUp':
        moveFocus(row - 1, column, extend);
        break;
      case 'ArrowRight':
        moveFocus(row, column + 1, extend);
        break;
      case 'ArrowLeft':
        moveFocus(row, column - 1, extend);
        break;
      case 'Home':
        moveFocus(row, 0, extend);
        break;
      case 'End':
        moveFocus(row, columnCount - 1, extend);
        break;
      case 'PageDown':
        moveFocus(row + page, column, extend);
        break;
      case 'PageUp':
        moveFocus(row - page, column, extend);
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  /**
   * Keyboard copy uses the synchronous `copy` event so the payload lands in
   * clipboardData without clipboard permissions; the explicit Copy button
   * covers pointer/mobile users and reuses the async API.
   */
  const onGridCopy = (event: React.ClipboardEvent<HTMLDivElement>): void => {
    if (size.cells === 0) return;
    if (size.cells > MAX_COPY_CELLS) {
      event.preventDefault();
      announce(tooManyToCopy());
      return;
    }
    const tsv = serializeSelection();
    // A synthetic copy event may arrive without clipboardData; fall back to
    // the async API rather than throwing inside a native event handler.
    if (!event.clipboardData) {
      event.preventDefault();
      void copyText(tsv).then(announceCopied);
      return;
    }
    event.clipboardData.setData('text/plain', tsv);
    event.preventDefault();
    announceCopied(true);
  };

  /** Shared mouse/keyboard entry for cells and the row header. */
  const beginPointerSelection = (pos: CellPos, event: React.MouseEvent): void => {
    if (event.button !== 0) return;
    // The per-cell Copy button lives inside a cell; clicking it must not
    // collapse the selection the user is about to copy.
    if ((event.target as Element).closest('button') !== null) return;
    const next = clampPos(pos);
    setFocusPos(next);
    // Seed the pointer position here: the auto-scroll loop starts from the
    // press point even if the next mousemove never reaches the grid (e.g. the
    // pointer is parked on the scrollbar).
    dragPointerRef.current = { x: event.clientX, y: event.clientY };
    if (event.shiftKey) {
      setSelection((current) => rangeBetween(current.anchor, next));
      return;
    }
    if (pos.column === HEADER_COLUMN) {
      // Row headers select and drag whole rows; the header is a selector, so
      // it never contributes a value to the clipboard.
      setSelection(selectRow(next.row));
      draggingRef.current = true;
      setDragging(true);
      return;
    }
    setSelection(collapsed(next));
    draggingRef.current = true;
    setDragging(true);
  };

  const extendTo = (pos: CellPos): void => {
    if (!draggingRef.current) return;
    const next = clampPos(pos);
    setFocusPos(next);
    setSelection((current) => rangeBetween(current.anchor, next));
  };

  const headerCells = useMemo(
    () =>
      columns.map((column, columnIndex) => {
        const isSorted = sort?.columnIndex === columnIndex;
        const ariaSort = isSorted
          ? sort.direction === 'asc'
            ? 'ascending'
            : 'descending'
          : 'none';
        const arrow = isSorted ? (sort.direction === 'asc' ? '▲' : '▼') : '▲';
        return (
          <div
            key={column.id}
            role="columnheader"
            aria-sort={ariaSort}
            style={{ width: column.width }}
          >
            <button
              type="button"
              onClick={() => {
                if (!isSorted) {
                  onSortChange({ columnIndex, direction: 'asc' });
                } else if (sort.direction === 'asc') {
                  onSortChange({ columnIndex, direction: 'desc' });
                } else {
                  onSortChange(null);
                }
              }}
              aria-label={`Sort by ${column.label}`}
            >
              <span className="truncate">{column.label}</span>
              <span className="grid-sort-arrow" aria-hidden="true">
                {arrow}
              </span>
            </button>
          </div>
        );
      }),
    [columns, sort, onSortChange],
  );

  return (
    <div className="grid-region">
      <div
        className={`grid-scroll${dragging ? ' grid-scroll--dragging' : ''}`}
        ref={scrollRef}
        role="grid"
        aria-label="Data grid"
        aria-rowcount={totalRowCount}
        aria-colcount={columns.length + 1}
        aria-multiselectable="true"
        tabIndex={0}
        onKeyDown={onGridKeyDown}
        onCopy={onGridCopy}
      >
        <div role="rowgroup" className="grid-table">
          <div role="row" style={{ display: 'flex', minWidth: 'max-content' }}>
            <div role="columnheader" aria-label="Record number" style={{ width: ROW_NUM_WIDTH }} />
            {headerCells}
          </div>
        </div>
        <div
          className="grid-body-window"
          style={{ height: `${virtualizer.getTotalSize()}px` }}
          role="rowgroup"
        >
          {virtualRows.map((virtualRow) => {
            const rowIndex = visibleIndices[virtualRow.index];
            if (rowIndex === undefined) return null;
            const rowInSelection =
              virtualRow.index >= bounds.top && virtualRow.index <= bounds.bottom;
            // The record header lights up only when the whole row is covered,
            // mirroring how spreadsheet row headers indicate row selection.
            const headerSelected =
              rowInSelection && bounds.left === 0 && bounds.right === columnCount - 1;
            return (
              <div
                key={rowIndex}
                role="row"
                aria-rowindex={virtualRow.index + 2} // +2: header row occupies row 1
                aria-selected={rowInSelection}
                className={`grid-row${virtualRow.index % 2 === 0 ? ' grid-row--even' : ''}`}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${virtualRow.start}px)`,
                }}
              >
                <div
                  role="rowheader"
                  data-row-header={virtualRow.index}
                  tabIndex={
                    virtualRow.index === clampedFocus.row && clampedFocus.column === HEADER_COLUMN
                      ? 0
                      : -1
                  }
                  className={`grid-cell grid-cell--rownum${
                    headerSelected ? ' grid-cell--selected' : ''
                  }`}
                  style={{ width: ROW_NUM_WIDTH }}
                  onMouseDown={(event) => {
                    beginPointerSelection({ row: virtualRow.index, column: HEADER_COLUMN }, event);
                    event.currentTarget.focus();
                  }}
                  onFocus={() => adoptFocus({ row: virtualRow.index, column: HEADER_COLUMN })}
                  onMouseEnter={() => extendTo({ row: virtualRow.index, column: HEADER_COLUMN })}
                >
                  {recordLabel(rowIndex)}
                </div>
                {columns.map((column, columnIndex) => {
                  const cellValue = valueAt(rowIndex, columnIndex) ?? '';
                  const selected = isInBounds(bounds, virtualRow.index, columnIndex);
                  const isAnchor =
                    selection.anchor.row === virtualRow.index &&
                    selection.anchor.column === columnIndex;
                  return (
                    <div
                      key={column.id}
                      role="gridcell"
                      data-cell={`${virtualRow.index}-${columnIndex}`}
                      aria-selected={selected}
                      tabIndex={
                        virtualRow.index === clampedFocus.row && columnIndex === clampedFocus.column
                          ? 0
                          : -1
                      }
                      className={`grid-cell${selected ? ' grid-cell--selected' : ''}${
                        isAnchor && hasRange ? ' grid-cell--anchor' : ''
                      }`}
                      style={{ width: column.width }}
                      title={valueAt(rowIndex, columnIndex) ?? undefined}
                      onMouseDown={(event) => {
                        beginPointerSelection(
                          { row: virtualRow.index, column: columnIndex },
                          event,
                        );
                        // Take focus synchronously: the grid container is also
                        // focusable and would otherwise swallow the click.
                        event.currentTarget.focus();
                      }}
                      // Any focus (pointer, Tab, programmatic) becomes the
                      // roving position so the next arrow key starts here.
                      onFocus={() => adoptFocus({ row: virtualRow.index, column: columnIndex })}
                      onMouseEnter={() => extendTo({ row: virtualRow.index, column: columnIndex })}
                    >
                      <span className="grid-cell__text truncate">{cellValue}</span>
                      <button
                        type="button"
                        className="grid-cell__copy"
                        aria-label={`Copy value of ${column.label} in ${recordLabel(rowIndex)}`}
                        onClick={() => {
                          void copyText(cellValue).then((copied) => {
                            announce(
                              copied
                                ? `Copied ${column.label} for ${recordLabel(rowIndex)}.`
                                : 'Copy failed — the clipboard is not available in this browser context.',
                            );
                          });
                        }}
                      >
                        Copy
                      </button>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
      {hasRange && (
        <div className="grid-selection-bar">
          <span className="num">
            {size.rows.toLocaleString('en-US')} × {size.columns.toLocaleString('en-US')} selected
          </span>
          <button type="button" className="btn btn--ghost" onClick={copySelection}>
            Copy
          </button>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => {
              setSelection(collapsed(clampedFocus));
              scrollRef.current?.focus();
            }}
          >
            Clear
          </button>
        </div>
      )}
      <div className="visually-hidden" role="status">
        {status ?? ''}
      </div>
    </div>
  );
}
