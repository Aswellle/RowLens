/**
 * One debounced configuration writer for the three per-dataset records (cell
 * edits, cleaning pipeline, query view). The three call sites are the same
 * loop — compare a payload signature, debounce, write or delete the record,
 * reset the marker on failure so a later change retries — and hand-rolled
 * copies of it had already drifted once (the restore path seeded a marker in a
 * different format than the writer compared, so every reload with a saved
 * pipeline scheduled a redundant write). One primitive keeps the fourth
 * configuration record from inheriting that.
 *
 * Ordering guarantee: the write callback receives the signature it was
 * scheduled for and skips itself when the current signature has moved on.
 * Without this, an IndexedDB transaction for an older payload can land *after*
 * the newer one's — a Reset's delete racing a pre-Reset write could lose, and
 * the "reset" record would resurrect on the next mount. The newest scheduled
 * timer is always the last one allowed to write.
 */
import { useCallback, useEffect, useRef } from 'react';
import type { DatasetRepository } from '../features/dataset/repository';

export type DebouncedPersist = {
  /**
   * Seeds the writer with a signature that must not be written again — the
   * restore path uses this so reloading a saved configuration does not
   * immediately rewrite it with a fresh `updatedAt`.
   */
  markPersisted: (signature: string) => void;
};

export function useDebouncedPersist(
  /**
   * The payload's current signature. An empty string disables the writer (the
   * app is not in a state that owns this record).
   */
  signature: string,
  /** Writes or deletes the record; must tolerate being called twice. */
  write: (repository: DatasetRepository) => Promise<void>,
  ensureRepository: () => Promise<DatasetRepository>,
  delayMs: number,
): DebouncedPersist {
  const lastPersistedRef = useRef<string | null>(null);
  // The signature the pending timer was scheduled for; a later scheduling
  // invalidates an in-flight one.
  const scheduledSignatureRef = useRef<string | null>(null);
  // The writer reads the latest payload through a ref: keying the effect on
  // its identity would restart the debounce on every render.
  const writeRef = useRef(write);
  writeRef.current = write;

  const markPersisted = useCallback((seed: string) => {
    lastPersistedRef.current = seed;
  }, []);

  useEffect(() => {
    if (signature === '') return;
    if (lastPersistedRef.current === signature) return;
    const timer = window.setTimeout(() => {
      // Superseded: a newer signature was scheduled after this timer, so let
      // that one (alone) decide the stored state.
      if (scheduledSignatureRef.current !== signature) return;
      scheduledSignatureRef.current = null;
      lastPersistedRef.current = signature;
      void (async () => {
        try {
          const repository = await ensureRepository();
          await writeRef.current(repository);
        } catch {
          // Storage full or blocked: the session keeps its state in memory.
          // Resetting the marker makes the next signature change retry.
          lastPersistedRef.current = null;
        }
      })();
    }, delayMs);
    scheduledSignatureRef.current = signature;
    return () => window.clearTimeout(timer);
  }, [signature, ensureRepository, delayMs]);

  return { markPersisted };
}
