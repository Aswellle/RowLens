type FileInfoBarProps = {
  fileName: string;
  rowCount: number;
  columnCount: number;
  format: string;
  warningCount: number;
  onRemove: () => void;
};

function formatCount(n: number): string {
  return n.toLocaleString('en-US');
}

export function FileInfoBar({
  fileName,
  rowCount,
  columnCount,
  format,
  warningCount,
  onRemove,
}: FileInfoBarProps) {
  return (
    <div className="file-bar">
      <span className="file-bar__name truncate" title={fileName}>
        {fileName}
      </span>
      <span className="file-bar__meta">
        <span className="num">{formatCount(rowCount)} rows</span>
        <span aria-hidden="true">·</span>
        <span className="num">{formatCount(columnCount)} columns</span>
        <span aria-hidden="true">·</span>
        <span>{format.toUpperCase()}</span>
        <span aria-hidden="true">·</span>
        <span>
          {warningCount === 0 ? 'no parse warnings' : `${formatCount(warningCount)} parse warnings`}
        </span>
      </span>
      <span className="file-bar__spacer" />
      <button type="button" className="btn btn--danger" onClick={onRemove}>
        Remove
      </button>
    </div>
  );
}
