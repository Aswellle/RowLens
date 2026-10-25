/**
 * Ordered row batches for the query engine, read as bounded windows through
 * the shared repository (getAll over the compound-key range). Windowed reads
 * give natural backpressure — the next batch is only fetched after the
 * engine consumed the previous one — and avoid keeping an IndexedDB cursor
 * alive across awaits (a paused cursor lets the transaction auto-commit).
 */
import type { DatasetRepository } from '../dataset/repository';
import { ROW_WRITE_BATCH_SIZE } from '../dataset/constants';
import type { EngineRow } from './engine';

export function scanDatasetRows(
  repository: Pick<DatasetRepository, 'readRows'>,
  datasetId: string,
  batchSize: number = ROW_WRITE_BATCH_SIZE,
): AsyncGenerator<EngineRow[]> {
  let offset = 0;
  let finished = false;
  return (async function* () {
    while (!finished) {
      const rows = await repository.readRows(datasetId, offset, batchSize);
      if (rows.length === 0) {
        finished = true;
        return;
      }
      yield rows.map((row) => ({ rowIndex: row.rowIndex, values: row.values }));
      offset += rows.length;
      if (rows.length < batchSize) {
        finished = true;
      }
    }
  })();
}
