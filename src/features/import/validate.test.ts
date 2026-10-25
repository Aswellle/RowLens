import { describe, expect, it } from 'vitest';
import { AppError } from '../../app/app-error';
import type { DatasetFormat } from '../dataset/types';
import { detectFormat, parseFormat, validateForImport } from './validate';

describe('detectFormat', () => {
  it('detects supported extensions case-insensitively', () => {
    expect(detectFormat({ name: 'a.csv', size: 1 })).toBe<DatasetFormat>('csv');
    expect(detectFormat({ name: 'B.TSV', size: 1 })).toBe<DatasetFormat>('tsv');
    expect(detectFormat({ name: 'c.JsonL', size: 1 })).toBe<DatasetFormat>('jsonl');
    expect(detectFormat({ name: 'd.ndjson', size: 1 })).toBe<DatasetFormat>('ndjson');
  });

  it('falls back to MIME only when the file name has no extension', () => {
    expect(detectFormat({ name: 'export', size: 1, type: 'text/csv' })).toBe('csv');
    expect(
      detectFormat({ name: 'dump', size: 1, type: 'application/x-ndjson; charset=utf-8' }),
    ).toBe('jsonl');
  });

  it('never lets a spoofed MIME override an explicit wrong extension', () => {
    // .xlsx with a csv MIME stays unsupported: the extension is the user's choice.
    expect(detectFormat({ name: 'report.xlsx', size: 1, type: 'text/csv' })).toBeNull();
  });

  it('returns null for unknown names with no usable MIME', () => {
    expect(
      detectFormat({ name: 'data.parquet', size: 1, type: 'application/octet-stream' }),
    ).toBeNull();
    expect(detectFormat({ name: 'no-extension', size: 1 })).toBeNull();
  });
});

describe('parseFormat', () => {
  it('normalises ndjson onto the jsonl pipeline', () => {
    expect(parseFormat('ndjson')).toBe('jsonl');
    expect(parseFormat('jsonl')).toBe('jsonl');
    expect(parseFormat('csv')).toBe('csv');
    expect(parseFormat('tsv')).toBe('tsv');
  });
});

describe('validateForImport', () => {
  it('accepts supported files and returns their format', () => {
    expect(validateForImport({ name: 'x.csv', size: 10 })).toBe('csv');
  });

  it('allows empty files (zero-record datasets, not silent failure)', () => {
    expect(validateForImport({ name: 'empty.csv', size: 0 })).toBe('csv');
  });

  it('rejects unsupported formats with an actionable error', () => {
    try {
      validateForImport({ name: 'x.xlsx', size: 10 });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe('UNSUPPORTED_FORMAT');
      expect((error as AppError).message).toContain('.csv');
    }
  });

  it('rejects files over the configured cap', () => {
    try {
      validateForImport({ name: 'big.csv', size: 101 * 1024 * 1024 }, 100 * 1024 * 1024);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as AppError).code).toBe('FILE_TOO_LARGE');
      expect((error as AppError).message).toContain('100 MiB');
    }
  });
});
