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

    // Make the background genuinely unreachable, not just visually covered:
    // aria-modal alone does not stop keyboard focus from wandering into
    // content behind the overlay. `inert` is the platform mechanism; the
    // overlay lives inside the app tree, so its own subtree is exempt.
    const background: { node: HTMLElement; previous: string | null }[] = [];
    for (const sibling of Array.from(document.body.children)) {
      if (sibling.contains(panel)) continue;
      if (sibling instanceof HTMLElement) {
        background.push({ node: sibling, previous: sibling.getAttribute('inert') });
        sibling.setAttribute('inert', '');
      }
    }

    return () => {
      for (const entry of background) {
        if (entry.previous === null) entry.node.removeAttribute('inert');
        else entry.node.setAttribute('inert', entry.previous);
      }
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
