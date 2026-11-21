import { bchToSats, satsToBchString } from '@cashingularity/shared';
import type { ConnectedWalletProfile } from './walletRuntime.js';
export const STAKE_PRESETS_KEY='cashingularity.stakePresets.v1';
export const MAX_STAKE_SATS=(1n<<64n)-1n;
export const DEFAULT_STAKE_PRESETS=['0.001','0.0025','0.005','0.01'];
export function parseStakeAmount(text:string):bigint|null {
  if(!/^(?:\d+\.?\d{0,8}|\.\d{1,8})$/.test(text.trim()))return null;
  const sats=bchToSats(text.trim());
  return sats>0n&&sats<=MAX_STAKE_SATS?sats:null;
}
export function readStakePresets():string[] {
  try { const values:unknown=JSON.parse(localStorage.getItem(STAKE_PRESETS_KEY)??'null');
    if(Array.isArray(values)&&values.length===4&&values.every(v=>typeof v==='string'&&(parseStakeAmount(v)??0n)>=546n))return values.map(v=>satsToBchString(parseStakeAmount(v)!,8));
  }catch{ /* Use defaults when storage is blocked or invalid. */ }
  return [...DEFAULT_STAKE_PRESETS];
}
export function saveStakePresets(values:string[]):boolean {
  if(values.length!==4||values.some(v=>(parseStakeAmount(v)??0n)<546n))throw Error('Each preset must be at least 0.00000546 BCH, with up to 8 decimal places.');
  try{localStorage.setItem(STAKE_PRESETS_KEY,JSON.stringify(values.map(v=>satsToBchString(parseStakeAmount(v)!,8))));return true;}catch{return false;}
}
export function maximumStake(profile:ConnectedWalletProfile|undefined,paper:boolean,paperBalance:bigint):bigint {
  if(paper)return paperBalance>MAX_STAKE_SATS?MAX_STAKE_SATS:paperBalance;
  if(!profile?.isConnected||!profile.utxoSource||['sandbox','syncing','unavailable'].includes(profile.utxoSource))return 0n;
  const inputs=profile.utxos.filter(u=>!u.token);
  const sum=inputs.reduce((n,u)=>n+u.satoshis,0n);
  const fee=1000n+BigInt(inputs.length)*148n;
  return sum>fee?sum-fee:0n;
}
