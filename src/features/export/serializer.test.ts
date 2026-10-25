// @vitest-environment jsdom
import Papa from 'papaparse';
import { describe, expect, it } from 'vitest';
import { serializeCsv, type CsvSerializerStats } from './serializer';

async function* rowsOf(table: (string | null)[][]): AsyncGenerator<(string | null)[]> {
  for (const row of table) yield row;
}

async function drain(
  options: Parameters<typeof serializeCsv>[0],
): Promise<{ text: string; stats: CsvSerializerStats }> {
  const stats: CsvSerializerStats = { rows: 0, protectedCells: 0, bytes: 0 };
  let text = '';
  for await (const chunk of serializeCsv(options, stats)) text += chunk;
  return { text, stats };
}

/** The export contract: an independent parser must read back exactly what went in. */
function parseWithPapa(text: string): string[][] {
  // Per RFC 4180 the final CRLF terminates the last record; Papa's string
  // mode would otherwise report it as an extra empty record.
  const body = text.endsWith('\r\n') ? text.slice(0, -2) : text;
  // The dialect is known (we wrote it); delimiter auto-detection is not under
  // test and single-column documents would defeat it anyway.
  const result = Papa.parse<string[]>(body, {
    header: false,
    skipEmptyLines: false,
    delimiter: ',',
  });
  if (result.errors.length > 0) {
    throw new Error(`re-parse errors: ${JSON.stringify(result.errors)}`);
  }
  return result.data;
}

describe('serializeCsv', () => {
  const TABLE: (string | null)[][] = [
    ['Alice', '30', 'plain'],
    ['Bo,b', 'has "quotes"', 'line\nbreak'],
    [' =SUM(A1)', 'tabs\there', null],
  ];

  it('round-trips values through an independent parser with CRLF endings', async () => {
    const { text, stats } = await drain({
      header: ['name', 'note', 'extra'],
      rows: rowsOf(TABLE),
      safetyMode: 'raw',
    });
    expect(text).toContain('\r\n');
    expect(text.endsWith('\r\n')).toBe(true);
    expect(parseWithPapa(text)).toEqual([
      ['name', 'note', 'extra'],
      ...TABLE.map((row) => row.map((cell) => cell ?? '')),
    ]);
    expect(stats.rows).toBe(3);
    expect(stats.protectedCells).toBe(0);
  });

  it('prefixes formula-risk cells in spreadsheet-safe mode and still round-trips', async () => {
    const { text, stats } = await drain({
      header: ['a'],
      rows: rowsOf([['=1+1'], ['+cmd'], ['-1+2'], ['@SUM(1)'], ['\t=x'], ['safe']]),
      safetyMode: 'spreadsheet-safe',
    });
    expect(stats.protectedCells).toBe(5);
    expect(parseWithPapa(text)).toEqual([
      ['a'],
      ["'=1+1"],
      ["'+cmd"],
      ["'-1+2"],
      ["'@SUM(1)"],
      ["'\t=x"],
      ['safe'],
    ]);
  });

  it('encodes leading zeros, dates and whitespace exactly as data', async () => {
    const table = [['00123', '2026-10-26', '  padded  ']];
    const { text } = await drain({
      header: ['id', 'date', 'label'],
      rows: rowsOf(table),
      safetyMode: 'raw',
    });
    expect(parseWithPapa(text)).toEqual([['id', 'date', 'label'], ...table]);
  });

  it('yields multiple chunks for long inputs and reports progress', async () => {
    const big: (string | null)[][] = Array.from({ length: 1200 }, (_, i) => [String(i), 'x']);
    const progress: number[] = [];
    const stats: CsvSerializerStats = { rows: 0, protectedCells: 0, bytes: 0 };
    let chunks = 0;
    for await (const _chunk of serializeCsv(
      {
        header: ['n', 'v'],
        rows: rowsOf(big),
        safetyMode: 'raw',
        rowsPerChunk: 500,
        onProgress: (rows) => progress.push(rows),
      },
      stats,
    )) {
      chunks += 1;
    }
    expect(stats.rows).toBe(1200);
    expect(chunks).toBeGreaterThanOrEqual(3); // 500 + 500 + 200 (+ header share)
    expect(progress.at(-1)).toBe(1200);
    expect(stats.bytes).toBeGreaterThan(0);
  });

  it('emits a header-only document for empty row sets', async () => {
    const { text, stats } = await drain({
      header: ['only', 'header'],
      rows: rowsOf([]),
      safetyMode: 'raw',
    });
    expect(text).toBe('only,header\r\n');
    expect(stats.rows).toBe(0);
  });
});
