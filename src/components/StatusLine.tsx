/**
 * Result-count line under the toolbar. aria-live="polite" so result changes
 * are announced once, not on every keystroke frame (see UI spec §8).
 *
 * The edit controls live here rather than in the toolbar: they describe the
 * state of the data currently on screen (how many cells carry an edit, and how
 * to step back), which is exactly what this line reports.
 */
type StatusLineProps = {
  matchCount: number;
  totalRows: number;
  hasActiveQuery: boolean;
  onReset: () => void;
  filterCount?: number;
  /** Columns currently hidden; part of what Reset restores. */
  hiddenCount?: number;
  busy?: boolean;
  /** Present when a running query can be cancelled. */
  onCancelQuery?: () => void;
  /** Number of cells currently carrying an in-memory edit. */
  editedCount?: number;
  canUndoEdit?: boolean;
  canRedoEdit?: boolean;
  onUndoEdit?: () => void;
  onRedoEdit?: () => void;
  onResetEdits?: () => void;
};

export function StatusLine({
  matchCount,
  totalRows,
  hasActiveQuery,
  onReset,
  filterCount = 0,
  hiddenCount = 0,
  busy = false,
  onCancelQuery,
  editedCount = 0,
  canUndoEdit = false,
  canRedoEdit = false,
  onUndoEdit,
  onRedoEdit,
  onResetEdits,
}: StatusLineProps) {
  // Keep the controls mounted while either history is non-empty: after
  // undoing the last edit there are no edited cells left, but Redo is exactly
  // what the user needs at that moment.
  const editControls = editedCount > 0 || canUndoEdit || canRedoEdit;
  return (
    <div className="status-line">
      <span aria-live="polite" className="num">
        {matchCount.toLocaleString('en-US')} of {totalRows.toLocaleString('en-US')} rows match
      </span>
      {filterCount > 0 && (
        <span>
          {filterCount} active filter{filterCount === 1 ? '' : 's'}
        </span>
      )}
      {hiddenCount > 0 && (
        <span>
          {hiddenCount} column{hiddenCount === 1 ? '' : 's'} hidden
        </span>
      )}
      {editedCount > 0 && (
        <span className="status-line__edited num">
          {editedCount.toLocaleString('en-US')} cell{editedCount === 1 ? '' : 's'} edited
        </span>
      )}
      {editControls && onUndoEdit && (
        <button
          type="button"
          className="btn btn--ghost"
          onClick={onUndoEdit}
          disabled={!canUndoEdit}
          title="Undo the last cell edit (Ctrl+Z)"
        >
          Undo
        </button>
      )}
      {editControls && onRedoEdit && (
        <button
          type="button"
          className="btn btn--ghost"
          onClick={onRedoEdit}
          disabled={!canRedoEdit}
          title="Redo the last undone edit (Ctrl+Shift+Z)"
        >
          Redo
        </button>
      )}
      {editedCount > 0 && onResetEdits && (
        <button
          type="button"
          className="btn btn--ghost"
          onClick={onResetEdits}
          title="Discard every cell edit and show the stored values"
        >
          Reset edits
        </button>
      )}
      {busy && (
        <>
          <span role="status">Searching…</span>
          {onCancelQuery && (
            <button type="button" className="btn btn--ghost" onClick={onCancelQuery}>
              Cancel query
            </button>
          )}
        </>
      )}
      {hasActiveQuery && (
        <button type="button" className="btn btn--ghost" onClick={onReset}>
          Reset
        </button>
      )}
    </div>
  );
}
