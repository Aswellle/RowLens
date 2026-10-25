/**
 * Aggregates parse warnings with capped sample line numbers so the UI can
 * show counts plus a few examples without dumping raw file content
 * (data contract §2: at most PARSE_WARNING_SAMPLE_LIMIT examples).
 */
import { PARSE_WARNING_SAMPLE_LIMIT } from '../dataset/constants';
import type { ImportWarningKind, ImportWarningSummary } from '../dataset/types';

export interface WarningSink {
  add(kind: ImportWarningKind, physicalLineNumber: number): void;
}

/** A sink that can also report aggregates (used to build the final result). */
export interface WarningReporter extends WarningSink {
  readonly total: number;
  summaries(): ImportWarningSummary[];
}

export class WarningAggregator implements WarningReporter {
  private readonly counts = new Map<ImportWarningKind, number>();
  private readonly samples = new Map<ImportWarningKind, number[]>();

  add(kind: ImportWarningKind, physicalLineNumber: number): void {
    this.counts.set(kind, (this.counts.get(kind) ?? 0) + 1);
    const sample = this.samples.get(kind) ?? [];
    if (sample.length < PARSE_WARNING_SAMPLE_LIMIT) {
      sample.push(physicalLineNumber);
    }
    this.samples.set(kind, sample);
  }

  get total(): number {
    let sum = 0;
    for (const count of this.counts.values()) sum += count;
    return sum;
  }

  summaries(): ImportWarningSummary[] {
    return [...this.counts.entries()].map(([kind, count]) => ({
      kind,
      count,
      sampleLineNumbers: this.samples.get(kind) ?? [],
    }));
  }
}
