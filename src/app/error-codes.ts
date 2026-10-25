/**
 * Stable, machine-readable error codes shared by workers and the UI.
 * Contract source: docs/02-architecture.md §9.
 * UI copy must explain what happened and what the user can do next; raw row
 * content must never be embedded in these errors.
 */
export const APP_ERROR_CODES = [
  'UNSUPPORTED_FORMAT',
  'FILE_TOO_LARGE',
  'PARSE_FAILED',
  'PARTIAL_PARSE_ERRORS',
  'STORAGE_QUOTA_EXCEEDED',
  'STORAGE_UNAVAILABLE',
  'IMPORT_CANCELLED',
  'EXPORT_TOO_LARGE_FOR_FALLBACK',
  'EXPORT_FAILED',
  'QUERY_FAILED',
  'DATASET_NOT_FOUND',
] as const;

export type AppErrorCode = (typeof APP_ERROR_CODES)[number];

export function isAppErrorCode(value: unknown): value is AppErrorCode {
  return typeof value === 'string' && (APP_ERROR_CODES as readonly string[]).includes(value);
}
