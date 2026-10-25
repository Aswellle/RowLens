/**
 * Pre-import options for CSV/TSV files (PRD FR-02): header-row toggle and
 * delimiter choice. Shown after file selection, before the job starts.
 */
export type DelimiterChoice = 'auto' | ',' | ';' | '\t' | '|';

const DELIMITER_OPTIONS: { value: DelimiterChoice; label: string }[] = [
  { value: 'auto', label: 'Detect automatically' },
  { value: ',', label: 'Comma ( , )' },
  { value: ';', label: 'Semicolon ( ; )' },
  { value: '\t', label: 'Tab' },
  { value: '|', label: 'Pipe ( | )' },
];

type ImportOptionsProps = {
  fileName: string;
  hasHeader: boolean;
  delimiter: DelimiterChoice;
  onHasHeaderChange: (value: boolean) => void;
  onDelimiterChange: (value: DelimiterChoice) => void;
  onStart: () => void;
  onCancel: () => void;
};

export function ImportOptions({
  fileName,
  hasHeader,
  delimiter,
  onHasHeaderChange,
  onDelimiterChange,
  onStart,
  onCancel,
}: ImportOptionsProps) {
  return (
    <div className="empty-state">
      <h2 className="empty-state__title" style={{ fontSize: 20 }}>
        Import options
      </h2>
      <p className="empty-state__subtitle truncate" style={{ maxWidth: '60vw' }} title={fileName}>
        {fileName}
      </p>
      <form
        className="import-options__form"
        onSubmit={(event) => {
          event.preventDefault();
          onStart();
        }}
      >
        <label>
          <input
            type="checkbox"
            checked={hasHeader}
            onChange={(event) => onHasHeaderChange(event.target.checked)}
          />
          First row is a header
        </label>
        <label htmlFor="delimiter-choice">Delimiter</label>
        <select
          id="delimiter-choice"
          className="text-input"
          value={delimiter}
          onChange={(event) => onDelimiterChange(event.target.value as DelimiterChoice)}
        >
          {DELIMITER_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <div className="empty-state__actions">
          <button type="submit" className="btn btn--primary">
            Start import
          </button>
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
