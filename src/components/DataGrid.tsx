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
import { useMemo, useRef } from 'react';
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
                {columns.map((column, columnIndex) => (
                  <div
                    key={column.id}
                    role="gridcell"
                    className="grid-cell"
                    style={{ width: column.width }}
                    title={valueAt(rowIndex, columnIndex) ?? undefined}
                  >
                    {valueAt(rowIndex, columnIndex)}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
