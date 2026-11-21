import React, { useEffect, createContext, useContext, useRef } from 'react';
import { X } from 'lucide-react';

const PopupVisibility = createContext(true);
let openPopups = 0;
let originalOverflow = '';

/** Keep children mounted so navigation and closing never discard an unsent draft. */
export const ActionPopup: React.FC<React.PropsWithChildren<{ open: boolean; title: string; onClose: () => void; wide?: boolean; layerClassName?: string }>> = ({ open, title, onClose, children, wide, layerClassName = '' }) => {
  const visible = useContext(PopupVisibility) && open;
  const panel = useRef<HTMLElement>(null);
  const closeAction = useRef(onClose); closeAction.current = onClose;
  useEffect(() => {
    if (!visible) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    panel.current?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
    const close = (event: KeyboardEvent) => {
      const dialogs = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]')).filter(node => node.getClientRects().length);
      if (dialogs[dialogs.length - 1] !== panel.current) return;
      if (event.key === 'Escape') { event.preventDefault(); closeAction.current(); }
      if (event.key === 'Tab') {
        const controls = Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex="0"]') ?? []).filter(node => node.getClientRects().length);
        const first = controls[0], last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    if (openPopups++ === 0) { originalOverflow = document.body.style.overflow; document.body.style.overflow = 'hidden'; }
    window.addEventListener('keydown', close);
    return () => { if (--openPopups === 0) document.body.style.overflow = originalOverflow; window.removeEventListener('keydown', close); if (previouslyFocused?.getClientRects().length) previouslyFocused.focus({ preventScroll: true }); };
  }, [visible]);
  return <PopupVisibility.Provider value={visible}><div className={`quick-action-layer ${layerClassName}`} hidden={!visible} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={panel} className={`action-popup ${wide ? 'wide' : ''}`} role={visible ? 'dialog' : undefined} aria-modal={visible ? true : undefined} aria-label={title}>
      <div className="action-popup-heading"><h2>{title}</h2><button className="icon-button" type="button" aria-label={`Close ${title}`} onClick={onClose}><X size={19}/></button></div>
      {children}
    </section>
  </div></PopupVisibility.Provider>;
};
