/**
 * Query worker: scans the dataset's stored rows through the shared IndexedDB
 * schema and runs the query engine off the main thread. Results are tagged
 * with the queryId; a CANCEL for the running query stops the scan between
 * batches. Errors stay generic — cell content never enters messages.
 */
import { DatasetRepository } from '../features/dataset/repository';
import { QUERY_MATCH_LIMIT } from '../features/dataset/constants';
import { requestToEngineSpec, runQueryEngine } from '../features/query/engine';
import { scanDatasetRows } from '../features/query/scan';
import type { MainToQueryWorker, QueryRequestSpec } from '../features/query/protocol';

type ActiveQuery = {
  queryId: string;
  cancel: () => void;
};

let active: ActiveQuery | null = null;

const post = (message: unknown): void => {
  (self as unknown as { postMessage(message: unknown): void }).postMessage(message);
};

let repositoryPromise: Promise<DatasetRepository> | null = null;

async function getRepository(): Promise<DatasetRepository> {
  repositoryPromise ??= DatasetRepository.open();
  return repositoryPromise;
}

async function runQuery(queryId: string, spec: QueryRequestSpec): Promise<void> {
  let cancelled = false;
  active = {
    queryId,
    cancel: () => {
      cancelled = true;
    },
  };

  try {
    const repository = await getRepository();
    const dataset = await repository.getDataset(spec.datasetId);
    if (dataset === undefined) {
      post({
        type: 'ERROR',
        queryId,
        failure: { code: 'DATASET_NOT_FOUND', detail: 'The dataset is no longer stored.' },
      });
      return;
    }

    const result = await runQueryEngine(
      scanDatasetRows(repository, spec.datasetId),
      requestToEngineSpec(spec),
      {
        matchLimit: QUERY_MATCH_LIMIT,
        onProgress: (scanned, matched) =>
          post({ type: 'QUERY_PROGRESS', queryId, scanned, matched }),
        isCancelled: () => cancelled,
      },
    );

    switch (result.status) {
      case 'done':
        post({
          type: 'QUERY_DONE',
          queryId,
          rowIndices: result.rowIndices,
          matched: result.matched,
          totalRows: result.totalRows,
        });
        break;
      case 'limit':
        post({ type: 'QUERY_LIMIT', queryId, matched: result.matched, limit: result.limit });
        break;
      case 'cancelled':
        post({ type: 'QUERY_CANCELLED', queryId });
        break;
    }
  } catch {
    post({
      type: 'ERROR',
      queryId,
      failure: { code: 'QUERY_FAILED', detail: 'The query could not be completed.' },
    });
  } finally {
    if (active?.queryId === queryId) active = null;
  }
}

self.onmessage = (event: MessageEvent<MainToQueryWorker>): void => {
  const message = event.data;
  if (message.type === 'QUERY_START') {
    if (active !== null) return; // one query at a time per worker
    void runQuery(message.queryId, message.spec);
    return;
  }
  if (message.type === 'CANCEL' && message.queryId === active?.queryId) {
    active.cancel();
  }
};
