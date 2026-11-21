/**
 * @cashingularity/shared - Strict BigInt Satoshi Arithmetic, Parimutuel Math & EWMA Volatility Engine
 * BCH BLAZE 2026
 */

import {
  BPS_DENOMINATOR,
  DEFAULT_PROTOCOL_FEE_BPS,
  DUST_LIMIT_SATS,
  EWMA_LAMBDA_DEFAULT,
  HDAccountScope,
  HDDerivationCoordinate,
  NftReceiptCommitment,
  ParimutuelSimulationResult,
  SATS_PER_BCH,
  VolatilityBandPoint,
} from './types.js';

/**
 * Checks whether a satoshi amount meets the Bitcoin Cash dust threshold (>= 546n sats).
 */
export function isAboveDustLimit(sats: bigint): boolean {
  return sats >= DUST_LIMIT_SATS;
}

/**
 * Converts a BCH amount (string or number) into exact 64-bit BigInt satoshis (1 BCH = 100_000_000n sats)
 * using deterministic string decimal parsing to avoid IEEE-754 floating-point drift.
 */
export function bchToSats(bchAmount: number | string): bigint {
  const raw = typeof bchAmount === 'number' ? bchAmount.toFixed(8) : bchAmount.trim();
  if (!raw || raw === 'NaN') {
    throw new Error(`Invalid BCH amount: ${String(bchAmount)}`);
  }

  const isNegative = raw.startsWith('-');
  const unsigned = isNegative || raw.startsWith('+') ? raw.slice(1) : raw;
  const parts = unsigned.split('.');
  if (parts.length > 2) {
    throw new Error(`Malformed decimal BCH string: ${raw}`);
  }

  const wholePart = parts[0] || '0';
  const fracPart = (parts[1] || '').padEnd(8, '0').slice(0, 8);

  if (!/^\d+$/.test(wholePart) || !/^\d+$/.test(fracPart)) {
    throw new Error(`Non-numeric characters in BCH amount: ${raw}`);
  }

  const totalSats = BigInt(wholePart) * SATS_PER_BCH + BigInt(fracPart);
  return isNegative ? -totalSats : totalSats;
}

/**
 * Formats a BigInt satoshi balance into a human-readable BCH string.
 */
export function satsToBchString(sats: bigint, maxDecimals = 8): string {
  const isNegative = sats < 0n;
  const absSats = isNegative ? -sats : sats;
  const whole = absSats / SATS_PER_BCH;
  const fraction = absSats % SATS_PER_BCH;

  if (maxDecimals <= 0 || fraction === 0n) {
    return `${isNegative ? '-' : ''}${whole.toString()}`;
  }

  const paddedFrac = fraction.toString().padStart(8, '0').slice(0, maxDecimals);
  const trimmedFrac = paddedFrac.replace(/0+$/, '');
  return trimmedFrac.length > 0
    ? `${isNegative ? '-' : ''}${whole.toString()}.${trimmedFrac}`
    : `${isNegative ? '-' : ''}${whole.toString()}`;
}

/**
 * Converts a fiat or token amount into BigInt satoshis given the exchange rate (BCH per 1 unit of currency).
 */
export function fiatToSats(amount: number, bchPerUnitRate: number): bigint {
  if (!Number.isFinite(amount) || !Number.isFinite(bchPerUnitRate) || bchPerUnitRate < 0) {
    return 0n;
  }
  const bchValue = amount * bchPerUnitRate;
  const sats = Math.round(bchValue * Number(SATS_PER_BCH));
  if (!Number.isSafeInteger(sats)) throw new Error('Currency conversion exceeds safe satoshi precision.');
  return BigInt(sats);
}

/**
 * Standard BIP44 / CashTokens HD path generator:
 * - receive: m/44'/145'/0'/0/n
 * - change:  m/44'/145'/0'/1/n
 * - defi:    m/44'/145'/0'/2/n
 */
export function deriveHdCoordinate(scope: HDAccountScope, addressIndex: number): HDDerivationCoordinate {
  if (!Number.isInteger(addressIndex) || addressIndex < 0) {
    throw new Error(`Invalid HD address index: ${addressIndex}`);
  }
  const branchIndex: 0 | 1 | 2 = scope === 'receive' ? 0 : scope === 'change' ? 1 : 2;
  return {
    scope,
    branchIndex,
    addressIndex,
    fullPath: `m/44'/145'/0'/${branchIndex}/${addressIndex}`,
  };
}

