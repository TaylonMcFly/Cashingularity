import { describe, expect, it } from 'vitest';
import {
  loadPredictionPoolScashArtifact,
  SolidHatPredictionPoolHarness,
} from './index.js';

describe('@cashingularity/contracts-solidcash - PredictionPool.scash & TypeScript simulation', () => {
  it('loads PredictionPool.scash with .scash extension and supports direct & framed composition conventions', () => {
    const directArtifact = loadPredictionPoolScashArtifact('direct');
    expect(directArtifact.deployable).toBe(false);
    expect(directArtifact.bytecodeTemplateHex).toBe('');
    expect(directArtifact.source).toContain('require(false,');
    expect(directArtifact.sourceFileName).toBe('PredictionPool.scash');
    expect(directArtifact.compositionConvention).toBe('direct');
    expect(directArtifact.source).toContain('pragma solidcash ^0.50.0;');
    expect(directArtifact.source).toContain('CRITICAL: Must drain CashTokens before selfdestruct');

    const framedArtifact = loadPredictionPoolScashArtifact('framed');
    expect(framedArtifact.compositionConvention).toBe('framed');
  });

  it('executes full parimutuel stake -> oracle resolution -> winning claim lifecycle', () => {
    const pool = new SolidHatPredictionPoolHarness({
      marketId: 101,
      oraclePubKeyHex: '02' + '11'.repeat(32),
      expiryTimestamp: 1_763_200_300n,
      refundTimestamp: 1_763_203_900n,
      feeBps: 100n,
    });

    const r1 = pool.placeStake(1, 60_000n); // YES
    const r2 = pool.placeStake(0, 40_000n); // NO
    expect(r1.receiptCommitmentHex).toHaveLength(26);
    expect(r2.receiptCommitmentHex).toHaveLength(26);
    expect(pool.state.totalPoolSats).toBe(100_000n);

    pool.resolveMarket({
      winningBucket: 1,
      resolutionPriceCents: 50_800,
      oracleSigHex: 'a'.repeat(128),
      currentTimestamp: 1_763_200_305n,
    });

    const claim = pool.claimWinningPayout({
      receiptBucketId: 1,
      stakedSats: 60_000n,
    });
    // Net pool after 1% fee = 99,000 sats
    expect(claim.payoutSats).toBe(99_000n);
  });

  it('enforces the CashTokens pre-drain safety invariant before selfdestruct', () => {
    const pool = new SolidHatPredictionPoolHarness({
      marketId: 202,
      oraclePubKeyHex: '02' + '22'.repeat(32),
      expiryTimestamp: 1_000n,
      refundTimestamp: 2_000n,
    });

    pool.placeStake(1, 10_000n);
    pool.resolveMarket({
      winningBucket: 1,
      resolutionPriceCents: 51_000,
      oracleSigHex: 'b'.repeat(128),
      currentTimestamp: 1_100n,
    });

    // Attempting selfdestruct before draining CashTokens MUST revert
    expect(() => pool.terminatePool(1_100n)).toThrow(
      /CRITICAL: Must drain CashTokens before selfdestruct/
    );

    // Drain CashTokens first, then terminatePool succeeds cleanly
    const drained = pool.drainCashTokensBeforeClose(1_100n);
    expect(drained.drainedUnits).toBe(1n);

    const terminated = pool.terminatePool(1_100n);
    expect(terminated.terminated).toBe(true);
    expect(pool.state.isTerminated).toBe(true);
  });

  it('supports trustless timeout refunds when oracle does not resolve before refundTimestamp', () => {
    const pool = new SolidHatPredictionPoolHarness({
      marketId: 303,
      oraclePubKeyHex: '02' + '33'.repeat(32),
      expiryTimestamp: 1_000n,
      refundTimestamp: 2_000n,
    });

    pool.placeStake(0, 25_000n);

    expect(() =>
      pool.reclaimExpiredStake({ stakedSats: 25_000n, currentTimestamp: 1_500n })
    ).toThrow(/Refund timeout not reached yet/);

    const refund = pool.reclaimExpiredStake({
      stakedSats: 25_000n,
      currentTimestamp: 2_001n,
    });
    expect(refund.refundedSats).toBe(25_000n);
    expect(pool.state.totalPoolSats).toBe(0n);
  });
});
