/**
 * Typed application error carrying a stable code from the catalogue plus an
 * optional physical line, safe to show to users (no raw row content).
 */
import type { AppErrorCode } from './error-codes';

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly physicalLine?: number | undefined;

  constructor(code: AppErrorCode, message: string, physicalLine?: number) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.physicalLine = physicalLine;
  }
}

/** Map a DOMException/IndexedDB error onto the catalogue. */
export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : String(error);
  if (name === 'QuotaExceededError') {
    return new AppError('STORAGE_QUOTA_EXCEEDED', message);
  }
  if (name === 'NotFoundError') {
    return new AppError('DATASET_NOT_FOUND', message);
  }
  return new AppError('STORAGE_UNAVAILABLE', message);
}
