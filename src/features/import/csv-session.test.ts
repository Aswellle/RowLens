// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { ColumnDefinition } from '../dataset/types';
import { runCsvImport, type ImportBatch } from './csv-session';
import { WarningAggregator } from './warnings';

function csvFile(content: string, name = 'fixture.csv'): File {
  return new File([content], name, { type: 'text/csv' });
}

/** Drain a session without backpressure (immediate persistence). */
async function importAll(content: string, options: { hasHeader: boolean; delimiter?: string }) {
  const batches: ImportBatch[] = [];
  const warnings = new WarningAggregator();
  const session = runCsvImport(
    csvFile(content),
    options,
    {
      onBatch: async (batch) => {
        batches.push(batch);
      },
    },
    warnings,
  );
  const result = await session.done;
  return { result, batches, warnings };
}

function flatten(batches: ImportBatch[]): Record<string, string | null>[] {
  return batches.flatMap((batch) => batch.rows.map((row) => row.values));
}

describe('CSV import contract', () => {
  it('parses headers, commas and quoted fields; values stay strings', async () => {
    const { result, batches } = await importAll('id,amount\n00123,"1,050"\n42,9\n', {
      hasHeader: true,
    });
    expect(result.status).toBe('done');
    expect(result.rowCount).toBe(2);
    expect(result.columns.map((c: ColumnDefinition) => c.label)).toEqual(['id', 'amount']);
    const rows = flatten(batches);
    expect(rows[0]).toEqual({ c0: '00123', c1: '1,050' }); // leading zero preserved
    expect(rows[1]).toEqual({ c0: '42', c1: '9' });
  });

  it('keeps quoted fields containing quotes, commas and newlines as one record', async () => {
    const content = 'name,note\n"Smith, John","line1\nline2 with ""quotes"""\nJane,plain\n';
    const { result, batches } = await importAll(content, { hasHeader: true });
    expect(result.rowCount).toBe(2);
    const rows = flatten(batches);
    expect(rows[0]?.c1).toBe('line1\nline2 with "quotes"');
    expect(rows[1]?.c0).toBe('Jane');
  });

  it('keeps duplicate and empty header labels as separate positional columns', async () => {
    const { result, batches } = await importAll('id,,id\n1,A,2\n3,B,4\n', { hasHeader: true });
    expect(result.columns.map((c: ColumnDefinition) => c.id)).toEqual(['c0', 'c1', 'c2']);
    expect(result.columns.map((c: ColumnDefinition) => c.label)).toEqual(['id', 'Column 2', 'id']);
    const rows = flatten(batches);
    // Both id columns carry their own values — nothing merged or overwritten.
    expect(rows[0]).toEqual({ c0: '1', c1: 'A', c2: '2' });
    expect(rows[1]).toEqual({ c0: '3', c1: 'B', c2: '4' });
  });

  it('parses headerless TSV with tab delimiter and placeholder labels', async () => {
    const { result, batches } = await importAll('a\tb\nc\td\n', {
      hasHeader: false,
      delimiter: '\t',
    });
    expect(result.columns.map((c: ColumnDefinition) => c.label)).toEqual(['Column 1', 'Column 2']);
    expect(flatten(batches)).toEqual([
      { c0: 'a', c1: 'b' },
      { c0: 'c', c1: 'd' },
    ]);
  });

  it('strips a UTF-8 BOM only at the file start and accepts CRLF line endings', async () => {
    const content = '\uFEFFname,value\r\nAda,1\r\nGrace,2\r\n';
    const { result, batches } = await importAll(content, { hasHeader: true });
    expect(result.columns[0]?.label).toBe('name'); // no BOM in the header
    expect(result.rowCount).toBe(2);
    expect(flatten(batches)[0]?.c1).toBe('1');
  });

  it('handles empty files and header-only files with zero records', async () => {
    const empty = await importAll('', { hasHeader: true });
    expect(empty.result.rowCount).toBe(0);
    expect(empty.result.columns).toEqual([]);

    const headerOnly = await importAll('a,b,c\n', { hasHeader: true });
    expect(headerOnly.result.rowCount).toBe(0);
    expect(headerOnly.result.columns.map((c) => c.label)).toEqual(['a', 'b', 'c']);
  });

  it('imports the final record when the file has no trailing newline', async () => {
    const { result } = await importAll('x,y\n1,2\n3,4', { hasHeader: true });
    expect(result.rowCount).toBe(2);
  });

  it('reports field-count mismatches and preserves wider rows by growing the schema', async () => {
    const content = 'a,b\n1,2\n3\n4,5,6\n';
    const { result, batches } = await importAll(content, { hasHeader: true });
    expect(result.rowCount).toBe(3);
    // Schema grew to 3 columns: the third field of row 3 is preserved.
    expect(result.columns).toHaveLength(3);
    const rows = flatten(batches);
    // Rows ingested before the schema grew legitimately lack the new key;
    // readers treat an absent key as a missing value (null).
    expect(rows[0]).toEqual({ c0: '1', c1: '2' });
    expect(rows[1]).toEqual({ c0: '3' });
    expect(rows[2]).toEqual({ c0: '4', c1: '5', c2: '6' });
    // Both the short row (physical line 3) and the wide row (line 4) warn.
    const mismatch = result.warnings.find((w) => w.kind === 'field-count-mismatch');
    expect(mismatch?.count).toBe(2);
    expect(mismatch?.sampleLineNumbers).toEqual([3, 4]);
  });

  it('preserves blank records instead of dropping them (cleaning decides later)', async () => {
    const { result } = await importAll('a,b\n1,2\n\n3,4\n', { hasHeader: true });
    expect(result.rowCount).toBe(3);
  });

  it('flags replacement characters as a suspected encoding problem', async () => {
    const { result } = await importAll('a\n\uFFFD\n', { hasHeader: true });
    const encoding = result.warnings.find((w) => w.kind === 'encoding-suspect');
    expect(encoding?.count).toBe(1);
  });
});

