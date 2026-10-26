/**
 * IndexedDB database bootstrap. Store layout follows docs/02-architecture.md
 * §6 and must stay identical across the main thread and any worker access:
 *
 *   datasets     keyPath 'id'
 *   rows         keyPath ['datasetId', 'rowIndex'], index 'byDataset'
 *   importErrors keyPath ['datasetId', 'physicalLineNumber']
 *   cellEdits    keyPath 'datasetId' (v2; user edits, never mixed into rows)
 *   pipelines    keyPath 'datasetId' (v3; configured cleaning steps)
 *   views        keyPath 'datasetId' (v4; last query view per dataset)
 *   presets      keyPath 'id' (v5; one global record holding every preset)
 *
 * The upgrade only creates stores that are missing, so a v1 database keeps all
 * of its imported rows and gains an empty edit store.
 */
import { AppError, toAppError } from '../../app/app-error';
import {
  IDB_NAME,
  IDB_STORE_CELL_EDITS,
  IDB_STORE_DATASETS,
  IDB_STORE_PIPELINES,
  IDB_STORE_PRESETS,
  IDB_STORE_IMPORT_ERRORS,
  IDB_STORE_ROWS,
  IDB_STORE_VIEWS,
  IDB_VERSION,
} from './constants';

let sharedPromise: Promise<IDBDatabase> | null = null;

function openWith(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(IDB_NAME, IDB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(IDB_STORE_DATASETS)) {
        db.createObjectStore(IDB_STORE_DATASETS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(IDB_STORE_ROWS)) {
        const rows = db.createObjectStore(IDB_STORE_ROWS, {
          keyPath: ['datasetId', 'rowIndex'],
        });
        rows.createIndex('byDataset', 'datasetId');
      }
      if (!db.objectStoreNames.contains(IDB_STORE_IMPORT_ERRORS)) {
        db.createObjectStore(IDB_STORE_IMPORT_ERRORS, {
          keyPath: ['datasetId', 'physicalLineNumber'],
        });
      }
      // v2: edits live in their own store so the imported rows stay pristine.
      if (!db.objectStoreNames.contains(IDB_STORE_CELL_EDITS)) {
        db.createObjectStore(IDB_STORE_CELL_EDITS, { keyPath: 'datasetId' });
      }
      // v3: the cleaning pipeline is configuration, not data, but losing it on
      // every reload makes the workbench feel stateless.
      if (!db.objectStoreNames.contains(IDB_STORE_PIPELINES)) {
        db.createObjectStore(IDB_STORE_PIPELINES, { keyPath: 'datasetId' });
      }
      // v4: the last query view. Same reasoning one step further: the filter
      // the user was reading through is part of "where I left off".
      if (!db.objectStoreNames.contains(IDB_STORE_VIEWS)) {
        db.createObjectStore(IDB_STORE_VIEWS, { keyPath: 'datasetId' });
      }
      // v5: named cleaning recipes. Deliberately *not* keyed by dataset — a
      // preset exists to be applied to files not opened yet.
      if (!db.objectStoreNames.contains(IDB_STORE_PRESETS)) {
        db.createObjectStore(IDB_STORE_PRESETS, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(toAppError(request.error));
    request.onblocked = () => {
      // Another tab holds an older connection; the request stays pending and
      // will settle when that tab closes. Nothing to do here.
    };
  });
}

/**
 * Open the shared connection. The promise is memoised so repeated callers
 * reuse one connection; a failure clears the memo so the next call retries.
 */
export function openDatabase(factory?: IDBFactory): Promise<IDBDatabase> {
  if (factory) return openWith(factory);
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(
      new AppError('STORAGE_UNAVAILABLE', 'IndexedDB is not available in this browser.'),
    );
  }
  if (!sharedPromise) {
    sharedPromise = openWith(indexedDB).catch((error: unknown) => {
      sharedPromise = null;
      throw error;
    });
  }
  return sharedPromise;
}
