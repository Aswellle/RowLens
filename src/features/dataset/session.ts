/**
 * Session continuity: which dataset the user was last looking at.
 *
 * Only the dataset id is remembered, and only in localStorage — never cell
 * content, never a file name. On startup the app asks IndexedDB for that
 * dataset; if it is gone (removed, expired, or cleared) the app falls back to
 * the empty state, so a stale pointer can never resurrect deleted data.
 */
export const LAST_DATASET_KEY = 'rowlens:last-dataset';

/** Reads the remembered dataset id, tolerating storage being unavailable. */
export function readLastDatasetId(storage?: Pick<Storage, 'getItem'>): string | null {
  try {
    const store = storage ?? (typeof localStorage === 'undefined' ? null : localStorage);
    const value = store?.getItem(LAST_DATASET_KEY) ?? null;
    return value !== null && value !== '' ? value : null;
  } catch {
    // Private browsing and blocked storage can throw on access.
    return null;
  }
}

export function rememberLastDataset(datasetId: string | null): void {
  try {
    if (typeof localStorage === 'undefined') return;
    if (datasetId === null) localStorage.removeItem(LAST_DATASET_KEY);
    else localStorage.setItem(LAST_DATASET_KEY, datasetId);
  } catch {
    // Session continuity is a convenience; losing it must never fail a load.
  }
}
