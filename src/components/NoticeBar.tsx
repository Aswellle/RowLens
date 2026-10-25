/**
 * Dismissible inline notice. role="status" so screen readers announce it once,
 * politely — used for honest capability messages, warnings and errors.
 */
import type { ReactNode } from 'react';

export type NoticeVariant = 'info' | 'warning' | 'error';

type NoticeBarProps = {
  variant: NoticeVariant;
  children: ReactNode;
  onDismiss: () => void;
};

export function NoticeBar({ variant, children, onDismiss }: NoticeBarProps) {
  return (
    <div className={`notice-bar notice-bar--${variant}`} role="status">
      <span>{children}</span>
      <button
        type="button"
        className="btn btn--ghost notice-bar__dismiss"
        onClick={onDismiss}
        aria-label="Dismiss notice"
      >
        ✕
      </button>
    </div>
  );
}
