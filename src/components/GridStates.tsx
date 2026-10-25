/**
 * States rendered inside the grid region: loading, no-results and error.
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

export function GridErrorState({
  message,
  onRetry,
  onDismiss,
}: {
  message: string;
  onRetry: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="grid-state" role="alert">
      <p>{message}</p>
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" className="btn btn--primary" onClick={onRetry}>
          Try again
        </button>
        <button type="button" className="btn" onClick={onDismiss}>
          Back to start
        </button>
      </div>
    </div>
  );
}
