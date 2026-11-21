import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_STAKE_PRESETS, MAX_STAKE_SATS, STAKE_PRESETS_KEY, maximumStake, parseStakeAmount, readStakePresets, saveStakePresets } from './stakePreferences.js';
import type { ConnectedWalletProfile } from './walletRuntime.js';
afterEach(()=>vi.unstubAllGlobals());
describe('exact stake amounts and preferences',()=>{
  it('accepts satoshi precision and rejects silent rounding, exponents and uint64 overflow',()=>{
    expect(parseStakeAmount('0.00000547')).toBe(547n);expect(parseStakeAmount('.00250001')).toBe(250001n);
    for(const value of ['','0','-1','1e-3','0.000000001','NaN','184467440737.09551616'])expect(parseStakeAmount(value)).toBeNull();
    expect(parseStakeAmount('184467440737.09551615')).toBe(MAX_STAKE_SATS);
  });
  it('stores exactly four validated amounts and restores canonical decimal values',()=>{
    const map=new Map<string,string>();vi.stubGlobal('localStorage',{getItem:(k:string)=>map.get(k)??null,setItem:(k:string,v:string)=>map.set(k,v)});
    expect(readStakePresets()).toEqual(DEFAULT_STAKE_PRESETS);
    expect(saveStakePresets(['.1','0.02000000','0.00000546','1'])).toBe(true);expect(readStakePresets()).toEqual(['0.1','0.02','0.00000546','1']);
    expect(()=>saveStakePresets(['0','1','2','3'])).toThrow();expect(()=>saveStakePresets(['1'])).toThrow();
    map.set(STAKE_PRESETS_KEY,'["invalid"]');expect(readStakePresets()).toEqual(DEFAULT_STAKE_PRESETS);
  });
  it('keeps preferences usable without storage and protects token UTXOs and fees from MAX',()=>{
    vi.stubGlobal('localStorage',{getItem:()=>{throw Error('blocked');},setItem:()=>{throw Error('blocked');}});
    expect(readStakePresets()).toEqual(DEFAULT_STAKE_PRESETS);expect(saveStakePresets(DEFAULT_STAKE_PRESETS)).toBe(false);
    const profile={isConnected:true,utxoSource:'live',utxos:[{satoshis:100000n},{satoshis:200000n,token:{}}]} as ConnectedWalletProfile;
    expect(maximumStake(profile,false,0n)).toBe(98852n);expect(maximumStake({...profile,utxoSource:'syncing'},false,0n)).toBe(0n);
    expect(maximumStake(undefined,true,123456789n)).toBe(123456789n);expect(maximumStake(undefined,true,MAX_STAKE_SATS+1n)).toBe(MAX_STAKE_SATS);
  });
});
