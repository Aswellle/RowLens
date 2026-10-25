import { describe, expect, it } from 'vitest';
import { APP_ERROR_CODES, isAppErrorCode } from './error-codes';

/**
 * Phase 0 lock on the error-code catalogue from docs/02-architecture.md §9.
 * Workers, the repository and the UI all switch on these stable codes, so
 * accidental renames must fail this test.
 */
describe('APP_ERROR_CODES catalogue', () => {
  it('contains exactly the architecture-mandated codes', () => {
    expect([...APP_ERROR_CODES]).toEqual([
      'UNSUPPORTED_FORMAT',
      'FILE_TOO_LARGE',
      'PARSE_FAILED',
      'PARTIAL_PARSE_ERRORS',
      'STORAGE_QUOTA_EXCEEDED',
      'IMPORT_CANCELLED',
      'EXPORT_TOO_LARGE_FOR_FALLBACK',
      'EXPORT_FAILED',
      'QUERY_FAILED',
      'DATASET_NOT_FOUND',
    ]);
  });

  it('has no duplicates', () => {
    expect(new Set(APP_ERROR_CODES).size).toBe(APP_ERROR_CODES.length);
  });

  it('isAppErrorCode accepts members and rejects arbitrary strings', () => {
    expect(isAppErrorCode('QUERY_FAILED')).toBe(true);
    expect(isAppErrorCode('query_failed')).toBe(false);
    expect(isAppErrorCode('')).toBe(false);
    expect(isAppErrorCode(42)).toBe(false);
    expect(isAppErrorCode(null)).toBe(false);
  });
});
