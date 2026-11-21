import React from 'react';
import { BadgeCheck, Coins, Layers } from 'lucide-react';
import { satsToBchString } from '@cashingularity/shared';
import type { ConnectedWalletProfile } from '../services/walletRuntime.js';

const PUSD_CATEGORY = 'e9c70516ef03826067f128228d76f80f2704b311969dfca11bb4e461b5cf8757';

export function WalletPortfolio({ profile, balanceSats, balanceAvailable, paper, price, priceSource }: {
  profile: ConnectedWalletProfile;
  balanceSats: bigint;
  balanceAvailable: boolean;
  paper: boolean;
  price: number;
  priceSource: 'live' | 'fallback';
}) {
  const tokensKnown = !paper && profile.isConnected && balanceAvailable;
  const pusd = tokensKnown && profile.network === 'mainnet' ? profile.utxos.reduce((sum, utxo) =>
    sum + (utxo.token?.categoryId.toLowerCase() === PUSD_CATEGORY ? utxo.token.amount : 0n), 0n) : null;
  const nftCount = tokensKnown ? profile.utxos.filter(utxo => !!utxo.token?.nft).length : null;
  return <section className="wallet-assets-panel" aria-label="Portfolio">
    <div className="wallet-assets-heading">
      <h2>Portfolio</h2>
      <span>{paper ? 'Paper account' : profile.isConnected ? profile.network === 'chipnet' ? 'Chipnet' : 'Mainnet' : 'No wallet selected'}</span>
    </div>
    <div className="wallet-asset">
      <span className="wallet-token-icon bch-token" aria-hidden="true">₿</span>
      <span className="wallet-token-name"><strong>Bitcoin Cash <BadgeCheck size={14} aria-label="Verified" /></strong><small>{paper ? 'Virtual BCH' : 'Native asset · BCH'}</small></span>
      <span className="wallet-token-balance">
        <strong>{balanceAvailable ? `${satsToBchString(balanceSats, 8)} BCH` : '—'}</strong>
        {balanceAvailable && priceSource === 'live' && <small>${((Number(balanceSats) / 1e8) * price).toFixed(2)}</small>}
      </span>
    </div>
    {!paper && <>
      <div className="wallet-asset">
        <span className="wallet-token-icon pusd-token"><Coins size={20} aria-hidden="true" /></span>
        <span className="wallet-token-name"><strong>Parity USD <BadgeCheck size={14} aria-label="Registry-listed" /></strong><small>PUSD · CashTokens</small></span>
        <span className="wallet-token-balance">
          <strong>{pusd === null ? '—' : `${pusd / 100n}.${(pusd % 100n).toString().padStart(2, '0')} PUSD`}</strong>
          {profile.isConnected && profile.network === 'chipnet' && <small>Mainnet token</small>}
        </span>
      </div>
      <div className="wallet-asset">
        <span className="wallet-token-icon nft-token"><Layers size={20} aria-hidden="true" /></span>
        <span className="wallet-token-name"><strong>CashTokens NFTs</strong><small>Collectibles &amp; receipts</small></span>
        <span className="wallet-token-balance"><strong>{nftCount ?? '—'}</strong></span>
      </div>
    </>}
  </section>;
}
