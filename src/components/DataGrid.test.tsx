// @vitest-environment jsdom
import { fireEvent, render, screen, within } from '@testing-library/react';
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
    // One more step left reaches the record header, then clamps there.
    const rowHeader = grid.querySelector<HTMLElement>('[data-row-header="1"]');
    await user.keyboard('{ArrowLeft}');
    expect(rowHeader).toHaveFocus();
    await user.keyboard('{ArrowLeft}');
    expect(rowHeader).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(cell(1, 0)).toHaveFocus();
    await user.keyboard('{ArrowUp}{ArrowUp}');
    expect(cell(0, 0)).toHaveFocus(); // clamped at the first row
    // Only the focused cell is tabbable after moving (the header included).
    expect(
      grid.querySelectorAll('[data-cell][tabindex="0"], [data-row-header][tabindex="0"]'),
    ).toHaveLength(1);
  });

  it('extends a rectangular selection with Shift+arrows and copies it as TSV', async () => {
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

    cell(0, 0)?.focus();
    await user.keyboard('{Shift>}{ArrowDown}{ArrowRight}{/Shift}');

    // Anchor stays at the first cell; focus moves to the opposite corner.
    expect(cell(1, 1)).toHaveFocus();
    expect(cell(0, 0)).toHaveAttribute('aria-selected', 'true');
    expect(cell(0, 1)).toHaveAttribute('aria-selected', 'true');
    expect(cell(1, 0)).toHaveAttribute('aria-selected', 'true');
    expect(cell(1, 1)).toHaveAttribute('aria-selected', 'true');
    // Outside the rectangle: not selected.
    expect(cell(2, 0)).toHaveAttribute('aria-selected', 'false');

    // The selection bar states the size (colour is not the only cue).
    expect(screen.getByText('2 × 2 selected')).toBeInTheDocument();

    // Ctrl/Cmd+C writes the rectangle as tab-separated rows with CRLF.
    // jsdom has no real clipboard, so a synthetic event stands in for the
    // browser contract (a native copy event always carries clipboardData).
    const clipboardData = {
      data: {} as Record<string, string>,
      setData(type: string, value: string) {
        this.data[type] = value;
      },
      getData(type: string) {
        return this.data[type] ?? '';
      },
    };
    fireEvent.copy(grid, { clipboardData });
    expect(clipboardData.getData('text/plain')).toBe('beta\tBerlin\r\nalpha\tCairo');
  });

  it('selects the whole row from its record header and copies every visible column', async () => {
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
    const header = grid.querySelector<HTMLElement>('[data-row-header="2"]');
    header?.focus();
    // Space on the row header selects the whole row (keyboard equivalent of
    // clicking it); the header is a selector, never copied data.
    await user.keyboard(' ');
    expect(screen.getByText('1 × 2 selected')).toBeInTheDocument();

    const clipboardData = {
      data: {} as Record<string, string>,
      setData(type: string, value: string) {
        this.data[type] = value;
      },
      getData(type: string) {
        return this.data[type] ?? '';
      },
    };
    fireEvent.copy(grid, { clipboardData });
    expect(clipboardData.getData('text/plain')).toBe('beta\tAuckland');
  });

  it('selects whole rows by dragging the record header, without shrinking to one column', async () => {
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
    const header = (row: number) => grid.querySelector<HTMLElement>(`[data-row-header="${row}"]`);
    const cell = (row: number, column: number) =>
      grid.querySelector<HTMLElement>(`[data-cell="${row}-${column}"]`);

    // Press on row 1's header, drag over row 2's first data cell, release.
    fireEvent.mouseDown(header(1)!, { button: 0 });
    fireEvent.mouseEnter(cell(2, 0)!);
    fireEvent.mouseUp(window);

    expect(screen.getByText('2 × 2 selected')).toBeInTheDocument();
    expect(cell(1, 1)).toHaveAttribute('aria-selected', 'true');
    expect(cell(2, 1)).toHaveAttribute('aria-selected', 'true');
    expect(cell(0, 1)).toHaveAttribute('aria-selected', 'false');

    // Dragging ends at mouseup: later hovering must not keep extending.
    fireEvent.mouseEnter(cell(3, 0)!);
    expect(screen.getByText('2 × 2 selected')).toBeInTheDocument();
  });

  it('selects every visible row with Ctrl/Cmd+A and clears with Escape', async () => {
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

    cell(0, 0)?.focus();
    await user.keyboard('{Control>}a{/Control}');
    expect(screen.getByText('4 × 2 selected')).toBeInTheDocument();

    // Focus stays on the active cell after select-all (no jump to the end).
    expect(cell(0, 0)).toHaveFocus();

    await user.keyboard('{Escape}');
    expect(screen.queryByText('4 × 2 selected')).not.toBeInTheDocument();
    expect(cell(0, 0)).toHaveAttribute('aria-selected', 'true');
    expect(cell(1, 0)).toHaveAttribute('aria-selected', 'false');
  });

  it('refuses to copy a selection beyond the cell cap and explains why', async () => {
    const user = userEvent.setup();
    // 60,000 × 2 = 120,000 cells, above MAX_COPY_CELLS (100,000). The guard
    // must fire before any serialization work happens.
    const manyRows = Array.from({ length: 60_000 }, (_, i) => i);
    render(
      <DataGrid
        columns={columns}
        totalRowCount={60_000}
        visibleIndices={manyRows}
        valueAt={() => 'x'}
        recordLabel={(i) => `Record ${i + 1}`}
        sort={null}
        onSortChange={() => {}}
      />,
    );

    const grid = screen.getByRole('grid', { name: 'Data grid' });
    grid.querySelector<HTMLElement>('[data-cell="0-0"]')?.focus();
    await user.keyboard('{Control>}a{/Control}');

    const clipboardData = {
      data: {} as Record<string, string>,
      setData(type: string, value: string) {
        this.data[type] = value;
      },
      getData(type: string) {
        return this.data[type] ?? '';
      },
    };
    fireEvent.copy(grid, { clipboardData });
    expect(clipboardData.getData('text/plain')).toBe('');
    expect(screen.getByText(/120,000 cells — too many to copy at once/)).toBeInTheDocument();
    // The selection is kept, so the user can narrow it instead of starting over.
    expect(screen.getByText('60,000 × 2 selected')).toBeInTheDocument();
  });
});

