/**
 * Streaming CSV serializer: converts a row-value iterator into string chunks
 * with CRLF line endings, applying the chosen safety mode per cell and
 * collecting statistics (rows written, cells modified for safety, bytes).
 * The generator pattern keeps memory bounded — nothing accumulates the whole
 * document here.
 */
import { csvLine, hasFormulaRisk, protectFormulaValue } from './csv';
import type { CsvSafetyMode } from './types';

export type CsvSerializerStats = {
  rows: number;
  protectedCells: number;
  bytes: number;
};

export type SerializeCsvOptions = {
  header: readonly string[];
  rows: AsyncIterable<readonly (string | null)[]>;
  safetyMode: CsvSafetyMode;
  /** Rows per yielded chunk (rows are small; chunking bounds memory). */
  rowsPerChunk?: number;
  onProgress?: (rows: number) => void;
};

export async function* serializeCsv(
  options: SerializeCsvOptions,
  stats: CsvSerializerStats,
): AsyncGenerator<string> {
  const rowsPerChunk = options.rowsPerChunk ?? 500;
  const encoder = new TextEncoder();

  const emit = (line: string): string => {
    const chunk = `${line}\r\n`;
    stats.bytes += encoder.encode(chunk).byteLength;
    return chunk;
  };

  const applySafety = (values: readonly (string | null)[]): string[] =>
    values.map((value) => {
      const cell = value ?? '';
      if (options.safetyMode === 'spreadsheet-safe' && hasFormulaRisk(cell)) {
        stats.protectedCells += 1;
        return protectFormulaValue(cell);
      }
      return cell;
    });

  stats.rows = 0;
  stats.protectedCells = 0;
  stats.bytes = 0;

  let buffer = '';
  yield emit(csvLine(options.header));

  for await (const row of options.rows) {
    buffer += emit(csvLine(applySafety(row)));
    stats.rows += 1;
    if (stats.rows % rowsPerChunk === 0) {
      options.onProgress?.(stats.rows);
      const outgoing = buffer;
      buffer = '';
      yield outgoing;
    }
  }

  if (buffer !== '') yield buffer;
  options.onProgress?.(stats.rows);
}
