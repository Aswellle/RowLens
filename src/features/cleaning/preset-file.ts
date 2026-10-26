/**
 * Preset files: a JSON document that carries cleaning recipes between
 * browsers (ADR-033).
 *
 * The per-browser preset list is only useful if it can be moved. A preset file
 * contains **configuration only** — step types, enabled flags and column
 * *header names*. It never contains cell values, row counts or a file name, so
 * exporting one cannot leak the data it was derived from. Header names are the
 * one thing that can be sensitive, and they leave the device only because the
 * user explicitly exported the file.
 *
 * Import is treated as untrusted input: the bytes are size-capped, parsed
 * defensively, and every preset is validated by the same `prunePreset` the
 * IndexedDB path uses. A malformed entry costs that entry, never the import.
 */
import type { CleaningPreset } from './presets';
import { MAX_PRESETS, deserializePresets } from './presets';

/** Bumped when the stored layout changes; other versions are refused. */
export const PRESET_FILE_FORMAT = 1;

/**
 * Presets are a few hundred bytes each, so a megabyte is far beyond a real
 * file. The cap keeps a mis-picked binary from being read into memory and
 * parsed as text.
 */
export const MAX_PRESET_FILE_BYTES = 1024 * 1024;

export type PresetFile = {
  format: number;
  /** ISO timestamp, informational only — never trusted for logic. */
  exportedAt: string;
  presets: CleaningPreset[];
};

export function serializePresetFile(
  presets: readonly CleaningPreset[],
  now: number = Date.now(),
): string {
  const file: PresetFile = {
    format: PRESET_FILE_FORMAT,
    exportedAt: new Date(now).toISOString(),
    presets: [...presets],
  };
  // Two-space indent: the file is meant to be readable and diffable.
  return `${JSON.stringify(file, null, 2)}\n`;
}

export type ParseResult =
  { ok: true; presets: CleaningPreset[]; dropped: number } | { ok: false; message: string };

/**
 * Parses an exported preset file. Messages are user-facing and deliberately
 * say what to do next; none of them echo file content, which could contain
 * column names the user did not expect to see in an error banner.
 */
export function parsePresetFile(text: string): ParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      ok: false,
      message: 'That file is not valid JSON. Choose a preset file exported by RowLens.',
    };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { ok: false, message: 'That file is not a RowLens preset file.' };
  }
  const record = parsed as { format?: unknown; presets?: unknown };
  if (record.format !== PRESET_FILE_FORMAT) {
    return {
      ok: false,
      message:
        'That file uses a preset format this version does not understand. Export the presets again from the RowLens version you are using.',
    };
  }
  if (!Array.isArray(record.presets)) {
    return { ok: false, message: 'That file does not contain a preset list.' };
  }
  // `deserializePresets` already validates each entry and drops unusable ones.
  const presets = deserializePresets(record);
  if (presets.length === 0) {
    return { ok: false, message: 'That file contains no usable presets.' };
  }
  return { ok: true, presets, dropped: record.presets.length - presets.length };
}

export type MergeOutcome = {
  presets: CleaningPreset[];
  added: number;
  /** Incoming presets skipped because their name is already taken. */
  skippedByName: number;
  /** Incoming presets skipped because the list is full. */
  skippedByCap: number;
  /** Incoming presets that had to be given a new id (id collision). */
  reidentified: number;
};

/**
 * Merges imported presets into the current list.
 *
 * Existing presets always win: an import never overwrites a recipe the user
 * already has, because there is no way to undo it afterwards. A name collision
 * skips the incoming preset and is reported, so the user can rename and retry.
 *
 * Ids are unique within the list because the panel keys rows by id. A crafted
 * file can carry an id that already exists under a different name; such a
 * preset keeps its name and gets a fresh id instead of being dropped.
 */
export function mergePresets(
  existing: readonly CleaningPreset[],
  incoming: readonly CleaningPreset[],
  newId: () => string,
): MergeOutcome {
  const takenNames = new Set(existing.map((preset) => preset.name));
  const takenIds = new Set(existing.map((preset) => preset.id));
  const merged = [...existing];
  let added = 0;
  let skippedByName = 0;
  let skippedByCap = 0;
  let reidentified = 0;

  for (const preset of incoming) {
    if (takenNames.has(preset.name)) {
      skippedByName += 1;
      continue;
    }
    if (merged.length >= MAX_PRESETS) {
      skippedByCap += 1;
      continue;
    }
    let id = preset.id;
    if (takenIds.has(id)) {
      id = newId();
      reidentified += 1;
    }
    takenNames.add(preset.name);
    takenIds.add(id);
    merged.push({ ...preset, id });
    added += 1;
  }

  return { presets: merged, added, skippedByName, skippedByCap, reidentified };
}

/** File name for an export; strips anything a filesystem could object to. */
export function presetFileName(now: number = Date.now()): string {
  const date = new Date(now);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `rowlens-presets-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}.json`;
}

/** One-line summary of an import for the notice bar. */
export function describeImport(outcome: MergeOutcome, dropped: number): string {
  const parts: string[] = [`Imported ${outcome.added} preset${outcome.added === 1 ? '' : 's'}`];
  if (outcome.skippedByName > 0) {
    parts.push(`${outcome.skippedByName} skipped because the name is already in use`);
  }
  if (outcome.skippedByCap > 0) {
    parts.push(`${outcome.skippedByCap} skipped because the list is full (${MAX_PRESETS} max)`);
  }
  if (dropped > 0) {
    parts.push(`${dropped} entr${dropped === 1 ? 'y' : 'ies'} in the file could not be read`);
  }
  return `${parts.join('; ')}.`;
}
