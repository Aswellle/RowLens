/**
 * Query worker message protocol. Every message carries a `queryId`; the
 * client ignores results whose queryId is not the newest one, so a slow scan
 * can never overwrite a newer query's state (architecture §8).
 */
import type { ColumnId, RowIndex } from '../dataset/types';
import type { SortDirection } from './types';

export type QueryId = string;

export type QuerySortSpec = {
  /** Index into the query's column-id list. */
  columnIndex: number;
  direction: SortDirection;
};

export type QueryRequestSpec = {
  datasetId: string;
  /** Dataset column ids in display order (search/sort indexes refer to this). */
  columns: ColumnId[];
  search: string;
  columnFilters: Partial<Record<ColumnId, string>>;
  sort?: QuerySortSpec;
};

// --- Main thread → Query Worker ---

export type MainToQueryWorker =
  | { type: 'QUERY_START'; queryId: QueryId; spec: QueryRequestSpec }
  | { type: 'CANCEL'; queryId: QueryId };

// --- Query Worker → Main thread ---

export type QueryWorkerToMain =
  | { type: 'QUERY_PROGRESS'; queryId: QueryId; scanned: number; matched: number }
  | {
      type: 'QUERY_DONE';
      queryId: QueryId;
      rowIndices: RowIndex[];
      matched: number;
      totalRows: number;
    }
  | { type: 'QUERY_LIMIT'; queryId: QueryId; matched: number; limit: number }
  | { type: 'QUERY_CANCELLED'; queryId: QueryId }
  | {
      type: 'ERROR';
      queryId: QueryId;
      failure: { code: 'QUERY_FAILED' | 'DATASET_NOT_FOUND'; detail: string };
    };
