import React, { useEffect, useId, useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  label: string;
  triggerLabel?: string;
  triggerDescription?: string;
  trigger: ReactNode;
  triggerClass: string;
  triggerRef?: RefObject<HTMLButtonElement>;
  focusKey?: string;
  children: ReactNode;
}

export function HeaderPopover({ open, onOpenChange, label, triggerLabel = label, triggerDescription, trigger, triggerClass, triggerRef, focusKey, children }: Props) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const localTrigger = useRef<HTMLButtonElement>(null);
  const toggle = triggerRef ?? localTrigger;
  const change = useRef(onOpenChange);
  change.current = onOpenChange;
  const controls = () => Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href]') ?? []);

  useLayoutEffect(() => {
    const container = panel.current;
    if (!open || !container) return;
    container.scrollTop = 0;
    const target = container.querySelector<HTMLElement>('[data-menu-focus]') ?? controls()[0] ?? container;
    target.focus({ preventScroll: true });
    const overflow = target.getBoundingClientRect().bottom - container.getBoundingClientRect().bottom;
    if (overflow > 0) container.scrollTop += overflow + 6;
  }, [open, focusKey]);

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) change.current(false);
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [open]);

  return <div className="header-popover-anchor" ref={root} onBlur={event => {
    if (open && event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) onOpenChange(false);
  }} onKeyDown={event => {
    if (!open) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onOpenChange(false);
      toggle.current?.focus();
      return;
    }
    const items = controls();
    if (!items.length || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLElement);
    const step = event.key === 'ArrowUp' ? -1 : 1;
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 :
      current < 0 ? (step > 0 ? 0 : items.length - 1) : (current + step + items.length) % items.length;
    items[next]?.focus();
  }}>
    <button type="button" className={triggerClass} ref={toggle} aria-label={triggerLabel} aria-description={triggerDescription} aria-haspopup="dialog"
      aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => onOpenChange(!open)}>
      {trigger}
    </button>
    {open && <div className="header-popover" role="dialog" aria-label={label} tabIndex={-1} ref={panel} id={id}>
      {children}
    </div>}
  </div>;
}
