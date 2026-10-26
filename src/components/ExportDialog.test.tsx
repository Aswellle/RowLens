// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ExportDialog } from './ExportDialog';

function setup(overrides: Partial<React.ComponentProps<typeof ExportDialog>> = {}) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  const props = {
    defaultFileName: 'data-cleaned.csv',
    filteredCount: 40,
    totalCount: 120,
    exportColumnCount: 6,
    totalColumnCount: 8,
    selection: null,
    countRiskCells: vi.fn(() => 3),
    busy: false,
    error: null,
    onConfirm,
    onCancel,
    ...overrides,
  };
  render(<ExportDialog {...props} />);
  return { ...props, onConfirm, onCancel };
}

describe('ExportDialog scopes', () => {
  it('offers Filtered and All when nothing is selected, defaulting to Filtered', () => {
    setup({ selection: null });
    expect(screen.getByLabelText(/^Filtered rows/)).toBeChecked();
    expect(screen.queryByLabelText(/Selected range/)).not.toBeInTheDocument();
    expect(screen.getByText(/6 of 8 columns/)).toBeInTheDocument();
  });

  it('defaults to the selected range and states its size', () => {
    setup({ selection: { rows: 7, columns: 3 } });
    expect(screen.getByLabelText(/Selected range/)).toBeChecked();
    expect(screen.getByText(/Selected range \(7 rows × 3 columns\)/)).toBeInTheDocument();
    expect(screen.getByText(/3 selected columns/)).toBeInTheDocument();
    expect(screen.getByText(/Estimate: 7 rows · 3 columns/)).toBeInTheDocument();
  });

  it('switching scopes switches the estimate', async () => {
    const user = userEvent.setup();
    setup({ selection: { rows: 7, columns: 3 } });

    await user.click(screen.getByLabelText(/^Filtered rows/));
    expect(screen.getByText(/Estimate: 40 rows · 6 columns/)).toBeInTheDocument();
    expect(screen.getByText(/6 of 8 columns/)).toBeInTheDocument();

    await user.click(screen.getByLabelText(/^All rows/));
    expect(screen.getByText(/Estimate: 120 rows · 6 columns/)).toBeInTheDocument();
  });

  it('counts risk cells for the active scope', async () => {
    const user = userEvent.setup();
    const props = setup({ selection: { rows: 7, columns: 3 } });
    expect(props.countRiskCells).toHaveBeenCalledWith('selection');

    await user.click(screen.getByLabelText(/^Filtered rows/));
    expect(props.countRiskCells).toHaveBeenCalledWith('filtered');
  });

  it('submits the active scope with the file name', async () => {
    const user = userEvent.setup();
    const props = setup({ selection: { rows: 7, columns: 3 } });

    await user.click(screen.getByRole('button', { name: 'Export CSV' }));
    expect(props.onConfirm).toHaveBeenCalledWith({
      fileName: 'data-cleaned.csv',
      scope: 'selection',
      safetyMode: 'spreadsheet-safe',
    });
  });

  it('still offers the selection scope while busy but keeps it unchangeable', () => {
    setup({ selection: { rows: 7, columns: 3 }, busy: true });
    expect(screen.getByLabelText(/Selected range/)).toBeDisabled();
  });
});
