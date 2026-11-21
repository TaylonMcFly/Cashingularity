import React, { useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { Pencil } from 'lucide-react';
import { satsToBchString } from '@cashingularity/shared';
import { ActionPopup } from './ActionPopup.js';
import { parseStakeAmount, readStakePresets, saveStakePresets } from '../services/stakePreferences.js';

export const StakeControls:React.FC<{value:string;onChange:(value:string)=>void;available:bigint;paper:boolean;quotePayout:(sats:bigint)=>bigint|undefined}>=({value,onChange,available,paper,quotePayout})=>{
  const [presets,setPresets]=useState(readStakePresets),[draft,setDraft]=useState(presets);
  const [editing,setEditing]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const sats=parseStakeAmount(value)??0n;
  const ceiling=available>0n?available:2_000_000n;
  const sliderPosition = Number((sats > ceiling ? ceiling : sats) * 1000n / ceiling);
  const inputError=sats<546n?'Enter at least 0.00000546 BCH, with up to 8 decimal places.':undefined;
  const changeSats=(next:bigint)=>onChange(satsToBchString(next,8));
  return <div className="stake-controls">
    <div className="stake-entry-header"><label htmlFor="market-stake-amount">Stake Amount</label><div className="stake-amount-control"><input id="market-stake-amount" aria-label="Stake amount in BCH" aria-invalid={!!inputError} aria-describedby={inputError?'stake-input-error':undefined} inputMode="decimal" value={value} onChange={e=>onChange(e.target.value)} autoComplete="off"/><span>BCH</span><button type="button" disabled={available<546n} onClick={()=>changeSats(available)}>MAX</button></div></div>
    <p className="stake-available">{sats.toString()} sats · Available {satsToBchString(available,8)} BCH{!paper&&available>0n&&<span> (estimated fee reserved)</span>}</p>
    {inputError&&<p className="stake-input-error" id="stake-input-error" role="alert">{inputError}</p>}
    <div className="stake-presets">
      <div className="stake-preset-chips">
        {presets.map((preset, index) => {
          const amount = parseStakeAmount(preset)!;
          const payout = quotePayout(amount);
          return <button key={index} type="button" className={`btn stake-preset-card ${sats === amount ? 'selected' : ''}`}
            aria-label={`${preset} BCH`} aria-describedby={`stake-preset-win-${index}`} aria-pressed={sats === amount}
            onClick={event => changeSats(event.shiftKey ? sats + amount : amount)}>
            <strong>{preset} BCH</strong>
            <span id={`stake-preset-win-${index}`}>Win {payout === undefined ? '—' : `${satsToBchString(payout, 8)} BCH`}</span>
          </button>;
        })}
      </div>
      <button type="button" className="stake-edit-presets" onClick={() => { setDraft([...presets]); setError(''); setEditing(true); }}>
        <Pencil size={13} aria-hidden="true" /> Edit presets
      </button>
    </div>
    <small className="stake-preset-help">Click to set · Shift-click to add</small>
    <input aria-label="Stake amount slider" aria-valuetext={`${satsToBchString(sats, 8)} BCH`} type="range" min={0} max={1000} step={1}
      value={sliderPosition} style={{ '--stake-progress': `${sliderPosition / 10}%` } as CSSProperties}
      onChange={event => changeSats(BigInt(event.target.value) * ceiling / 1000n)} />
    {notice&&<p className="portfolio-note" role="status">{notice}</p>}
    {createPortal(<ActionPopup open={editing} title="Edit stake presets" onClose={()=>setEditing(false)}><div className="stake-presets-editor"><p>Set four quick stake amounts in BCH.</p>{draft.map((amount,index)=><label key={index}>Preset {index+1}<input className="input-field" aria-label={`Stake preset ${index+1}`} inputMode="decimal" value={amount} onChange={e=>setDraft(values=>values.map((v,i)=>i===index?e.target.value:v))}/></label>)}{error&&<p className="stake-input-error" role="alert">{error}</p>}<button type="button" className="btn btn-primary" onClick={()=>{try{const saved=saveStakePresets(draft);setPresets(draft.map(v=>satsToBchString(parseStakeAmount(v)!,8)));setNotice(saved?'Stake presets saved.':'Presets applied for this session; browser storage is unavailable.');setEditing(false);}catch(e){setError(e instanceof Error?e.message:String(e));}}}>Save presets</button></div></ActionPopup>,document.body)}
  </div>;
};
