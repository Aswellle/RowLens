import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Version-change behavior: a future schema bump (or another tab's upgrade)
 * fires `versionchange` on every open connection. The connection must close
 * itself so the upgrade can proceed — holding it would leave the other side's
 * upgrade pending forever.
 *
 * After closing, this context's next open re-requests at its own compiled
 * version. When that is lower than the database (an old tab meeting a newer
 * build's schema), the open fails with a typed error instead of hanging — the
 * honest outcome, and the reason the memo must be cleared. Each test imports
 * the module fresh so its connection memo starts empty.
 */
describe('openDatabase version changes', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('indexedDB', new IDBFactory());
  });

  async function openCurrent(): Promise<typeof import('./idb')> {
    return import('./idb');
  }

  it('closes its connection so an upgrade elsewhere can proceed', async () => {
    const { openDatabase: open } = await openCurrent();
    const first = await open();
    const closeSpy = vi.spyOn(first, 'close');
    expect(first.objectStoreNames.contains('datasets')).toBe(true);

    // Another connection bumps the schema by one version.
    const bumped = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('rowlens-local', first.version + 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains('futureStore')) {
          request.result.createObjectStore('futureStore');
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    // Wait for the versionchange event to reach the first connection.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(closeSpy).toHaveBeenCalled();
    bumped.close();
  }, 20_000);

  it('reports a typed error when reopening below the database version', async () => {
    const { openDatabase: open } = await openCurrent();
    const first = await open();
    await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('rowlens-local', first.version + 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    // The memo is cleared by the versionchange close, so this open really
    // reaches IndexedDB and fails loudly instead of serving a dead handle.
    await expect(open()).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
  }, 20_000);
});
