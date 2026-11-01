/**
 * States rendered inside the grid region: loading and no-results.
 * Each is actionable per the UI spec — a spinner alone is never enough.
 */

export function LoadingState({ label }: { label: string }) {
  return (
    <div className="grid-state" role="status">
      <div className="progress">
        <div
          className="progress__bar"
          style={{ width: '40%' }} /* indeterminate-style shimmer replaced by simple bar */
        />
      </div>
      <p>{label}</p>
    </div>
  );
}

export function NoResultsState({
  searchTerm,
  onClear,
}: {
  searchTerm: string;
  onClear: () => void;
}) {
  return (
    <div className="grid-state">
      <p>No rows match “{searchTerm}”.</p>
      <button type="button" className="btn" onClick={onClear}>
        Clear search
      </button>
    </div>
  );
}