describe('DataGrid cell editing', () => {
  const editableProps = {
    columns,
    totalRowCount: 4,
    visibleIndices: [0, 1, 2, 3],
    recordLabel: (i: number) => `Record ${i + 1}`,
    sort: null,
    onSortChange: () => {},
  };

  it('stays read-only when no edit handler is provided', async () => {
    const user = userEvent.setup();
    render(<DataGrid {...editableProps} valueAt={valueAt} />);

    const grid = screen.getByRole('grid', { name: 'Data grid' });
    grid.querySelector<HTMLElement>('[data-cell="0-0"]')?.focus();
    await user.keyboard('{Enter}');
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    // Typing does not start an edit either; the grid keeps its own shortcuts.
    await user.keyboard('x');
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('opens on Enter with the current value selected and commits on Enter', async () => {
    const user = userEvent.setup();
    const edits: Array<{ rowIndex: number; columnId: string; value: string }> = [];
    render(
      <DataGrid
        {...editableProps}
        valueAt={valueAt}
        onEditCell={(edit) => {
          edits.push({ rowIndex: edit.rowIndex, columnId: edit.columnId, value: edit.value });
          return null;
        }}
      />,
    );

    const grid = screen.getByRole('grid', { name: 'Data grid' });
    grid.querySelector<HTMLElement>('[data-cell="1-0"]')?.focus();
    await user.keyboard('{Enter}');

    const editor = screen.getByRole('textbox', { name: /Edit Name in Record 2/ });
    expect(editor).toHaveValue('alpha');
    expect(editor).toHaveFocus();

    await user.clear(editor);
    await user.type(editor, 'edited');
    await user.keyboard('{Enter}');

    expect(edits).toEqual([{ rowIndex: 1, columnId: 'c0', value: 'edited' }]);
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('starts a fresh edit when typing a printable character', async () => {
    const user = userEvent.setup();
    const edits: string[] = [];
    render(
      <DataGrid
        {...editableProps}
        valueAt={valueAt}
        onEditCell={(edit) => {
          edits.push(edit.value);
          return null;
        }}
      />,
    );

    const grid = screen.getByRole('grid', { name: 'Data grid' });
    grid.querySelector<HTMLElement>('[data-cell="0-1"]')?.focus();
    await user.keyboard('Z');

    const editor = screen.getByRole('textbox', { name: /Edit City in Record 1/ });
    // The typed character replaces the value rather than appending to it.
    expect(editor).toHaveValue('Z');
    await user.type(editor, 'urich');
    await user.keyboard('{Enter}');
    expect(edits).toEqual(['Zurich']);
  });

  it('cancels with Escape without reporting an edit', async () => {
    const user = userEvent.setup();
    let commits = 0;
    render(
      <DataGrid
        {...editableProps}
        valueAt={valueAt}
        onEditCell={() => {
          commits += 1;
          return null;
        }}
      />,
    );

    const grid = screen.getByRole('grid', { name: 'Data grid' });
    const cell = grid.querySelector<HTMLElement>('[data-cell="0-0"]');
    cell?.focus();
    await user.keyboard('{Enter}');
    await user.type(screen.getByRole('textbox'), 'discarded');
    await user.keyboard('{Escape}');

    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(commits).toBe(0);
    expect(cell).toHaveFocus();
  });

  it('opens on F2 and on double-click', async () => {
    const user = userEvent.setup();
    render(<DataGrid {...editableProps} valueAt={valueAt} onEditCell={() => null} />);

    const grid = screen.getByRole('grid', { name: 'Data grid' });
    grid.querySelector<HTMLElement>('[data-cell="2-1"]')?.focus();
    await user.keyboard('{F2}');
    expect(screen.getByRole('textbox', { name: /Edit City in Record 3/ })).toHaveValue('Auckland');
    await user.keyboard('{Escape}');

    await user.dblClick(
      within(grid).getByText('Berlin', { selector: '[data-cell="0-1"] .grid-cell__text' }),
    );
    expect(screen.getByRole('textbox', { name: /Edit City in Record 1/ })).toHaveValue('Berlin');
  });

  it('commits and moves to the next cell on Tab', async () => {
    const user = userEvent.setup();
    const commits: Array<{ rowIndex: number; columnIndex: number }> = [];
    render(
      <DataGrid
        {...editableProps}
        valueAt={valueAt}
        onEditCell={(edit) => {
          commits.push({ rowIndex: edit.rowIndex, columnIndex: edit.columnIndex });
          return null;
        }}
      />,
    );

    const grid = screen.getByRole('grid', { name: 'Data grid' });
    const cell = (row: number, column: number) =>
      grid.querySelector<HTMLElement>(`[data-cell="${row}-${column}"]`);
    cell(0, 0)?.focus();
    await user.keyboard('{Enter}');
    await user.type(screen.getByRole('textbox'), '!');
    await user.keyboard('{Tab}');

    expect(commits).toEqual([{ rowIndex: 0, columnIndex: 0 }]);
    expect(cell(0, 1)).toHaveFocus();
  });

  it('wraps to the next row when tabbing past the last column', async () => {
    const user = userEvent.setup();
    render(<DataGrid {...editableProps} valueAt={valueAt} onEditCell={() => null} />);

    const grid = screen.getByRole('grid', { name: 'Data grid' });
    const cell = (row: number, column: number) =>
      grid.querySelector<HTMLElement>(`[data-cell="${row}-${column}"]`);
    cell(0, 1)?.focus();
    await user.keyboard('{Enter}');
    await user.keyboard('{Tab}');
    expect(cell(1, 0)).toHaveFocus();
  });

  it('commits when focus leaves the editor by clicking another cell', async () => {
    const user = userEvent.setup();
    const commits: string[] = [];
    render(
      <DataGrid
        {...editableProps}
        valueAt={valueAt}
        onEditCell={(edit) => {
          commits.push(edit.value);
          return null;
        }}
      />,
    );

    const grid = screen.getByRole('grid', { name: 'Data grid' });
    grid.querySelector<HTMLElement>('[data-cell="0-0"]')?.focus();
    await user.keyboard('{Enter}');
    await user.type(screen.getByRole('textbox'), '-typed');
    // Clicking a different cell steals focus, which commits the draft.
    await user.click(
      within(grid).getByText('gamma', { selector: '[data-cell="3-0"] .grid-cell__text' }),
    );

    expect(commits).toEqual(['beta-typed']);
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('closes the editor and announces a refused commit', async () => {
    const user = userEvent.setup();
    render(
      <DataGrid {...editableProps} valueAt={valueAt} onEditCell={() => 'Edit limit reached.'} />,
    );

    const grid = screen.getByRole('grid', { name: 'Data grid' });
    grid.querySelector<HTMLElement>('[data-cell="0-0"]')?.focus();
    await user.keyboard('{Enter}');
    await user.keyboard('{Enter}');

    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByText('Edit limit reached.')).toBeInTheDocument();
  });

  it('marks edited cells so the overlay state is visible', () => {
    render(
      <DataGrid
        {...editableProps}
        valueAt={(row, column) => (row === 1 && column === 0 ? 'overlay' : valueAt(row, column))}
        storedValueAt={valueAt}
        onEditCell={() => null}
        isEdited={(row, column) => row === 1 && column === 0}
      />,
    );

    const grid = screen.getByRole('grid', { name: 'Data grid' });
    expect(grid.querySelector('[data-cell="1-0"]')).toHaveClass('grid-cell--edited');
    expect(grid.querySelector('[data-cell="1-1"]')).not.toHaveClass('grid-cell--edited');
  });
});
