/**
 * Pure column-schema derivation for CSV/TSV headers.
 *
 * Contract source: docs/03-data-processing-contracts.md §2 and PRD FR-02:
 * - Column ids are positional (`c0`, `c1`, …) so duplicate or empty header
 *   labels can never merge or overwrite each other.
 * - Empty/missing header labels get a stable placeholder display name.
 * - No header mode generates `Column 1`, `Column 2`, … labels.
 */
import type { ColumnDefinition, ColumnId } from './types';

export function csvColumnId(sourceIndex: number): ColumnId {
  return `c${sourceIndex}`;
}

function placeholderLabel(sourceIndex: number): string {
  return `Column ${sourceIndex + 1}`;
}

/**
 * Derive the column schema from a parsed header record.
 *
 * @param headers Raw header cells as produced by the parser (null = missing
 *        cell when the record was shorter than expected). Values are used
 *        verbatim as labels — no trimming or case folding.
 * @param hasHeader When false, every label is a generated placeholder.
 */
export function deriveColumnsFromHeader(
  headers: readonly (string | null)[],
  options: { hasHeader: boolean },
): ColumnDefinition[] {
  return headers.map((cell, index) => {
    const label =
      options.hasHeader && cell !== null && cell !== '' ? cell : placeholderLabel(index);
    return {
      id: csvColumnId(index),
      label,
      sourceIndex: index,
    };
  });
}

/** Column schema for headerless files, given the parsed field count. */
export function generateColumnsForCount(count: number): ColumnDefinition[] {
  const count_ = Math.max(0, Math.trunc(count));
  return Array.from({ length: count_ }, (_, index) => ({
    id: csvColumnId(index),
    label: placeholderLabel(index),
    sourceIndex: index,
  }));
}
