/**
 * Import progress panel: stage label, parsed-record count and a cancel
 * button — never a bare spinner (UI spec §3).
 */
type ImportProgressProps = {
  fileName: string;
  rowsParsed: number;
  onCancel: () => void;
};

export function ImportProgress({ fileName, rowsParsed, onCancel }: ImportProgressProps) {
  return (
    <div className="loading-state" role="status">
      <p className="truncate" style={{ maxWidth: '60vw' }}>
        Importing {fileName}…
      </p>
      <div className="progress" aria-hidden="true">
        <div className="progress__bar" style={{ width: '40%' }} />
      </div>
      <p>
        <span className="num">{rowsParsed.toLocaleString('en-US')}</span> records parsed
      </p>
      <button type="button" className="btn" onClick={onCancel}>
        Cancel import
      </button>
    </div>
  );
}
