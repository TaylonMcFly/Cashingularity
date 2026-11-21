import React, { useEffect, useId, useRef, useState } from 'react';
import { Check, MoreHorizontal } from 'lucide-react';
import type { OutcomePanelLayout } from '../services/appearance.js';
export type ContractEngine = 'CASHSCRIPT_WIZARD' | 'XO_INVITATION' | 'SOLIDCASH_SCASH';
export const OutcomePanelMenu: React.FC<{ layout:OutcomePanelLayout; onLayout:(layout:OutcomePanelLayout)=>void; engine:ContractEngine; onEngine:(engine:ContractEngine)=>void; onGenerateXo:()=>void; xoJson:string }> = ({layout,onLayout,engine,onEngine,onGenerateXo,xoJson}) => {
  const [open,setOpen]=useState(false), id=useId();
  const root=useRef<HTMLDivElement>(null), trigger=useRef<HTMLButtonElement>(null);
  useEffect(()=>{if(!open)return;const close=(event:PointerEvent)=>{if(!root.current?.contains(event.target as Node))setOpen(false);};document.addEventListener('pointerdown',close);return()=>document.removeEventListener('pointerdown',close);},[open]);
  return <div className="outcome-options" ref={root} onKeyDown={event=>{if(event.key==='Escape'&&open){event.preventDefault();event.stopPropagation();setOpen(false);trigger.current?.focus();}}}>
    <button ref={trigger} type="button" className="icon-button" aria-label="More options" title="Position layout and contract engine" aria-expanded={open} aria-haspopup="dialog" aria-controls={id} onClick={()=>setOpen(value=>!value)}><MoreHorizontal size={20}/></button>
    {open&&<section id={id} className="outcome-options-popover" role="dialog" aria-label="Outcome position options"><span className="eyebrow">POSITION LAYOUT</span><div role="group" aria-label="Position layout">
      {([['right','Dock Right (Sidebar)'],['below','Below Charts (Full Width)'],['left','Dock Left']] as const).map(([value,label])=><button key={value} type="button" className="layout-option" aria-pressed={layout===value} onClick={()=>{onLayout(value);setOpen(false);trigger.current?.focus({preventScroll:true});}}><span>{label}</span>{layout===value&&<Check size={15}/>}</button>)}
    </div><p className="portfolio-note">On smaller screens, the ticket stays below the charts.</p><details className="developer-contract-inspector"><summary>Developer Contract Inspector</summary><label className="engine-menu-field">Contract Engine<select aria-label="Contract Engine" className="select-field" value={engine} onChange={event=>onEngine(event.target.value as ContractEngine)}><option value="CASHSCRIPT_WIZARD">CashScript</option><option value="XO_INVITATION">XO Stack</option><option value="SOLIDCASH_SCASH">SolidCash</option></select></label>
    {engine==='XO_INVITATION'&&<><button type="button" className="btn" onClick={onGenerateXo}>Generate XO JSON</button>{xoJson&&<pre className="engine-json">{xoJson}</pre>}</>}
    </details></section>}
  </div>;
};
