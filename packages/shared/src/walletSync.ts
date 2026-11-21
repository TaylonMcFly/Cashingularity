import type { BchNetwork, CashTokenData, WalletUtxo } from './types.js';

export const WALLET_GAP_LIMIT = 20;
export const WALLET_SYNC_BATCH_SIZE = 40;
export const WALLET_SYNC_ADDRESS_LIMIT = 4_000;

export interface WalletSyncRequest {
  id: number;
  network: BchNetwork;
  addresses: string[];
  fresh?: boolean;
  tipUpdates?: boolean;
  /** Verify the tip and current status of every script already discovered on this watch. */
  verify?: boolean;
}

export interface WalletSyncTransaction {
  txid: string;
  height: number;
  timestampMs?: number;
  feeSats?: string;
}

export type WalletSyncUtxo = Pick<WalletUtxo, 'txid' | 'vout'> & {
  satoshis: string;
  height: number;
  token?: Omit<CashTokenData, 'amount'> & { amount: string };
};

export interface WalletSyncAddress {
  address: string;
  history: WalletSyncTransaction[];
  utxos: WalletSyncUtxo[];
}

export type WalletSyncMessage =
  | { type: 'snapshot'; id: number; tip: string; height: number; source: string; addresses: WalletSyncAddress[]; verified?: true }
  | { type: 'retry'; id: number }
  | { type: 'changed' }
  | { type: 'tip'; tip: string; height: number; source: string }
  | { type: 'heartbeat' };
