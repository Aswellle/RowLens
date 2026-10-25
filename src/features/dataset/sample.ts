/**
 * Deterministic synthetic sample dataset (fully generated from a seeded LCG —
 * no personal or real-world data). `createSampleDataset(rows)` builds a
 * self-contained sample of any size; the 5,000-row default drives the app,
 * while tests use smaller sizes for speed. The service exposes windowed
 * reads rather than handing the whole table to React state, mirroring the
 * bounded data flow of real datasets.
 */
import type { ColumnDefinition, DatasetMetadata, RowIndex } from './types';

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
  '  padded note  ',
  '',
] as const;

export const DEFAULT_SAMPLE_ROWS = 5000;

export type SampleDataset = {
  metadata: DatasetMetadata;
  columnIds: string[];
  labels: Record<string, string>;
  getRowCount(): number;
  getRows(offset: number, count: number): string[][];
  rowValues(rowIndex: RowIndex): string[];
  valueAt(rowIndex: RowIndex, columnIndex: number): string | null;
};

export function createSampleDataset(rowCount: number = DEFAULT_SAMPLE_ROWS): SampleDataset {
  const count = Math.max(0, Math.trunc(rowCount));
  const random = lcg(20261025 + count);

  function pick<T>(items: readonly T[]): T {
    return items[Math.floor(random() * items.length)] as T;
  }

  /** Ticket ids keep leading zeros on purpose: values stay strings, never numerics. */
  function ticketId(rowIndex: number): string {
    return `T-${String(rowIndex + 1).padStart(5, '0')}`;
  }

  function openedDate(rowIndex: number): string {
    const day = (rowIndex % 28) + 1;
    const hour = rowIndex % 24;
    return `2026-10-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00Z`;
  }

  const rows: string[][] = Array.from({ length: count }, (_, rowIndex) => [
    ticketId(rowIndex),
    pick(STATUSES),
    // Duplicate priorities across many rows exercise stable sort visibly.
    rowIndex % 3 === 0 ? 'P2' : pick(PRIORITIES),
    pick(CHANNELS),
    pick(REGIONS),
    openedDate(rowIndex),
    String(Math.floor(random() * 72)),
    pick(NOTES),
  ]);

  return {
    metadata: {
      id: 'sample-tickets',
      format: 'csv',
      fileName: 'sample-tickets.csv (synthetic)',
      byteSize: 0,
      status: 'ready',
      createdAt: 0,
      lastTouchedAt: 0,
      rowCount: count,
      columns: COLUMNS,
      parseErrorCount: 0,
      importWarnings: [],
      schemaVersion: 1,
    },
    columnIds: COLUMNS.map((column) => column.id),
    labels: Object.fromEntries(COLUMNS.map((column) => [column.id, column.label])),
    getRowCount: () => count,
    getRows: (offset, size) => {
      const start = Math.max(0, Math.trunc(offset));
      const end = Math.min(count, start + Math.trunc(size));
      return rows.slice(start, end);
    },
    rowValues: (rowIndex) => {
      const row = rows[rowIndex];
      if (row === undefined) throw new Error(`sample row ${rowIndex} out of range`);
      return row;
    },
    valueAt: (rowIndex, columnIndex) => rows[rowIndex]?.[columnIndex] ?? null,
  };
}

/** Small deterministic PRNG so a sample is identical on every load. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}
