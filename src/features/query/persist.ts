/**
 * Serialization for the persisted query view (ADR-031).
 *
 * The view is what the user is looking *at*: the search term, the per-column
 * filters, the sort and the hidden columns. It is configuration, like the
 * cleaning pipeline — saving it never touches a stored row, and restoring it
 * only re-runs the same query the user last saw.
 *
 * The stored form:
 *
 *   { datasetId, updatedAt, format: 1, search, columnFilters, sort, hiddenColumns }
 *
 * `sort` stores a column *id*, not a dataset index: the record belongs to one
 * dataset, but ids survive a re-import that reorders columns better than a
 * position does. The caller maps the id back to its display index.
 *
 * Validation is per field, so a record that outlived its dataset loses only
 * the parts that no longer apply — a filter on a deleted column, not the whole
 * view. Nothing here is guessed: an unusable field falls back to "no
 * restriction", which is exactly what an absent field means.
 */
import type { ColumnId } from '../dataset/types';

/** Bumped when the stored layout changes; older records are ignored. */
export const VIEW_RECORD_FORMAT = 1;

/**
 * A search term longer than this is treated as a corrupt record rather than a
 * real query. The value is far beyond anything typeable into the search box,
 * so dropping it cannot lose a user's work, while it keeps a hand-edited or
 * truncated record from re-running an absurd scan on restore.
 */
const MAX_STORED_SEARCH_LENGTH = 2_000;

/**
 * The sort as stored: by column id, not by dataset index. Ids survive a
 * re-import that reorders columns, which a position does not.
 */
export type StoredSort = {
  columnId: ColumnId;
  direction: 'asc' | 'desc';
};

export type StoredViewRecord = {
  datasetId: string;
  updatedAt: number;
  format: number;
  search: string;
  columnFilters: Record<ColumnId, string>;
  sort: StoredSort | null;
  hiddenColumns: ColumnId[];
};

/** The four query-view fields, in their in-memory form. */
export type ViewState = {
  search: string;
  columnFilters: Record<ColumnId, string>;
  sort: StoredSort | null;
  hiddenColumns: ColumnId[];
};

