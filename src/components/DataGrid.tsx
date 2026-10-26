/**
 * Virtualized data grid built on @tanstack/react-virtual.
 *
 * Rendering is virtualized; querying is NOT this component's problem — it
 * receives a precomputed list of visible row indices (search/sort happen in
 * pure helpers / later in the query worker) and reads cells through a
 * bounded valueAt accessor. Nothing here pulls the whole table into React
 * state (see docs/decisions.md ADR-013).
 *
 * Semantics: WAI-ARIA grid pattern — role=grid/row/columnheader/gridcell,
 * aria-rowcount reflects the full dataset, rendered rows carry aria-rowindex,
 * sort state is exposed via aria-sort on the sorted column header.
 */
import { useVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { RowIndex } from '../features/dataset/types';
import type { SortDirection } from '../features/query/types';

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

/** execCommand fallback for non-secure contexts where the Clipboard API is absent. */
function copyFallback(text: string): void {
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.append(area);
  area.select();
  try {
    document.execCommand('copy');
  } finally {
    area.remove();
  }
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
   * index). Arrow keys move it, Home/End jump within a row, PageUp/PageDown
   * by a screenful; the virtualizer scrolls the target row into view so the
   * focused cell always exists in the DOM.
   */
  const [focusPos, setFocusPos] = useState<{ row: number; column: number }>({
    row: 0,
    column: 0,
  });
  const rowCount = visibleIndices.length;
  const columnCount = columns.length;
  const clampedFocus = {
    row: Math.max(0, Math.min(focusPos.row, Math.max(0, rowCount - 1))),
    column: Math.max(0, Math.min(focusPos.column, Math.max(0, columnCount - 1))),
  };

  /** Set when a keyboard move should focus the cell after the next render. */
  const pendingFocusRef = useRef(false);

  const moveFocus = (row: number, column: number): void => {
    const nextRow = Math.max(0, Math.min(row, Math.max(0, rowCount - 1)));
    const nextColumn = Math.max(0, Math.min(column, Math.max(0, columnCount - 1)));
    if (nextRow === clampedFocus.row && nextColumn === clampedFocus.column) return;
    pendingFocusRef.current = true;
    setFocusPos({ row: nextRow, column: nextColumn });
    virtualizer.scrollToIndex(nextRow, { align: 'auto' });
  };

  // Focus the roving cell once it exists in the rendered window.
  useEffect(() => {
    if (!pendingFocusRef.current) return;
    const cell = scrollRef.current?.querySelector<HTMLElement>(
      `[data-cell="${clampedFocus.row}-${clampedFocus.column}"]`,
    );
    if (cell) {
      pendingFocusRef.current = false;
      cell.focus();
    }
  });

  const onGridKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const { row, column } = clampedFocus;
    const page = Math.max(1, Math.floor((scrollRef.current?.clientHeight ?? 360) / 36) - 1);
    switch (event.key) {
      case 'ArrowDown':
        moveFocus(row + 1, column);
        break;
      case 'ArrowUp':
        moveFocus(row - 1, column);
        break;
      case 'ArrowRight':
        moveFocus(row, column + 1);
        break;
      case 'ArrowLeft':
        moveFocus(row, column - 1);
        break;
      case 'Home':
        moveFocus(row, 0);
        break;
      case 'End':
        moveFocus(row, columnCount - 1);
        break;
      case 'PageDown':
        moveFocus(row + page, column);
        break;
      case 'PageUp':
        moveFocus(row - page, column);
        break;
      default:
        return;
    }
    event.preventDefault();
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
        className="grid-scroll"
        ref={scrollRef}
        role="grid"
        aria-label="Data grid"
        aria-rowcount={totalRowCount}
        aria-colcount={columns.length + 1}
        tabIndex={0}
        onKeyDown={onGridKeyDown}
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
            return (
              <div
                key={rowIndex}
                role="row"
                aria-rowindex={virtualRow.index + 2} // +2: header row occupies row 1
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
                  className="grid-cell grid-cell--rownum"
                  style={{ width: ROW_NUM_WIDTH }}
                >
                  {recordLabel(rowIndex)}
                </div>
                {columns.map((column, columnIndex) => {
                  const cellValue = valueAt(rowIndex, columnIndex) ?? '';
                  return (
                    <div
                      key={column.id}
                      role="gridcell"
                      data-cell={`${virtualRow.index}-${columnIndex}`}
                      tabIndex={
                        virtualRow.index === clampedFocus.row && columnIndex === clampedFocus.column
                          ? 0
                          : -1
                      }
                      className="grid-cell"
                      style={{ width: column.width }}
                      title={valueAt(rowIndex, columnIndex) ?? undefined}
                      onMouseDown={(event) => {
                        if (
                          virtualRow.index !== clampedFocus.row ||
                          columnIndex !== clampedFocus.column
                        ) {
                          setFocusPos({ row: virtualRow.index, column: columnIndex });
                        }
                        // Take focus synchronously: the grid container is also
                        // focusable and would otherwise swallow the click.
                        event.currentTarget.focus();
                      }}
                    >
                      <span className="grid-cell__text truncate">{cellValue}</span>
                      <button
                        type="button"
                        className="grid-cell__copy"
                        aria-label={`Copy value of ${column.label} in ${recordLabel(rowIndex)}`}
                        onClick={() => {
                          void navigator.clipboard
                            ?.writeText(cellValue)
                            .catch(() => copyFallback(cellValue));
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
    </div>
  );
}
