/**
 * First-run empty state per docs/04-ui-ux-spec.md §2. "Choose a file" opens
 * the platform picker and hands the selected file to the import pipeline;
 * the hidden input keeps a stable id for tests and keyboard-triggered pickers.
 */
import { useRef } from 'react';

type EmptyStateProps = {
  onChooseFile: (file: File) => void;
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
        id="file-input"
        type="file"
        accept=".csv,.tsv,.jsonl,.ndjson"
        className="visually-hidden"
        aria-hidden="true"
        tabIndex={-1}
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) onChooseFile(file);
        }}
      />
    </div>
  );
}
