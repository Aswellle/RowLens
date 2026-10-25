/**
 * File validation before an import starts: format detection and the size cap
 * (PRD FR-01). Extensions are the primary signal because they are what the
 * user chose; MIME is a secondary hint for unknown extensions only — it is
 * untrustworthy (trivially spoofed). Content-level checks happen during
 * parsing, not here.
 */
import { AppError } from '../../app/app-error';
import type { DatasetFormat } from '../dataset/types';
import { MAX_FILE_BYTES } from '../dataset/constants';

const EXTENSION_FORMATS: ReadonlyArray<{ extension: string; format: DatasetFormat }> = [
  { extension: '.csv', format: 'csv' },
  { extension: '.tsv', format: 'tsv' },
  { extension: '.jsonl', format: 'jsonl' },
  { extension: '.ndjson', format: 'ndjson' },
];

const MIME_FORMATS: ReadonlyArray<{ mime: string; format: DatasetFormat }> = [
  { mime: 'text/csv', format: 'csv' },
  { mime: 'text/tab-separated-values', format: 'tsv' },
  { mime: 'application/x-ndjson', format: 'jsonl' },
  { mime: 'application/jsonl', format: 'jsonl' },
];

export type FileLike = {
  name: string;
  size: number;
  type?: string;
};

/** jsonl and ndjson share one pipeline; normalise the label. */
export function parseFormat(format: DatasetFormat): 'csv' | 'tsv' | 'jsonl' {
  return format === 'ndjson' ? 'jsonl' : format;
}

export function detectFormat(file: FileLike): DatasetFormat | null {
  const name = file.name.toLowerCase();
  const byExtension = EXTENSION_FORMATS.find(({ extension }) => name.endsWith(extension));
  if (byExtension) return byExtension.format;

  // A known-but-unsupported extension (e.g. .xlsx) is the user's explicit
  // choice — a spoofed MIME must not smuggle it in. MIME is only a hint for
  // names with no extension at all.
  const hasExtension = /\.[a-z0-9]{1,12}$/.test(name);
  if (hasExtension) return null;

  const mime = file.type?.toLowerCase();
  if (mime) {
    const byMime = MIME_FORMATS.find(
      (entry) => mime === entry.mime || mime.startsWith(`${entry.mime};`),
    );
    if (byMime) return byMime.format;
  }
  return null;
}

/**
 * Validate a chosen file for import. Returns the detected format, or throws
 * an actionable AppError. Empty files are allowed — they import as datasets
 * with zero records rather than failing silently.
 */
export function validateForImport(
  file: FileLike,
  maxBytes: number = MAX_FILE_BYTES,
): DatasetFormat {
  const format = detectFormat(file);
  if (format === null) {
    throw new AppError(
      'UNSUPPORTED_FORMAT',
      `${file.name || 'This file'} is not a CSV, TSV or JSONL file. Supported extensions: .csv, .tsv, .jsonl, .ndjson.`,
    );
  }
  if (file.size > maxBytes) {
    const limitMiB = Math.round(maxBytes / (1024 * 1024));
    throw new AppError(
      'FILE_TOO_LARGE',
      `This file is larger than the current ${limitMiB} MiB import limit.`,
    );
  }
  return format;
}
