// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { DataGrid } from './DataGrid';

const columns = [
  { id: 'c0', label: 'Name', width: 140 },
  { id: 'c1', label: 'City', width: 140 },
];

// Small deterministic table: duplicates on purpose to observe stable order.
const rows = [
  ['beta', 'Berlin'],
  ['alpha', 'Cairo'],
  ['beta', 'Auckland'],
  ['gamma', 'Berlin'],
];

function valueAt(rowIndex: number, columnIndex: number): string | null {
  return rows[rowIndex]?.[columnIndex] ?? null;
}

/**
 * Virtualization contract: the DOM must contain only a window of rows, not
 * the full dataset, and ARIA must describe the logical table completely.
 */
describe('DataGrid', () => {
  it('renders a bounded number of row elements regardless of dataset size', () => {
    const bigIndices = Array.from({ length: 5000 }, (_, i) => i);
    render(
      <DataGrid
        columns={columns}
        totalRowCount={5000}
        visibleIndices={bigIndices}
        valueAt={valueAt}
        recordLabel={(i) => `Record ${i + 1}`}
        sort={null}
        onSortChange={() => {}}
      />,
    );

    const grid = screen.getByRole('grid', { name: 'Data grid' });
    const renderedRows = within(grid).getAllByRole('row');
    // 1 header row + a viewport window (≈17 visible + 8 overscan per side).
    expect(renderedRows.length).toBeGreaterThan(1);
    expect(renderedRows.length).toBeLessThan(60);
    // Logical size is exposed to assistive tech instead of DOM rows.
    expect(grid).toHaveAttribute('aria-rowcount', '5000');
  });

  it('renders only the visible indices passed to it', () => {
    render(
      <DataGrid
        columns={columns}
        totalRowCount={4}
        visibleIndices={[1, 2]}
        valueAt={valueAt}
        recordLabel={(i) => `Record ${i + 1}`}
        sort={null}
        onSortChange={() => {}}
      />,
    );

    const grid = screen.getByRole('grid', { name: 'Data grid' });
    expect(within(grid).getByText('Cairo')).toBeInTheDocument();
    expect(within(grid).getByText('Auckland')).toBeInTheDocument();
    // Rows 0 and 3 (both 'Berlin') are outside the visible set.
    expect(within(grid).queryByText('Berlin')).not.toBeInTheDocument();
    expect(within(grid).queryByText('gamma')).not.toBeInTheDocument();
  });

  it('exposes ascending/descending/none sort state via aria-sort', async () => {
    const user = userEvent.setup();
    let sort: { columnIndex: number; direction: 'asc' | 'desc' } | null = null;
    const { rerender } = render(
      <DataGrid
        columns={columns}
        totalRowCount={4}
        visibleIndices={[0, 1, 2, 3]}
        valueAt={valueAt}
        recordLabel={(i) => `Record ${i + 1}`}
        sort={sort}
        onSortChange={(next) => {
          sort = next;
        }}
      />,
    );

    const nameHeader = screen.getByRole('columnheader', { name: /^Name/ });
    const applySort = () =>
      rerender(
        <DataGrid
          columns={columns}
          totalRowCount={4}
          visibleIndices={[0, 1, 2, 3]}
          valueAt={valueAt}
          recordLabel={(i) => `Record ${i + 1}`}
          sort={sort}
          onSortChange={(next) => {
            sort = next;
          }}
        />,
      );

    expect(nameHeader).toHaveAttribute('aria-sort', 'none');

    await user.click(screen.getByRole('button', { name: 'Sort by Name' }));
    applySort();
    expect(nameHeader).toHaveAttribute('aria-sort', 'ascending');

    await user.click(screen.getByRole('button', { name: 'Sort by Name' }));
    applySort();
    expect(nameHeader).toHaveAttribute('aria-sort', 'descending');

    await user.click(screen.getByRole('button', { name: 'Sort by Name' }));
    applySort();
    expect(nameHeader).toHaveAttribute('aria-sort', 'none');
  });

  it('gives every column header a keyboard-reachable sort button', () => {
    render(
      <DataGrid
        columns={columns}
        totalRowCount={4}
        visibleIndices={[0, 1, 2, 3]}
        valueAt={valueAt}
        recordLabel={(i) => `Record ${i + 1}`}
        sort={null}
        onSortChange={() => {}}
      />,
    );

    expect(screen.getByRole('button', { name: 'Sort by Name' })).toBeInstanceOf(HTMLButtonElement);
    expect(screen.getByRole('button', { name: 'Sort by City' })).toBeInstanceOf(HTMLButtonElement);
  });
  it('moves focus with arrow keys, Home and End (roving tabindex)', async () => {
    const user = userEvent.setup();
    render(
      <DataGrid
        columns={columns}
        totalRowCount={4}
        visibleIndices={[0, 1, 2, 3]}
        valueAt={valueAt}
        recordLabel={(i) => `Record ${i + 1}`}
        sort={null}
        onSortChange={() => {}}
      />,
    );

    const grid = screen.getByRole('grid', { name: 'Data grid' });
    const cell = (row: number, column: number) =>
      grid.querySelector<HTMLElement>(`[data-cell="${row}-${column}"]`);

    // Exactly one cell is tabbable at a time (roving tabindex).
    expect(grid.querySelectorAll('[data-cell][tabindex="0"]')).toHaveLength(1);
    expect(cell(0, 0)?.tabIndex).toBe(0);

    cell(0, 0)?.focus();
    await user.keyboard('{ArrowRight}');
    expect(cell(0, 1)).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(cell(1, 1)).toHaveFocus();
    await user.keyboard('{End}');
    expect(cell(1, columns.length - 1)).toHaveFocus();
    await user.keyboard('{Home}');
    expect(cell(1, 0)).toHaveFocus();
    await user.keyboard('{ArrowLeft}');
    expect(cell(1, 0)).toHaveFocus(); // clamped at the first column
    await user.keyboard('{ArrowUp}{ArrowUp}');
    expect(cell(0, 0)).toHaveFocus(); // clamped at the first row
    // Only the focused cell is tabbable after moving.
    expect(grid.querySelectorAll('[data-cell][tabindex="0"]')).toHaveLength(1);
  });
});
