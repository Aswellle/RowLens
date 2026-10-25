// @vitest-environment jsdom
// (IMPORT_START carries a File; constructing one needs the DOM globals.)
import { describe, expect, it } from 'vitest';
import type { ImportTerminalMessage, ImportWorkerToMain, MainToImportWorker } from './protocol';

/**
 * Phase 0 contract lock for the import worker message protocol
 * (docs/02-architecture.md §7). These tests pin the message discriminants and
 * invariants the Phase 2 implementation must satisfy; they do not run a real
 * worker yet.
 */
describe('MainToImportWorker discriminated union', () => {
  it('every main→worker message carries a type and jobId', () => {
    const messages: MainToImportWorker[] = [
      {
        type: 'IMPORT_START',
        jobId: 'job-1',
        options: { format: 'csv', hasHeader: true },
        file: new File(['a,b\n1,2\n'], 'job-1.csv'),
      },
      { type: 'ACK', jobId: 'job-1', batchSeq: 0 },
      { type: 'CANCEL', jobId: 'job-1' },
    ];
    for (const message of messages) {
      expect(typeof message.type).toBe('string');
      expect(typeof message.jobId).toBe('string');
    }
  });

  it('supports discriminating messages by type at compile-checked runtime', () => {
    const ack: MainToImportWorker = { type: 'ACK', jobId: 'j', batchSeq: 3 };
    if (ack.type === 'ACK') {
      expect(ack.batchSeq).toBe(3);
    } else {
      throw new Error('discriminant narrowing failed');
    }
  });
});

describe('ImportWorkerToMain discriminated union', () => {
  it('BATCH carries batchSeq and rows for backpressure bookkeeping', () => {
    const batch: ImportWorkerToMain = {
      type: 'BATCH',
      jobId: 'job-1',
      batchSeq: 0,
      rows: [{ rowIndex: 0, values: { c0: 'a', c1: null } }],
    };
    if (batch.type !== 'BATCH') throw new Error('expected BATCH');
    expect(batch.rows).toHaveLength(1);
    expect(batch.batchSeq).toBe(0);
    expect(batch.schemaAppend).toBeUndefined();
  });

  it('terminal messages are exactly IMPORT_DONE, IMPORT_CANCELLED and ERROR', () => {
    const samples: ImportTerminalMessage[] = [
      {
        type: 'IMPORT_DONE',
        jobId: 'j',
        rowCount: 0,
        columns: [],
        parseErrorCount: 0,
        warnings: [],
      },
      { type: 'IMPORT_CANCELLED', jobId: 'j' },
      { type: 'ERROR', jobId: 'j', failure: { code: 'PARSE_FAILED', detail: 'unrecoverable' } },
    ];
    expect(samples.map((m) => m.type)).toEqual(['IMPORT_DONE', 'IMPORT_CANCELLED', 'ERROR']);
  });

  it('ERROR failures use stable AppErrorCode values and never carry raw row content', () => {
    const error: ImportWorkerToMain = {
      type: 'ERROR',
      jobId: 'j',
      failure: {
        code: 'STORAGE_QUOTA_EXCEEDED',
        detail: 'browser quota exceeded',
        physicalLine: 42,
      },
    };
    if (error.type !== 'ERROR') throw new Error('expected ERROR');
    expect(error.failure.code).toBe('STORAGE_QUOTA_EXCEEDED');
    expect(error.failure.physicalLine).toBe(42);
    // Contract: detail is a category description, not the offending row text.
    expect(error.failure.detail).not.toMatch(/[,;]/);
  });
});
