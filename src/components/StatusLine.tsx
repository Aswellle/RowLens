/**
 * Result-count line under the toolbar. aria-live="polite" so result changes
 * are announced once, not on every keystroke frame (see UI spec §8).
 */
type StatusLineProps = {
  matchCount: number;
  totalRows: number;
  hasActiveQuery: boolean;
  onReset: () => void;
};

export function StatusLine({ matchCount, totalRows, hasActiveQuery, onReset }: StatusLineProps) {
  return (
    <div className="status-line">
      <span aria-live="polite" className="num">
        {matchCount.toLocaleString('en-US')} of {totalRows.toLocaleString('en-US')} rows match
      </span>
      {hasActiveQuery && (
        <button type="button" className="btn btn--ghost" onClick={onReset}>
          Reset
        </button>
      )}
    </div>
  );
}