function parimutuelDistribution(
  totalSats: bigint,
  winningSats: bigint,
  feeBps: bigint,
  outputDustCount: bigint,
) {
  const losingSats = totalSats - winningSats;
  const fee = feeBps < 0n ? 0n : feeBps > BPS_DENOMINATOR ? BPS_DENOMINATOR : feeBps;
  const protocolFeeSats = (losingSats * fee) / BPS_DENOMINATOR;
  const availableWinnings = losingSats - protocolFeeSats;
  const requestedDust = outputDustCount > 0n ? outputDustCount * DUST_LIMIT_SATS : 0n;
  const dustReserveSats = requestedDust < availableWinnings ? requestedDust : availableWinnings;
  return {
    protocolFeeSats,
    dustReserveSats,
    netDistributableSats: winningSats + availableWinnings - dustReserveSats,
  };
}

/** Each winner recovers their stake and shares the losing pool after fees and reserves. */
export function calculateParimutuelMultiplier(params: {
  totalPoolSats: bigint;
  bucketPoolSats: bigint;
  deltaStakeSats: bigint;
  feeBps?: bigint;
  outputDustCount?: bigint;
}): ParimutuelSimulationResult {
  const startPerf = performance.now();

  const totalPoolSats = params.totalPoolSats < 0n ? 0n : params.totalPoolSats;
  const bucketPoolSats = params.bucketPoolSats < 0n ? 0n
    : params.bucketPoolSats > totalPoolSats ? totalPoolSats : params.bucketPoolSats;
  const deltaStakeSats = params.deltaStakeSats < 0n ? 0n : params.deltaStakeSats;
  const feeBps = params.feeBps ?? DEFAULT_PROTOCOL_FEE_BPS;
  const outputDustCount = params.outputDustCount ?? 1n;

  const totalPoolAfterSats = totalPoolSats + deltaStakeSats;
  const bucketPoolAfterSats = bucketPoolSats + deltaStakeSats;

  const { protocolFeeSats, dustReserveSats, netDistributableSats } = parimutuelDistribution(
    totalPoolAfterSats, bucketPoolAfterSats, feeBps, outputDustCount,
  );

  // Fixed-point 6-decimal precision multiplier
  const SCALE = 1_000_000n;
  const scaledMultiplier = bucketPoolAfterSats > 0n ? (netDistributableSats * SCALE) / bucketPoolAfterSats : 0n;
  const multiplier = Number(scaledMultiplier) / Number(SCALE);

  const estimatedPayoutSats = bucketPoolAfterSats > 0n
    ? (deltaStakeSats * netDistributableSats) / bucketPoolAfterSats
    : 0n;
  const netProfitSats = estimatedPayoutSats - deltaStakeSats;

  const calculationTimeMs = performance.now() - startPerf;

  return {
    stakeSats: deltaStakeSats,
    totalPoolAfterSats,
    bucketPoolAfterSats,
    protocolFeeSats,
    dustReserveSats,
    netDistributableSats,
    multiplier,
    estimatedPayoutSats,
    netProfitSats,
    calculationTimeMs,
  };
}

/**
 * Parimutuel payout for a settled pool, excluding any transaction dust reserve.
 */
export function calculateExactParimutuelPayout(
  stakeSats: bigint,
  totalPoolSats: bigint,
  winningPoolSats: bigint,
  feeBps: bigint = DEFAULT_PROTOCOL_FEE_BPS
): bigint {
  if (stakeSats <= 0n || stakeSats > winningPoolSats || winningPoolSats > totalPoolSats) {
    return 0n;
  }
  const { netDistributableSats } = parimutuelDistribution(totalPoolSats, winningPoolSats, feeBps, 0n);
  return (stakeSats * netDistributableSats) / winningPoolSats;
}

/**
 * Generates an array of parimutuel multiplier points across a stake range in < 4ms
 * for real-time ECharts / Lightweight Charts curve rendering.
 */
