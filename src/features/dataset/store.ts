/**
 * Write-through in-memory mirror of the importing dataset. The worker's
 * batches pass through the main thread on their way to IndexedDB; this store
 * keeps them in a compact column-ordered form so the grid can read cells
 * synchronously without putting the table into React state. Rows are only
 * appended during import; removal resets the whole store.
 *
 * Memory boundary (ADR-014): acceptable while MAX_FILE_BYTES caps imports;
 * the query worker replaces these reads in a later development step.
 */
import type { ColumnDefinition } from './types';
import type { ImportWireRow } from '../import/protocol';

export class InMemoryDataset {
  private columns: ColumnDefinition[] = [];
  private readonly idToIndex = new Map<string, number>();
  private rows: (string | null)[][] = [];

  appendBatch(
    schemaAppend: readonly ColumnDefinition[] | undefined,
    wireRows: readonly ImportWireRow[],
  ): void {
    if (schemaAppend) {
      for (const column of schemaAppend) {
        this.idToIndex.set(column.id, this.columns.length);
        this.columns.push(column);
      }
    }
    for (const wireRow of wireRows) {
      const row: (string | null)[] = new Array<string | null>(this.columns.length).fill(null);
      for (const [id, value] of Object.entries(wireRow.values)) {
        const index = this.idToIndex.get(id);
        if (index !== undefined) row[index] = value;
      }
      this.rows.push(row);
    }
  }

  reset(): void {
    this.columns = [];
    this.idToIndex.clear();
    this.rows = [];
  }

  get columnCount(): number {
    return this.columns.length;
  }

  get rowCount(): number {
    return this.rows.length;
  }

  getColumns(): ColumnDefinition[] {
    return this.columns;
  }

  getCell(rowIndex: number, columnIndex: number): string | null {
    return this.rows[rowIndex]?.[columnIndex] ?? null;
  }

  /** All cell values of a row (used by global search). */
  getRowValues(rowIndex: number): (string | null)[] {
    return this.rows[rowIndex] ?? [];
  }
}
