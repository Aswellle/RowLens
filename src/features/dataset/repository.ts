/**
 * Dataset persistence over IndexedDB. Rows are written batch-by-batch (one
 * transaction per batch, never one giant transaction); a dataset only becomes
 * 'ready' after every batch succeeded and finalize ran. Cancellation and
 * failure paths delete every trace of the partial dataset.
 */
import { toAppError } from '../../app/app-error';
import type { ImportJobId } from '../import/protocol';
import { openDatabase } from './idb';
import {
  DATASET_TTL_MS,
  IDB_STORE_DATASETS,
  IDB_STORE_IMPORT_ERRORS,
  IDB_STORE_ROWS,
} from './constants';
import type { DatasetId, DatasetMetadata, StoredRow } from './types';

export type StoredImportError = {
  datasetId: DatasetId;
  physicalLineNumber: number;
  kind: string;
};

function txnDone(txn: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    txn.oncomplete = () => resolve();
    txn.onerror = () => reject(toAppError(txn.error));
    txn.onabort = () => reject(toAppError(txn.error ?? new Error('transaction aborted')));
  });
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(toAppError(request.error));
  });
}

export class DatasetRepository {
  constructor(private readonly db: IDBDatabase) {}

  static async open(factory?: IDBFactory): Promise<DatasetRepository> {
    return new DatasetRepository(await openDatabase(factory));
  }

  /** Insert the initial 'importing' record for a new dataset. */
  async insertDataset(meta: DatasetMetadata): Promise<void> {
    const txn = this.db.transaction(IDB_STORE_DATASETS, 'readwrite');
    txn.objectStore(IDB_STORE_DATASETS).put(meta);
    await txnDone(txn);
  }

  /**
   * Persist one batch of rows in a single transaction. Rejects with
   * STORAGE_QUOTA_EXCEEDED when the browser quota is hit.
   */
  async putRows(datasetId: DatasetId, rows: readonly StoredRow[]): Promise<void> {
    if (rows.length === 0) return;
    const txn = this.db.transaction(IDB_STORE_ROWS, 'readwrite');
    const store = txn.objectStore(IDB_STORE_ROWS);
    for (const row of rows) {
      store.put({ datasetId, rowIndex: row.rowIndex, values: row.values });
    }
    await txnDone(txn);
  }

  async putImportErrors(errors: readonly StoredImportError[]): Promise<void> {
    if (errors.length === 0) return;
    const txn = this.db.transaction(IDB_STORE_IMPORT_ERRORS, 'readwrite');
    const store = txn.objectStore(IDB_STORE_IMPORT_ERRORS);
    for (const error of errors) store.put(error);
    await txnDone(txn);
  }

  /** Only call after every batch persisted; flips the status to the given one. */
  async finalizeDataset(meta: DatasetMetadata): Promise<void> {
    const txn = this.db.transaction(IDB_STORE_DATASETS, 'readwrite');
    txn.objectStore(IDB_STORE_DATASETS).put(meta);
    await txnDone(txn);
  }

  async getDataset(id: DatasetId): Promise<DatasetMetadata | undefined> {
    const txn = this.db.transaction(IDB_STORE_DATASETS, 'readonly');
    const value = await requestToPromise(
      txn.objectStore(IDB_STORE_DATASETS).get(id) as IDBRequest<DatasetMetadata | undefined>,
    );
    return value ?? undefined;
  }

  async listDatasets(): Promise<DatasetMetadata[]> {
    const txn = this.db.transaction(IDB_STORE_DATASETS, 'readonly');
    return requestToPromise(
      txn.objectStore(IDB_STORE_DATASETS).getAll() as IDBRequest<DatasetMetadata[]>,
    );
  }

  /** Windowed read over stored rows, ordered by rowIndex. */
  async readRows(datasetId: DatasetId, offset: number, limit: number): Promise<StoredRow[]> {
    const txn = this.db.transaction(IDB_STORE_ROWS, 'readonly');
    const range = IDBKeyRange.bound([datasetId, offset], [datasetId, offset + limit - 1]);
    return requestToPromise(
      txn.objectStore(IDB_STORE_ROWS).getAll(range) as IDBRequest<StoredRow[]>,
    );
  }

  async countRows(datasetId: DatasetId): Promise<number> {
    const txn = this.db.transaction(IDB_STORE_ROWS, 'readonly');
    const range = IDBKeyRange.bound([datasetId, 0], [datasetId, Number.MAX_SAFE_INTEGER]);
    return requestToPromise(txn.objectStore(IDB_STORE_ROWS).count(range) as IDBRequest<number>);
  }

  /**
   * Remove the dataset and every stored row and import error for it.
   *
   * Row keys are the compound [datasetId, rowIndex] with rowIndex < rowCount,
   * so when the finalized metadata is available the deletes are issued
   * directly against that key range — all synchronously in one transaction
   * (awaiting between IndexedDB requests would let the transaction
   * auto-commit). Falls back to an index-cursor sweep when metadata is gone.
   */
  async deleteDataset(datasetId: DatasetId): Promise<void> {
    const meta = await this.getDataset(datasetId);
    await new Promise<void>((resolve, reject) => {
      const txn = this.db.transaction(
        [IDB_STORE_DATASETS, IDB_STORE_ROWS, IDB_STORE_IMPORT_ERRORS],
        'readwrite',
      );
      txn.objectStore(IDB_STORE_DATASETS).delete(datasetId);
      txn
        .objectStore(IDB_STORE_IMPORT_ERRORS)
        .delete(IDBKeyRange.bound([datasetId, 0], [datasetId, Number.MAX_SAFE_INTEGER]));
      const rows = txn.objectStore(IDB_STORE_ROWS);
      // Only a finalized dataset's rowCount describes the stored key range;
      // an in-flight or partial one falls back to the cursor sweep.
      if (meta?.status === 'ready') {
        for (let rowIndex = 0; rowIndex < meta.rowCount; rowIndex++) {
          rows.delete([datasetId, rowIndex]);
        }
      } else {
        const request = rows.index('byDataset').openKeyCursor(IDBKeyRange.only(datasetId));
        request.onsuccess = () => {
          const cursor = request.result;
          if (cursor) {
            rows.delete(cursor.primaryKey);
            cursor.continue();
          }
        };
      }
      txn.oncomplete = () => resolve();
      txn.onerror = () => reject(toAppError(txn.error));
      txn.onabort = () => reject(toAppError(txn.error ?? new Error('transaction aborted')));
    });
  }

  /**
   * Startup cleanup (security doc §3): drop datasets that were interrupted
   * (cancelled/failed), expired while still 'importing', or outlived the TTL
   * in any state. Returns the number of removed datasets.
   */
  async cleanupStale(now: number = Date.now()): Promise<number> {
    const datasets = await this.listDatasets();
    let removed = 0;
    for (const meta of datasets) {
      const expired = now - meta.lastTouchedAt > DATASET_TTL_MS;
      const stale =
        meta.status === 'cancelled' ||
        meta.status === 'failed' ||
        (meta.status === 'importing' && expired) ||
        expired;
      if (stale) {
        await this.deleteDataset(meta.id);
        removed += 1;
      }
    }
    return removed;
  }
}

export type { ImportJobId };