export function emptyView(): ViewState {
  return { search: '', columnFilters: {}, sort: null, hiddenColumns: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Keeps filters for columns that still exist, with a non-empty literal value.
 * Only allowlisted ids are ever written, so a crafted key such as `__proto__`
 * is dropped rather than assigned.
 */
function pruneFilters(
  value: unknown,
  validColumnIds: ReadonlySet<ColumnId>,
): Record<ColumnId, string> {
  const filters: Record<ColumnId, string> = {};
  if (!isRecord(value)) return filters;
  for (const [columnId, raw] of Object.entries(value)) {
    if (typeof raw !== 'string' || raw === '' || !validColumnIds.has(columnId)) continue;
    filters[columnId] = raw;
  }
  return filters;
}

function pruneSort(value: unknown, validColumnIds: ReadonlySet<ColumnId>): StoredSort | null {
  if (!isRecord(value)) return null;
  const { columnId, direction } = value;
  if (typeof columnId !== 'string' || !validColumnIds.has(columnId)) return null;
  if (direction !== 'asc' && direction !== 'desc') return null;
  return { columnId, direction };
}

/**
 * Keeps hidden columns that still exist. A record that hides *every* column
 * restores nothing: that state leaves no grid to interact with, so it is
 * treated as "no hidden columns" instead of reproducing a dead end.
 */
function pruneHidden(value: unknown, validColumnIds: ReadonlySet<ColumnId>): ColumnId[] {
  if (!Array.isArray(value)) return [];
  const hidden: ColumnId[] = [];
  for (const id of value) {
    if (typeof id === 'string' && validColumnIds.has(id) && !hidden.includes(id)) hidden.push(id);
  }
  if (hidden.length >= validColumnIds.size) return [];
  return hidden;
}

/**
 * Rebuilds the view from a stored record. Returns an empty view (not null) for
 * an unusable record, so callers have one shape to handle; `isActiveView`
 * distinguishes "restored something" from "restored nothing".
 */
export function deserializeView(record: unknown, validColumnIds: ReadonlySet<ColumnId>): ViewState {
  if (!isRecord(record)) return emptyView();
  const rawSearch = record.search;
  const search =
    typeof rawSearch === 'string' && rawSearch.length <= MAX_STORED_SEARCH_LENGTH ? rawSearch : '';
  return {
    search,
    columnFilters: pruneFilters(record.columnFilters, validColumnIds),
    sort: pruneSort(record.sort, validColumnIds),
    hiddenColumns: pruneHidden(record.hiddenColumns, validColumnIds),
  };
}

/**
 * Builds the stored record. Empty filter values are omitted (they mean "no
 * restriction"), and filter keys are sorted so two equal views produce equal
 * records — which is what the debounced writer compares.
 */
export function serializeView(
  view: ViewState,
  datasetId: string,
  now: number = Date.now(),
): StoredViewRecord {
  const columnFilters: Record<ColumnId, string> = {};
  for (const columnId of Object.keys(view.columnFilters).sort()) {
    const value = view.columnFilters[columnId];
    if (value === undefined || value === '') continue;
    columnFilters[columnId] = value;
  }
  return {
    datasetId,
    updatedAt: now,
    format: VIEW_RECORD_FORMAT,
    search: view.search,
    columnFilters,
    sort: view.sort,
    hiddenColumns: [...view.hiddenColumns],
  };
}

/** True when the record is a version this build understands. */
export function isSupportedViewRecord(record: unknown): boolean {
  if (!isRecord(record)) return false;
  return record.format === VIEW_RECORD_FORMAT;
}

/** True when the view restricts or reorders anything. */
export function isActiveView(view: ViewState): boolean {
  return (
    view.search !== '' ||
    Object.values(view.columnFilters).some((value) => value !== '') ||
    view.sort !== null ||
    view.hiddenColumns.length > 0
  );
}

/**
 * Drops references that no longer exist, for a view already in memory (a
 * re-import into the same dataset id can change the schema). Returns the same
 * object when nothing changed, so callers can skip a write.
 */
export function pruneView(view: ViewState, validColumnIds: ReadonlySet<ColumnId>): ViewState {
  const columnFilters = pruneFilters(view.columnFilters, validColumnIds);
  const sort = pruneSort(view.sort, validColumnIds);
  const hiddenColumns = pruneHidden(view.hiddenColumns, validColumnIds);

  const sameFilters =
    Object.keys(columnFilters).length === Object.keys(view.columnFilters).length &&
    Object.entries(columnFilters).every(([id, value]) => view.columnFilters[id] === value);
  const sameSort =
    sort === view.sort ||
    (sort !== null &&
      view.sort !== null &&
      sort.columnId === view.sort.columnId &&
      sort.direction === view.sort.direction);
  const sameHidden =
    hiddenColumns.length === view.hiddenColumns.length &&
    hiddenColumns.every((id, index) => view.hiddenColumns[index] === id);

  if (sameFilters && sameSort && sameHidden) return view;
  return { search: view.search, columnFilters, sort, hiddenColumns };
}

/**
 * A stable string for the debounced writer to compare against the last write.
 * `updatedAt` is excluded on purpose: only a real change should trigger a save.
 */
export function viewSignature(view: ViewState): string {
  const columnFilters: Record<ColumnId, string> = {};
  for (const columnId of Object.keys(view.columnFilters).sort()) {
    const value = view.columnFilters[columnId];
    if (value === undefined || value === '') continue;
    columnFilters[columnId] = value;
  }
  return JSON.stringify({
    search: view.search,
    columnFilters,
    sort: view.sort,
    hiddenColumns: view.hiddenColumns,
  });
}
