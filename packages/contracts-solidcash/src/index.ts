/**
 * @cashingularity/contracts-solidcash
 * SolidCash (.scash) Artifact Loader, Direct/Framed Composition Config & SolidHat Stateful Runtime
 * BCH BLAZE 2026 - Track C
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCASH_CONTRACT_PATH = resolve(__dirname, '../contracts/PredictionPool.scash');

export type SolidCashCompositionMode = 'direct' | 'framed';

export interface SolidCashCompiledArtifact {
  deployable: false;
  contractName: string;
  sourceFileName: string;
  compiler: string;
  compositionConvention: SolidCashCompositionMode;
  targetVm: 'BCH_2026_05';
  source: string;
  abi: Array<{
    name: string;
    type: 'constructor' | 'function' | 'event';
    stateMutability?: 'nonpayable' | 'payable' | 'view';
    inputs: Array<{ name: string; type: string }>;
  }>;
  bytecodeTemplateHex: string;
}

export function loadPredictionPoolScashArtifact(
  compositionConvention: SolidCashCompositionMode = 'direct'
): SolidCashCompiledArtifact {
  const source = readFileSync(SCASH_CONTRACT_PATH, 'utf-8');
  return {
    deployable: false,
    contractName: 'PredictionPool',
    sourceFileName: 'PredictionPool.scash',
    compiler: '@solidcash/solidc@0.50.0',
    compositionConvention,
    targetVm: 'BCH_2026_05',
    source,
    abi: [
      {
        name: 'constructor',
        type: 'constructor',
        stateMutability: 'payable',
        inputs: [
          { name: '_marketId', type: 'uint32' },
          { name: '_oraclePubKey', type: 'bytes33' },
          { name: '_expiryTimestamp', type: 'uint64' },
          { name: '_refundTimestamp', type: 'uint64' },
          { name: '_feeBps', type: 'uint64' },
        ],
      },
      {
        name: 'placeStake',
        type: 'function',
        stateMutability: 'payable',
        inputs: [
          { name: 'bucketId', type: 'uint8' },
          { name: 'stakeSats', type: 'uint64' },
        ],
      },
      {
        name: 'resolveMarket',
        type: 'function',
        stateMutability: 'nonpayable',
        inputs: [
          { name: '_winningBucket', type: 'uint8' },
          { name: '_resolutionPriceCents', type: 'uint32' },
          { name: 'oracleSig', type: 'bytes' },
        ],
      },
      {
        name: 'claimWinningPayout',
        type: 'function',
        stateMutability: 'nonpayable',
        inputs: [
          { name: 'predictor', type: 'address' },
          { name: 'receiptBucketId', type: 'uint8' },
          { name: 'stakedSats', type: 'uint64' },
        ],
      },
      {
        name: 'reclaimExpiredStake',
        type: 'function',
        stateMutability: 'nonpayable',
        inputs: [
          { name: 'predictor', type: 'address' },
          { name: 'stakedSats', type: 'uint64' },
        ],
      },
      {
        name: 'drainCashTokensBeforeClose',
        type: 'function',
        stateMutability: 'nonpayable',
        inputs: [{ name: 'treasury', type: 'address' }],
      },
      {
        name: 'terminatePool',
        type: 'function',
        stateMutability: 'nonpayable',
        inputs: [{ name: 'treasury', type: 'address' }],
      },
    ],
    bytecodeTemplateHex:
      '',
  };
}

export interface SolidHatPoolState {
  marketId: number;
  oraclePubKeyHex: string;
  expiryTimestamp: bigint;
  refundTimestamp: bigint;
  feeBps: bigint;
  totalPoolSats: bigint;
  noPoolSats: bigint;
  yesPoolSats: bigint;
  activeReceiptTokenUnits: bigint;
  isResolved: boolean;
  winningBucket: number;
  resolutionPriceCents: number;
  cashTokensDrained: boolean;
  isTerminated: boolean;
  compositionConvention: SolidCashCompositionMode;
}

/**
 * TypeScript behavioral simulator; this does not execute compiled SolidCash bytecode.
 * Its assertions are not evidence of oracle-signature or receipt-ownership security.
 */
export class SolidHatPredictionPoolHarness {
  public state: SolidHatPoolState;

  constructor(params: {
    marketId: number;
    oraclePubKeyHex: string;
    expiryTimestamp: bigint;
    refundTimestamp: bigint;
    feeBps?: bigint;
    compositionConvention?: SolidCashCompositionMode;
  }) {
    if (params.expiryTimestamp <= 0n) {
      throw new Error('Invalid expiry timestamp');
    }
    if (params.refundTimestamp <= params.expiryTimestamp) {
      throw new Error('Refund timeout must follow expiry');
    }
    const feeBps = params.feeBps ?? 100n;
    if (feeBps > 500n) {
      throw new Error('Protocol fee capped at 5%');
    }

    this.state = {
      marketId: params.marketId,
      oraclePubKeyHex: params.oraclePubKeyHex,
      expiryTimestamp: params.expiryTimestamp,
      refundTimestamp: params.refundTimestamp,
      feeBps,
      totalPoolSats: 0n,
      noPoolSats: 0n,
      yesPoolSats: 0n,
      activeReceiptTokenUnits: 0n,
      isResolved: false,
      winningBucket: 0,
      resolutionPriceCents: 0,
      cashTokensDrained: false,
      isTerminated: false,
      compositionConvention: params.compositionConvention ?? 'direct',
    };
  }

