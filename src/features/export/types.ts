/**
 * CSV export option contracts.
 *
 * Contract source: PRD FR-06 and docs/03-data-processing-contracts.md §9:
 * - Output is UTF-8 with CRLF line endings; double-quote wrapping is applied
 *   only when necessary (comma, quote, CR/LF present); embedded quotes are
 *   escaped by doubling.
 * - `spreadsheet-safe` mode modifies only cells with formula-injection risk
 *   and reports how many cells were changed; `raw` mode never mutates values
 *   and the UI must warn about spreadsheet formula interpretation.
 * - Neither mode is advertised as absolutely safe in every spreadsheet app.
 */
import type { ColumnId } from '../dataset/types';

export type CsvSafetyMode = 'spreadsheet-safe' | 'raw';

export type ExportScope = 'filtered' | 'all';

export type CsvExportOptions = {
  /** Output file name; the app sanitises path separators and control characters. */
  fileName: string;
  scope: ExportScope;
  /** Export columns in exactly this order. */
  columns: ColumnId[];
  safetyMode: CsvSafetyMode;
};
