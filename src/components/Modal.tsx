/**
 * Minimal accessible modal: role=dialog with aria-modal, Escape to close
 * (unless busy), initial focus on the first focusable element and focus
 * restoration to the opener on close. No focus trap library — Tab wraps via
 * a keydown handler on the panel.
 */
import { useEffect, useRef, type ReactNode } from 'react';

type ModalProps = {
  label: string;
  onClose: () => void;
  closeDisabled?: boolean;
  children: ReactNode;
};

export function Modal({ label, onClose, closeDisabled = false, children }: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<Element | null>(null);

  useEffect(() => {
    openerRef.current = document.activeElement;
    const panel = panelRef.current;
    panel?.querySelector<HTMLElement>('input, select, button')?.focus();

    return () => {
      if (openerRef.current instanceof HTMLElement) openerRef.current.focus();
    };
  }, []);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape' && !closeDisabled) {
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusables = panelRef.current?.querySelectorAll<HTMLElement>(
      'input, select, button, [href]',
    );
    if (!focusables || focusables.length === 0) return;
    const first = focusables[0] as HTMLElement;
    const last = focusables[focusables.length - 1] as HTMLElement;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="modal-overlay">
      <div
        ref={panelRef}
        className="modal-panel"
        role="dialog"
        aria-modal="true"
        aria-label={label}
        onKeyDown={onKeyDown}
      >
        {children}
      </div>
    </div>
  );
}
