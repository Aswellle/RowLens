/**
 * Export dialog per the UI spec §6: file name, row scope (filtered vs all),
 * column summary, safety mode with distinct explanations, estimates, then
 * Export/Cancel. Safety copy never claims universal protection.
 */
import { useEffect, useState } from 'react';
import { Modal } from './Modal';
import type { CsvSafetyMode } from '../features/export/types';
import type { ExportScope } from '../features/export/types';

export type ExportRequest = {
  fileName: string;
  scope: ExportScope;
  safetyMode: CsvSafetyMode;
};

type ExportDialogProps = {
  defaultFileName: string;
  filteredCount: number;
  totalCount: number;
  exportColumnCount: number;
  totalColumnCount: number;
  /**
   * Present when the grid holds a multi-cell selection: the size of the
   * rectangle the Selected-range scope would export (ADR-036).
   */
  selection: { rows: number; columns: number } | null;
  /** -1 when the scope is too large to preview cheaply; null while counting. */
  countRiskCells: (scope: ExportScope) => number | null;
  busy: boolean;
  error: string | null;
  onConfirm: (request: ExportRequest) => void;
  onCancel: () => void;
};

/** Row count shown in the estimate for a scope. */
function scopeRowCount(
  scope: ExportScope,
  props: { filteredCount: number; totalCount: number; selection: { rows: number } | null },
): number {
  if (scope === 'all') return props.totalCount;
  if (scope === 'selection') return props.selection?.rows ?? 0;
  return props.filteredCount;
}

export function ExportDialog(props: ExportDialogProps) {
  const [fileName, setFileName] = useState(props.defaultFileName);
  // A selection is why the user opened the dialog, so it is the default when
  // one exists; otherwise the view is.
  const [scope, setScope] = useState<ExportScope>(
    props.selection === null ? 'filtered' : 'selection',
  );
  const [safetyMode, setSafetyMode] = useState<CsvSafetyMode>('spreadsheet-safe');
  const [riskCount, setRiskCount] = useState<number | null>(null);

  useEffect(() => {
    setRiskCount(props.countRiskCells(scope));
  }, [scope, props]);

  const riskLabel =
    riskCount === null
      ? 'counting…'
      : riskCount < 0
        ? 'too many rows to preview quickly'
        : String(riskCount);

  return (
    <Modal label="Export CSV" onClose={props.onCancel} closeDisabled={props.busy}>
      <h2 className="modal-title">Export CSV</h2>

      <div className="export-dialog__field">
        <label htmlFor="export-file-name">File name</label>
        <input
          id="export-file-name"
          className="text-input"
          type="text"
          value={fileName}
          onChange={(event) => setFileName(event.target.value)}
          disabled={props.busy}
        />
      </div>

      <fieldset className="export-dialog__field">
        <legend>Rows</legend>
        {props.selection !== null && (
          <label>
            <input
              type="radio"
              name="export-scope"
              checked={scope === 'selection'}
              onChange={() => setScope('selection')}
              disabled={props.busy}
            />
            Selected range ({props.selection.rows.toLocaleString('en-US')} rows ×{' '}
            {props.selection.columns.toLocaleString('en-US')} columns)
          </label>
        )}
        <label>
          <input
            type="radio"
            name="export-scope"
            checked={scope === 'filtered'}
            onChange={() => setScope('filtered')}
            disabled={props.busy}
          />
          Filtered rows ({props.filteredCount.toLocaleString('en-US')})
        </label>
        <label>
          <input
            type="radio"
            name="export-scope"
            checked={scope === 'all'}
            onChange={() => setScope('all')}
            disabled={props.busy}
          />
          All rows, cleaned ({props.totalCount.toLocaleString('en-US')})
        </label>
      </fieldset>

      <p className="export-dialog__columns">
        {scope === 'selection'
          ? `${(props.selection?.columns ?? 0).toLocaleString('en-US')} selected columns — exactly the rectangle on screen.`
          : `${props.exportColumnCount.toLocaleString('en-US')} of ${props.totalColumnCount.toLocaleString('en-US')} columns — the current view columns, narrowed by any select-columns step.`}
      </p>

      <fieldset className="export-dialog__field">
        <legend>Spreadsheet safety</legend>
        <label>
          <input
            type="radio"
            name="export-safety"
            checked={safetyMode === 'spreadsheet-safe'}
            onChange={() => setSafetyMode('spreadsheet-safe')}
            disabled={props.busy}
          />
          Spreadsheet-safe CSV (default)
        </label>
        {safetyMode === 'spreadsheet-safe' && (
          <p className="export-dialog__hint">
            Cells that look like formulas (leading =, +, -, @, tab) get a <code>'</code> prefix, so
            the file differs from the original values. No quoting strategy is safe in every
            spreadsheet app.
          </p>
        )}
        <label>
          <input
            type="radio"
            name="export-safety"
            checked={safetyMode === 'raw'}
            onChange={() => setSafetyMode('raw')}
            disabled={props.busy}
          />
          Raw CSV
        </label>
        {safetyMode === 'raw' && (
          <p className="export-dialog__hint export-dialog__hint--warning">
            Warning: spreadsheet apps may interpret cells like <code>=SUM()</code> as formulas when
            opening this file. Use this only when the prefix would break your downstream tooling.
          </p>
        )}
      </fieldset>

      <p className="export-dialog__estimate">
        Estimate: {scopeRowCount(scope, props).toLocaleString('en-US')} rows ·{' '}
        {scope === 'selection' ? (props.selection?.columns ?? 0) : props.exportColumnCount} columns
        · {riskLabel} formula-looking cells.
      </p>

      {props.error !== null && (
        <p className="export-dialog__error" role="alert">
          {props.error}
        </p>
      )}

      <div className="export-dialog__actions">
        <button
          type="button"
          className="btn btn--primary"
          disabled={props.busy || fileName.trim() === ''}
          onClick={() => props.onConfirm({ fileName: fileName.trim(), scope, safetyMode })}
        >
          {props.busy ? 'Exporting…' : 'Export CSV'}
        </button>
        <button type="button" className="btn" onClick={props.onCancel}>
          {props.busy ? 'Cancel export' : 'Cancel'}
        </button>
      </div>
    </Modal>
  );
}