describe('CSV import backpressure', () => {
  function makeRows(count: number): string {
    const lines: string[] = ['n'];
    for (let i = 0; i < count; i++) lines.push(String(i));
    return `${lines.join('\n')}\n`;
  }

  it('emits batches of at most the batch size and waits for persistence', async () => {
    const emitOrder: number[] = [];
    const gates: Array<() => void> = [];
    const batches: ImportBatch[] = [];
    const warnings = new WarningAggregator();
    const session = runCsvImport(
      csvFile(makeRows(1200)),
      { hasHeader: true },
      {
        onBatch: (batch) => {
          batches.push(batch);
          emitOrder.push(batches.length);
          return new Promise<void>((resolve) => {
            gates.push(resolve);
          });
        },
      },
      warnings,
    );

    // Papa chunking is async; wait for the first batch to arrive.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(batches[0]?.rows).toHaveLength(500);
    // While unresolved, no further batch was emitted.
    expect(batches).toHaveLength(1);

    gates[0]?.();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(batches).toHaveLength(2);
    expect(batches[1]?.rows).toHaveLength(500);

    gates[1]?.();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(batches).toHaveLength(3);
    expect(batches[2]?.rows).toHaveLength(200);

    gates[2]?.();
    const result = await session.done;
    expect(result.status).toBe('done');
    expect(result.rowCount).toBe(1200);
    expect(emitOrder).toEqual([1, 2, 3]);
  });

  it('settles as cancelled when aborted mid-import', async () => {
    const warnings = new WarningAggregator();
    const gates: Array<() => void> = [];
    const session = runCsvImport(
      csvFile(makeRows(1200)),
      { hasHeader: true },
      {
        onBatch: () =>
          new Promise<void>((resolve) => {
            gates.push(resolve);
          }),
      },
      warnings,
    );

    await new Promise((resolve) => setTimeout(resolve, 50));
    session.abort();
    for (const gate of gates) gate();
    const result = await session.done;
    expect(result.status).toBe('cancelled');
    expect(result.warnings).toEqual([]);
  });
});
