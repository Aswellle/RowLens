/**
 * Deterministic synthetic sample dataset (Phase 1).
 *
 * Fully generated from a seeded LCG — no personal or real-world data. The
 * service exposes windowed reads (getRows) rather than handing the whole table
 * to React state, mirroring the bounded data flow the real dataset repository
 * will use from Phase 2 onwards.
 */
import type { ColumnDefinition, DatasetMetadata, RowIndex } from './types';

const ROW_COUNT = 5000;

const COLUMNS: ColumnDefinition[] = [
  { id: 'c0', label: 'Ticket', sourceIndex: 0 },
  { id: 'c1', label: 'Status', sourceIndex: 1 },
  { id: 'c2', label: 'Priority', sourceIndex: 2 },
  { id: 'c3', label: 'Channel', sourceIndex: 3 },
  { id: 'c4', label: 'Region', sourceIndex: 4 },
  { id: 'c5', label: 'Opened', sourceIndex: 5 },
  { id: 'c6', label: 'First response (h)', sourceIndex: 6 },
  { id: 'c7', label: 'Note', sourceIndex: 7 },
];

const COLUMN_IDS = COLUMNS.map((c) => c.id) as [string, ...string[]];

const STATUSES = ['open', 'pending', 'closed'] as const;
const PRIORITIES = ['P1', 'P2', 'P3'] as const;
const CHANNELS = ['email', 'chat', 'web form'] as const;
const REGIONS = ['emea', 'apac', 'amer', 'latam'] as const;
const NOTES = [
  'Customer asked about invoice re-issue.',
  'Escalated: SLA at risk.',
  'Contains "quoted words" and, commas',
  'Multibyte: 追跡番号 12345 / благодарим / 🚚',
  'Long note: initial triage done, waiting on the second-line team for the translation of the attached export before we can proceed further.',
  '',
] as const;

/** Small deterministic PRNG so the sample is identical on every load and in tests. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

const random = lcg(20261025);

function pick<T>(items: readonly T[]): T {
  return items[Math.floor(random() * items.length)] as T;
}

/** Ticket ids keep leading zeros on purpose: values stay strings, never numerics. */
function ticketId(rowIndex: number): string {
  return `T-${String(rowIndex + 1).padStart(5, '0')}`;
}

function openedDate(rowIndex: number): string {
  // Deterministic walk over October 2026 dates; string, never a Date object.
  const day = (rowIndex % 28) + 1;
  const hour = rowIndex % 24;
  return `2026-10-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00Z`;
}

function buildRow(rowIndex: number): string[] {
  return [
    ticketId(rowIndex),
    pick(STATUSES),
    // Duplicate priorities across many rows exercise stable sort visibly.
    rowIndex % 3 === 0 ? 'P2' : pick(PRIORITIES),
    pick(CHANNELS),
    pick(REGIONS),
    openedDate(rowIndex),
    String(Math.floor(random() * 72)),
    pick(NOTES),
  ];
}

const ROWS: string[][] = Array.from({ length: ROW_COUNT }, (_, i) => buildRow(i));

export const SAMPLE_METADATA: DatasetMetadata = {
  id: 'sample-tickets',
  format: 'csv',
  fileName: 'sample-tickets.csv (synthetic)',
  byteSize: 0,
  status: 'ready',
  createdAt: 0,
  lastTouchedAt: 0,
  rowCount: ROW_COUNT,
  columns: COLUMNS,
  parseErrorCount: 0,
  importWarnings: [],
  schemaVersion: 1,
};

/** Column ids in display order. */
export function sampleColumnIds(): string[] {
  return [...COLUMN_IDS];
}

/** Column labels keyed by column id. */
export function sampleLabels(): Record<string, string> {
  return Object.fromEntries(COLUMNS.map((c) => [c.id, c.label]));
}

/** Bounded window read: only the requested slice is copied, never the table. */
export function getRows(offset: number, count: number): string[][] {
  const start = Math.max(0, Math.trunc(offset));
  const end = Math.min(ROW_COUNT, start + Math.trunc(count));
  return ROWS.slice(start, end);
}

export function getRowCount(): number {
  return ROW_COUNT;
}

/** All row indices (used to derive filtered/sorted index lists in the demo). */
export function allIndices(): RowIndex[] {
  return Array.from({ length: ROW_COUNT }, (_, i) => i);
}

export function valueAt(rowIndex: RowIndex, columnIndex: number): string | null {
  const row = ROWS[rowIndex];
  if (row === undefined) return null;
  return row[columnIndex] ?? null;
}

export function rowValues(rowIndex: RowIndex): string[] {
  const row = ROWS[rowIndex];
  if (row === undefined) {
    throw new Error(`sample row ${rowIndex} out of range`);
  }
  return row;
}
