/**
 * Small popover container: closes on Escape (returning focus to the trigger)
 * and on outside pointer-down. Not a modal — background stays interactive.
 */
import { useEffect, useRef, type ReactNode } from 'react';

type PopoverProps = {
  id: string;
  label: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  triggerLabel: string;
  children: ReactNode;
};

export function Popover({ id, label, open, onOpenChange, triggerLabel, children }: PopoverProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        containerRef.current &&
        !containerRef.current.contains(event.target)
      ) {
        onOpenChange(false);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open, onOpenChange]);

  useEffect(() => {
    if (open) {
      panelRef.current?.querySelector<HTMLElement>('input, button')?.focus();
    }
  }, [open]);

  return (
    <div className="toolbar__pop" ref={containerRef}>
      <button
        ref={triggerRef}
        type="button"
        className="btn"
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => onOpenChange(!open)}
      >
        {triggerLabel}
      </button>
      <div
        id={id}
        ref={panelRef}
        className="toolbar__panel"
        data-open={open}
        role="group"
        aria-label={label}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            onOpenChange(false);
            triggerRef.current?.focus();
          }
        }}
      >
        {children}
      </div>
    </div>
  );
}
