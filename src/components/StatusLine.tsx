/**
 * Result-count line under the toolbar. aria-live="polite" so result changes
 * are announced once, not on every keystroke frame (see UI spec §8).
 */
type StatusLineProps = {
  matchCount: number;
  totalRows: number;
  hasActiveQuery: boolean;
  onReset: () => void;
  filterCount?: number;
  busy?: boolean;
};

export function StatusLine({
  matchCount,
  totalRows,
  hasActiveQuery,
  onReset,
  filterCount = 0,
  busy = false,
}: StatusLineProps) {
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
      {busy && <span role="status">Searching…</span>}
      {hasActiveQuery && (
        <button type="button" className="btn btn--ghost" onClick={onReset}>
          Reset
        </button>
      )}
    </div>
  );
}
