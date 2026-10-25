/**
 * First-run empty state per docs/04-ui-ux-spec.md §2. "Choose a file" opens a
 * real picker to lock in the interaction structure, but Phase 1 has no import
 * pipeline yet — the app says so plainly instead of faking an import.
 */
import { useRef } from 'react';

type EmptyStateProps = {
  onChooseFile: () => void;
  onLoadSample: () => void;
};

export function EmptyState({ onChooseFile, onLoadSample }: EmptyStateProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="empty-state">
      <h1 className="empty-state__title">Explore a data file. Keep it on your device.</h1>
      <p className="empty-state__subtitle">CSV, TSV and JSONL · No account · No upload</p>
      <div className="empty-state__actions">
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => fileInputRef.current?.click()}
        >
          Choose a file
        </button>
        <button type="button" className="btn" onClick={onLoadSample}>
          Try sample data
        </button>
      </div>
      <p className="empty-state__subtitle">
        The sample is synthetic data generated on your machine.
      </p>
      <input
        ref={fileInputRef}
        type="file"
        accept=".csv,.tsv,.jsonl,.ndjson"
        className="visually-hidden"
        aria-hidden="true"
        tabIndex={-1}
        onChange={(event) => {
          event.target.value = '';
          onChooseFile();
        }}
      />
    </div>
  );
}
