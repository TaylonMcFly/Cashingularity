import React, { useContext, useEffect, useRef, useState } from 'react';
import { ThemeContext } from '../services/ThemeContext.js';

/** The provider runs on a separate, verification-only origin, never the wallet DOM. */
export const TurnstileChallenge:React.FC<{action:'register'|'login';onToken:(token:string)=>void;resetKey?:number}>=({action,onToken,resetKey=0})=>{
  const theme=useContext(ThemeContext),host=useRef<HTMLDivElement>(null),callback=useRef(onToken);callback.current=onToken;
  const [error,setError]=useState(''),[retry,setRetry]=useState(0);
  const local=['localhost','127.0.0.1','[::1]','::1'].includes(location.hostname);
  const sitekey=import.meta.env.VITE_TURNSTILE_SITE_KEY||(local?'1x00000000000000000000AA':'');
  let frameOrigin='';
  try {
    const configured=import.meta.env.VITE_TURNSTILE_FRAME_ORIGIN||(local?`http://${location.hostname==='127.0.0.1'?'localhost':'127.0.0.1'}:3001`:'');
    const url=new URL(configured);
    if(url.hostname!==location.hostname && (url.protocol==='https:'||(local&&url.protocol==='http:')))frameOrigin=url.origin;
  } catch { /* Missing or unsafe configuration fails closed. */ }
  useEffect(()=>{
    callback.current('');setError('');
    if(!sitekey||!frameOrigin){setError('Bot verification needs a site key and a separate verification origin.');return;}
    if(!host.current)return;
    const nonce=Array.from(crypto.getRandomValues(new Uint8Array(16)),b=>b.toString(16).padStart(2,'0')).join('');
    const frame=document.createElement('iframe');frame.title='Isolated bot verification';frame.className='bot-verification-frame';frame.sandbox.add('allow-scripts','allow-same-origin');frame.referrerPolicy='no-referrer';
    frame.src=`${frameOrigin}/verification-frame.html?nonce=${nonce}&parentOrigin=${encodeURIComponent(location.origin)}`;
    let active=true;
    const timer=setTimeout(()=>{if(active){callback.current('');setError('Verification could not load. Please retry.');}},20000);
    const receive=(event:MessageEvent)=>{
      if(!active||event.source!==frame.contentWindow||event.origin!==frameOrigin)return;
      const data=event.data;
      if(data?.type!=='CASHINGULARITY_BOT_VERIFICATION'||data.nonce!==nonce)return;
      if(data.state==='ready')frame.contentWindow?.postMessage({type:'CASHINGULARITY_BOT_CONFIG',nonce,sitekey,action,theme},frameOrigin);
      else if(data.state==='verified'&&typeof data.token==='string'&&data.token.length>0&&data.token.length<=2048){clearTimeout(timer);setError('');callback.current(data.token);}
      else if(data.state==='expired'||data.state==='error'){clearTimeout(timer);callback.current('');setError(data.state==='expired'?'Verification expired. Please retry.':'Verification failed. Please retry.');}
    };
    window.addEventListener('message',receive);host.current.appendChild(frame);
    return()=>{active=false;clearTimeout(timer);window.removeEventListener('message',receive);frame.remove();callback.current('');};
  },[action,sitekey,frameOrigin,theme,resetKey,retry]);
  return <div className="turnstile-verification"><div ref={host}/>{error&&<><p className="turnstile-message" role="status">{error}</p><button className="btn" type="button" onClick={()=>setRetry(n=>n+1)}>Retry verification</button></>}</div>;
};