export function generateParimutuelMultiplierCurve(params: {
  totalPoolSats: bigint;
  bucketPoolSats: bigint;
  minStakeSats?: bigint;
  maxStakeSats: bigint;
  steps?: number;
  feeBps?: bigint;
  outputDustCount?: bigint;
}): Array<{ stakeSats: bigint; multiplier: number; estimatedPayoutSats: bigint }> {
  const minStake = params.minStakeSats ?? DUST_LIMIT_SATS;
  const maxStake = params.maxStakeSats > minStake ? params.maxStakeSats : minStake + 10_000n;
  const steps = Math.max(2, params.steps ?? 25);
  const stepSize = (maxStake - minStake) / BigInt(steps - 1);

  const curve: Array<{ stakeSats: bigint; multiplier: number; estimatedPayoutSats: bigint }> = [];
  for (let i = 0; i < steps; i++) {
    const stakeSats = i === steps - 1 ? maxStake : minStake + stepSize * BigInt(i);
    const sim = calculateParimutuelMultiplier({
      totalPoolSats: params.totalPoolSats,
      bucketPoolSats: params.bucketPoolSats,
      deltaStakeSats: stakeSats,
      feeBps: params.feeBps,
      outputDustCount: params.outputDustCount,
    });
    curve.push({
      stakeSats,
      multiplier: sim.multiplier,
      estimatedPayoutSats: sim.estimatedPayoutSats,
    });
  }
  return curve;
}

/**
 * Computes RiskMetrics EWMA volatility sigma(t) with decay factor lambda = 0.94:
 * sigma_t^2 = lambda * sigma_{t-1}^2 + (1 - lambda) * r_t^2
 */
export function computeEwmaSigma(prices: number[], lambda: number = EWMA_LAMBDA_DEFAULT): number {
  const validPrices = prices.filter((p) => Number.isFinite(p) && p > 0);
  if (validPrices.length < 2) {
    return 0.0015; // Baseline per-step volatility when history is empty
  }

  const logReturns: number[] = [];
  for (let i = 1; i < validPrices.length; i++) {
    logReturns.push(Math.log(validPrices[i] / validPrices[i - 1]));
  }

  let variance = logReturns[0] * logReturns[0];
  for (let i = 1; i < logReturns.length; i++) {
    const r = logReturns[i];
    variance = lambda * variance + (1 - lambda) * (r * r);
  }

  return Math.max(Math.sqrt(variance), 1e-6);
}

/**
 * Generates 1-sigma and 2-sigma EWMA volatility cone bands over remaining market horizon tau = T - t:
 * P_band(t + tau) = P(t) * exp((mu_AI(t) - 0.5 * sigma(t)^2) * tau +/- k * sigma(t) * sqrt(tau))
 */
export function generateEwmaVolatilityCone(params: {
  currentPrice: number;
  muAiDrift: number;
  sigma: number;
  remainingSeconds: number;
  steps?: number;
  nowMs?: number;
}): VolatilityBandPoint[] {
  const { currentPrice, muAiDrift, sigma } = params;
  const remainingSeconds = Math.max(1, params.remainingSeconds);
  const steps = Math.max(2, params.steps ?? 30);
  const nowMs = params.nowMs ?? Date.now();

  const points: VolatilityBandPoint[] = [];
  const driftTermPerUnit = muAiDrift - 0.5 * sigma * sigma;

  for (let i = 0; i <= steps; i++) {
    const tauSeconds = (remainingSeconds * i) / steps;
    // Normalize tau into horizon fraction or per-minute scale so exp() stays numerically well-conditioned
    const tauNormalized = tauSeconds / 60;
    const sqrtTau = Math.sqrt(tauNormalized);
    const baseDrift = driftTermPerUnit * tauNormalized;

    const meanPrice = currentPrice * Math.exp(baseDrift);
    const upper1Sigma = currentPrice * Math.exp(baseDrift + 1 * sigma * sqrtTau);
    const lower1Sigma = currentPrice * Math.exp(baseDrift - 1 * sigma * sqrtTau);
    const upper2Sigma = currentPrice * Math.exp(baseDrift + 2 * sigma * sqrtTau);
    const lower2Sigma = currentPrice * Math.exp(baseDrift - 2 * sigma * sqrtTau);

    points.push({
      tauSeconds: Math.round(tauSeconds),
      timestampMs: Math.round(nowMs + tauSeconds * 1000),
      meanPrice: Number(meanPrice.toFixed(4)),
      upper1Sigma: Number(upper1Sigma.toFixed(4)),
      lower1Sigma: Number(lower1Sigma.toFixed(4)),
      upper2Sigma: Number(upper2Sigma.toFixed(4)),
      lower2Sigma: Number(lower2Sigma.toFixed(4)),
    });
  }

  return points;
}

