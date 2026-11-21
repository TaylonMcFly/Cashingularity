import { describe, expect, it } from 'vitest';
import type { ConfigurableMarket } from '@cashingularity/shared';
import { observeConfirmations, paperNoticeScope, paperResolutionNotices, visibleActivity, walletNoticeScope,
  type ActivityNotice } from './activityNotices.js';
import type { PaperPosition } from './paperTrading.js';
import type { WalletTransaction } from './transactionHistory.js';

const expiry = 1_800_000_000_000;
const afterExpiry = expiry + 100;
const round = {
  marketId: 203, expiryTimestampMs: expiry, epochSeriesId: 'bchusd-5m',
  status: 'RESOLVED', resolutionPriceCents: 20_100, resolvedOutcome: 1, assetPair: 'BCH/USD', timeframe: '5m',
  buckets: [{ bucketId: 0, label: 'BELOW' }, { bucketId: 1, label: 'ABOVE' }],
} as ConfigurableMarket;
const participation = {
  id: 'position', marketId: 1, expiresAtMs: expiry, epochSeriesId: 'bchusd-5m', status: 'CASHED_OUT',
} as PaperPosition;

describe('profile-specific activity notices', () => {
  it('publishes one resolution for the exact entered round, including its archived id', () => {
    const markets = [
      round,
      { ...round, marketId: 204 },
      { ...round, epochSeriesId: 'bchusd-1h' },
      { ...round, expiryTimestampMs: expiry - 300_000 },
    ];
    expect(paperResolutionNotices('watcher', [], markets, afterExpiry)).toEqual([]);
    const resolved = paperResolutionNotices('trader', [participation, { ...participation, id: 'second' }], markets, afterExpiry);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({ scope: paperNoticeScope('trader'), kind: 'resolution', title: 'Market resolved' });
    expect(resolved[0].detail).toContain('$201.00 close');
  });

  it('waits for an expired round with a price and known outcome', () => {
    expect(paperResolutionNotices('trader', [participation], [round], expiry - 1)).toEqual([]);
    for (const record of [
      { ...round, status: 'OPEN' as const },
      { ...round, resolvedOutcome: 2 },
      { ...round, resolutionPriceCents: undefined },
      { ...round, resolutionPriceCents: Infinity },
    ]) {
      expect(paperResolutionNotices('trader', [participation], [record], afterExpiry)).toEqual([]);
    }
  });

  it('keeps signing, transfer, dApp and resolution records inside their profile, network and mode', () => {
    const mainnet = walletNoticeScope('trader', 'mainnet');
    const paper = paperNoticeScope('trader');
    const notices: ActivityNotice[] = [
      { id: 'sign', scope: mainnet, kind: 'signing', title: 'Signature requested', timeMs: 1 },
      { id: 'tx', scope: mainnet, kind: 'transfer', title: 'Transaction broadcast', timeMs: 2 },
      { id: 'dapp', scope: mainnet, kind: 'connection', title: 'Application connected', timeMs: 3 },
      ...paperResolutionNotices('trader', [participation], [round], afterExpiry),
    ];
    expect(visibleActivity(notices, mainnet).map(notice => notice.id)).toEqual(['sign', 'tx', 'dapp']);
    expect(visibleActivity(notices, paper).map(notice => notice.kind)).toEqual(['resolution']);
    expect(visibleActivity(notices, walletNoticeScope('trader', 'chipnet'))).toEqual([]);
    expect(visibleActivity(notices, walletNoticeScope('watcher', 'mainnet'))).toEqual([]);
    expect(visibleActivity(notices, paperNoticeScope('watcher'))).toEqual([]);
    expect(visibleActivity(notices)).toEqual([]);
  });
});

describe('transaction confirmations', () => {
  const observed: WalletTransaction = {
    txid: 'ab'.repeat(32), network: 'mainnet', address: 'shared-address', label: 'On-chain transaction',
    confirmed: true, timestamp: expiry, amountSats: null, totalSats: null, feeSats: null, priceUsd: null,
  };
  const receipt = { ...observed, initiatorProfileId: 'signer', confirmed: false };
  const signer = walletNoticeScope('signer', 'mainnet');
  const watch = walletNoticeScope('watch', 'mainnet');

  it('assigns a sent transaction to its initiating profile even when another profile watches the same address', () => {
    expect(observeConfirmations('watch', watch, new Set([observed.txid]), [observed], [receipt], expiry).notices).toEqual([]);
    const result = observeConfirmations('signer', signer, undefined, [observed], [receipt], expiry);
    expect(result.notices).toEqual([expect.objectContaining({ scope: signer, kind: 'confirmation' })]);
    expect(result.pending.size).toBe(0);
    expect(observeConfirmations('signer', signer, result.pending, [observed], [{ ...receipt, confirmed: true }], expiry).notices).toEqual([]);
  });

  it('reports an external confirmation only if this profile previously observed it pending', () => {
    const pending = observeConfirmations('watch', watch, undefined, [{ ...observed, confirmed: false }], [], expiry);
    expect(pending.notices).toEqual([]);
    expect(observeConfirmations('signer', signer, undefined, [observed], [], expiry).notices).toEqual([]);
    expect(observeConfirmations('watch', watch, pending.pending, [observed, observed], [], expiry).notices).toHaveLength(1);
    expect(observeConfirmations('watch', watch, undefined, [{ ...observed, confirmed: false }, observed], [], expiry).notices).toEqual([]);
  });
});