  public placeStake(bucketId: 0 | 1, stakeSats: bigint): { receiptCommitmentHex: string } {
    if (this.state.isTerminated) throw new Error('Pool UTXO already terminated');
    if (this.state.isResolved) throw new Error('Market already resolved');
    if (stakeSats < 546n) throw new Error('Stake below 546 satoshi BCH dust limit');

    this.state.totalPoolSats += stakeSats;
    if (bucketId === 0) {
      this.state.noPoolSats += stakeSats;
    } else {
      this.state.yesPoolSats += stakeSats;
    }
    this.state.activeReceiptTokenUnits += 1n;
    this.state.cashTokensDrained = false;

    const buf = Buffer.alloc(13);
    buf.writeUInt32BE(this.state.marketId >>> 0, 0);
    buf.writeUInt8(bucketId, 4);
    buf.writeBigUInt64BE(stakeSats, 5);

    return { receiptCommitmentHex: buf.toString('hex') };
  }

  public resolveMarket(params: {
    winningBucket: 0 | 1;
    resolutionPriceCents: number;
    oracleSigHex: string;
    currentTimestamp: bigint;
  }): void {
    if (this.state.isResolved) throw new Error('Market already resolved');
    if (params.currentTimestamp < this.state.expiryTimestamp) {
      throw new Error('Market has not reached expiryTimestamp');
    }
    if (params.oracleSigHex.length < 128) {
      throw new Error('Invalid Schnorr oracle signature length');
    }

    this.state.isResolved = true;
    this.state.winningBucket = params.winningBucket;
    this.state.resolutionPriceCents = params.resolutionPriceCents;
  }

  public claimWinningPayout(params: {
    receiptBucketId: 0 | 1;
    stakedSats: bigint;
  }): { payoutSats: bigint } {
    if (!this.state.isResolved) throw new Error('Market is not resolved yet');
    if (params.receiptBucketId !== this.state.winningBucket) {
      throw new Error('Receipt bucket did not win');
    }
    if (this.state.activeReceiptTokenUnits <= 0n) {
      throw new Error('No active receipt tokens remaining');
    }

    const winningPool =
      this.state.winningBucket === 0 ? this.state.noPoolSats : this.state.yesPoolSats;
    const totalAtResolution = this.state.noPoolSats + this.state.yesPoolSats;
    const netPool = (totalAtResolution * (10_000n - this.state.feeBps)) / 10_000n;
    let payoutSats = (params.stakedSats * netPool) / winningPool;
    if (payoutSats < 546n) {
      throw new Error('Calculated payout below dust limit');
    }
    if (payoutSats > this.state.totalPoolSats) {
      payoutSats = this.state.totalPoolSats;
    }

    this.state.totalPoolSats -= payoutSats;
    this.state.activeReceiptTokenUnits -= 1n;

    return { payoutSats };
  }

  public reclaimExpiredStake(params: {
    stakedSats: bigint;
    currentTimestamp: bigint;
  }): { refundedSats: bigint } {
    if (this.state.isResolved) {
      throw new Error('Resolved market cannot use timeout refund');
    }
    if (params.currentTimestamp < this.state.refundTimestamp) {
      throw new Error('Refund timeout not reached yet');
    }
    if (this.state.totalPoolSats < params.stakedSats) {
      throw new Error('Invalid refund amount');
    }

    this.state.totalPoolSats -= params.stakedSats;
    this.state.activeReceiptTokenUnits -= 1n;
    return { refundedSats: params.stakedSats };
  }

  public drainCashTokensBeforeClose(currentTimestamp: bigint): { drainedUnits: bigint } {
    if (!this.state.isResolved && currentTimestamp < this.state.refundTimestamp) {
      throw new Error('Pool still active');
    }
    const drainedUnits = this.state.activeReceiptTokenUnits;
    this.state.activeReceiptTokenUnits = 0n;
    this.state.cashTokensDrained = true;
    return { drainedUnits };
  }

  public terminatePool(currentTimestamp: bigint): { sweptSats: bigint; terminated: true } {
    if (!this.state.isResolved && currentTimestamp < this.state.refundTimestamp) {
      throw new Error('Cannot terminate active market');
    }
    if (!this.state.cashTokensDrained || this.state.activeReceiptTokenUnits > 0n) {
      throw new Error('CRITICAL: Must drain CashTokens before selfdestruct');
    }

    const sweptSats = this.state.totalPoolSats;
    this.state.totalPoolSats = 0n;
    this.state.isTerminated = true;
    return { sweptSats, terminated: true };
  }
}