/**
 * Encodes a CashTokens NFT Receipt commitment into bytes:
 * - Compact 13-byte layout: [marketId(4B BE) | bucketId(1B) | stakeSats(8B BE)]
 * - Extended 20-byte layout (if entryPriceCents is provided):
 *   [marketId(4B BE) | bucketId(1B) | stakeSats(8B BE) | entryPriceCents(4B BE) | flags(3B)]
 */
export function encodeNftReceiptCommitment(params: {
  marketId: number;
  bucketId: number;
  stakeSats: bigint;
  entryPriceCents?: number;
  flagsHex?: string;
}): Uint8Array {
  if (!Number.isInteger(params.marketId) || params.marketId < 0 || params.marketId > 0xffffffff) throw new Error('marketId must be a uint32.');
  if (!Number.isInteger(params.bucketId) || params.bucketId < 0 || params.bucketId > 255) throw new Error('bucketId must be a uint8.');
  if (params.stakeSats < 0n || params.stakeSats > 0xffffffffffffffffn) throw new Error('stakeSats must be a uint64.');
  if (params.entryPriceCents !== undefined && (!Number.isInteger(params.entryPriceCents) || params.entryPriceCents < 0 || params.entryPriceCents > 0xffffffff)) throw new Error('entryPriceCents must be a uint32.');
  const flags = (params.flagsHex ?? '010064').replace(/^0x/i, '');
  if (!/^[a-f0-9]{6}$/i.test(flags)) throw new Error('Receipt flags must contain exactly 3 bytes.');
  const isExtended = params.entryPriceCents !== undefined;
  const byteLength = isExtended ? 20 : 13;
  const buffer = new ArrayBuffer(byteLength);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  view.setUint32(0, params.marketId >>> 0, false); // Big-endian 4B marketId
  view.setUint8(4, params.bucketId & 0xff);        // 1B bucketId
  view.setBigUint64(5, params.stakeSats, false);   // Big-endian 8B stakeSats

  if (isExtended) {
    view.setUint32(13, (params.entryPriceCents ?? 0) >>> 0, false);
    bytes[17] = parseInt(flags.slice(0, 2), 16);
    bytes[18] = parseInt(flags.slice(2, 4), 16);
    bytes[19] = parseInt(flags.slice(4, 6), 16);
  }

  return bytes;
}

/**
 * Decodes a 13-byte or 20-byte CashTokens NFT Receipt commitment.
 */
export function decodeNftReceiptCommitment(input: Uint8Array | string): NftReceiptCommitment {
  if (typeof input === 'string' && !/^(?:[a-f0-9]{2})+$/i.test(input.replace(/^0x/i, ''))) throw new Error('Invalid NFT receipt hex.');
  const bytes = typeof input === 'string'
    ? Uint8Array.from(input.replace(/^0x/i, '').match(/../g)!.map(byte => parseInt(byte, 16)))
    : input;
  if (bytes.byteLength !== 13 && bytes.byteLength !== 20) throw new Error(`Invalid NFT receipt commitment length: expected 13 or 20 bytes, got ${bytes.byteLength}`);

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const marketId = view.getUint32(0, false);
  const bucketId = view.getUint8(4);
  const stakeSats = view.getBigUint64(5, false);

  const rawHex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  if (bytes.byteLength >= 20) {
    const entryPriceCents = view.getUint32(13, false);
    const flagsHex = Array.from(bytes.slice(17, 20))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    return {
      marketId,
      bucketId,
      stakeSats,
      entryPriceCents,
      flagsHex,
      rawHex,
    };
  }

  return {
    marketId,
    bucketId,
    stakeSats,
    rawHex,
  };
}
