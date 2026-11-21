import {
  ConfigurableMarket,
  MarketBucketPool,
  type MarketBuy,
  type MarketPriceBook,
} from "@cashingularity/shared";
import { isLiveEpoch } from "./marketEpochs.js";

type Rule =
  | { kind: "above"; thresholdCents: number }
  | { kind: "below"; thresholdCents: number }
  | { kind: "range"; lowerCents: number; upperCents: number };
export interface PaperPosition {
  id: string;
  marketId: number;
  epochSeriesId?: string;
  bucketId: number;
  market: string;
  outcome: string;
  sats: bigint;
  stakeUsd: number;
  multiplier: number;
  payoutSats: bigint;
  entryOddsBps: number;
  placedAtMs: number;
  expiresAtMs: number;
  rule: Rule;
  status: "ACTIVE" | "WON" | "LOST" | "CASHED_OUT";
  cashOutSats?: bigint;
  settledAtMs?: number;
  settlementPrice?: number;
}
export interface PaperAccount {
  balanceSats: bigint;
  positions: PaperPosition[];
  buys: MarketBuy[];
}
export const initialPaperAccount: PaperAccount = {
  balanceSats: 250_000_000n,
  positions: [],
  buys: [],
};

function outcomeRule(market: ConfigurableMarket, bucket: MarketBucketPool): Rule | undefined {
  const index = market.buckets.findIndex(
    (item) => item.bucketId === bucket.bucketId,
  );
  if (index < 0) return;

  let rule: Rule | undefined;
  if (
    bucket.outcomeRule === "ABOVE" &&
    Number.isFinite(bucket.lowerBoundCents ?? market.strikePriceCents) &&
    (bucket.lowerBoundCents ?? market.strikePriceCents) > 0
  ) {
    rule = {
      kind: "above",
      thresholdCents: Math.round(
        bucket.lowerBoundCents ?? market.strikePriceCents,
      ),
    };
  } else if (
    bucket.outcomeRule === "BELOW" &&
    Number.isFinite(bucket.upperBoundCents ?? market.strikePriceCents) &&
    (bucket.upperBoundCents ?? market.strikePriceCents) > 0
  ) {
    rule = {
      kind: "below",
      thresholdCents: Math.round(
        bucket.upperBoundCents ?? market.strikePriceCents,
      ),
    };
  } else if (
    bucket.outcomeRule === "RANGE" &&
    Number.isFinite(bucket.lowerBoundCents) &&
    Number.isFinite(bucket.upperBoundCents) &&
    bucket.lowerBoundCents! > 0 &&
    bucket.upperBoundCents! >= bucket.lowerBoundCents!
  ) {
    rule = {
      kind: "range",
      lowerCents: Math.round(bucket.lowerBoundCents!),
      upperCents: Math.round(bucket.upperBoundCents!),
    };
  } else if (
    !bucket.outcomeRule &&
    market.buckets.length === 2 &&
    Number.isFinite(market.strikePriceCents) &&
    market.strikePriceCents > 0
  ) {
    // Fallback only if outcomeRule is omitted on a binary market
    rule =
      index === 0
        ? { kind: "below", thresholdCents: Math.round(market.strikePriceCents) }
        : {
            kind: "above",
            thresholdCents: Math.round(market.strikePriceCents),
          };
  }
  return rule;
}

/** Lock only rules that can be unambiguously derived from the displayed outcomes. */
export function makePaperPosition(
  market: ConfigurableMarket,
  bucket: MarketBucketPool,
  sats: bigint,
  payoutSats: bigint,
  multiplier: number,
  spot: number,
  now = Date.now(),
  entryOddsBps = market.totalPoolSats > 0n ? Number(bucket.poolSats * 10_000n / market.totalPoolSats) : 0,
): PaperPosition {
  if (!Number.isFinite(market.expiryTimestampMs) || !isLiveEpoch(market, now) ||
      sats <= 0n || payoutSats < sats || !Number.isFinite(multiplier) || multiplier < 1 ||
      !Number.isFinite(spot) || spot <= 0) {
    throw new Error("This paper position is not available.");
  }
  const rule = outcomeRule(market, bucket);
  if (!rule)
    throw new Error(
      "The outcome cannot be settled from the displayed market rules.",
    );
  return {
    id: crypto.randomUUID(),
    marketId: market.marketId,
    ...(market.epochSeriesId ? { epochSeriesId: market.epochSeriesId } : {}),
    bucketId: bucket.bucketId,
    market: market.title,
    outcome: bucket.label,
    sats,
    stakeUsd: (Number(sats) / 1e8) * spot,
    multiplier,
    payoutSats,
    entryOddsBps,
    placedAtMs: now,
    expiresAtMs: market.expiryTimestampMs,
    rule,
    status: "ACTIVE",
  };
}

export function isPaperPositionInRound(position: PaperPosition, market: ConfigurableMarket): boolean {
  return position.marketId === market.marketId && position.expiresAtMs === market.expiryTimestampMs;
}

export function openPaperPositions(positions: PaperPosition[], market: ConfigurableMarket | undefined, nowMs: number): PaperPosition[] {
  if (!market || !isLiveEpoch(market, nowMs)) return [];
  return positions.filter(position => position.status === 'ACTIVE' && isPaperPositionInRound(position, market));
}

export const PAPER_QUOTE_TTL_MS = 15_000;

export function isPaperQuoteCurrent(pricing: MarketPriceBook, market: ConfigurableMarket, nowMs: number): boolean {
  return isLiveEpoch(market, nowMs) && pricing.marketId === market.marketId && pricing.expiryMs === market.expiryTimestampMs &&
    pricing.asOfMs <= nowMs && nowMs < pricing.asOfMs + PAPER_QUOTE_TTL_MS;
}

export interface PaperCashOutQuote {
  positionId: string;
  openStakeSats: bigint;
  amountSats: bigint;
  payoutShareSats: bigint;
  proceedsSats: bigint;
  bidBps: number;
}

/** Apply the current bid to the sold portion of the position's locked payout. */
export function quotePaperCashOut(
  position: PaperPosition, market: ConfigurableMarket, amountSats: bigint, pricing: MarketPriceBook, nowMs: number,
): PaperCashOutQuote | undefined {
  if (position.status !== 'ACTIVE' || !isPaperPositionInRound(position, market) ||
      !isPaperQuoteCurrent(pricing, market, nowMs) || amountSats <= 0n || amountSats > position.sats ||
      position.payoutSats < position.sats || market.totalPoolSats <= 0n) return;
  const bucket = market.buckets.find(item => item.bucketId === position.bucketId);
  const quote = pricing.outcomes.find(item => item.bucketId === position.bucketId);
  if (!bucket || !quote || !Number.isInteger(quote.bidBps) || quote.bidBps < 0 || quote.bidBps > 10000) return;
  const rule = outcomeRule(market, bucket);
  // Both rules have the same canonical shape from outcomeRule().
  if (!rule || JSON.stringify(rule) !== JSON.stringify(position.rule)) return;
  const payoutShareSats = (position.payoutSats * amountSats) / position.sats;
  return {
    positionId: position.id,
    openStakeSats: position.sats,
    amountSats,
    payoutShareSats,
    proceedsSats: payoutShareSats * BigInt(quote.bidBps) / 10_000n,
    bidBps: quote.bidBps,
  };
}

export function paperCashOutQuoteMatches(review: PaperCashOutQuote, current: PaperCashOutQuote | undefined): boolean {
  return !!current && review.positionId === current.positionId && review.openStakeSats === current.openStakeSats &&
    review.amountSats === current.amountSats && review.proceedsSats === current.proceedsSats &&
    review.payoutShareSats === current.payoutShareSats && review.bidBps === current.bidBps;
}

export interface PaperCashOut {
  type: 'cashOut';
  market: ConfigurableMarket;
  quotes: PaperCashOutQuote[];
  pricing: MarketPriceBook;
  nowMs: number;
}

function splitPositionSale(position: PaperPosition, quote: PaperCashOutQuote, nowMs: number): PaperPosition[] {
  const remainingSats = position.sats - quote.amountSats;
  const soldStakeUsd = position.stakeUsd * (Number(quote.amountSats) / Number(position.sats));
  const sold: PaperPosition = {
    ...position,
    id: remainingSats ? `${position.id}:cash-out:${position.sats}` : position.id,
    sats: quote.amountSats,
    stakeUsd: soldStakeUsd,
    payoutSats: quote.payoutShareSats,
    cashOutSats: quote.proceedsSats,
    status: 'CASHED_OUT',
    settledAtMs: nowMs,
  };
  const remaining: PaperPosition = {
    ...position,
    sats: remainingSats,
    stakeUsd: position.stakeUsd - soldStakeUsd,
    payoutSats: position.payoutSats - quote.payoutShareSats,
  };
  return remainingSats > 0n ? [remaining, sold] : [sold];
}

export function validatePaperCashOut(positions: PaperPosition[], { quotes, market, pricing, nowMs }: PaperCashOut): boolean {
  if (!quotes.length || new Set(quotes.map(quote => quote.positionId)).size !== quotes.length) return false;
  const byId = new Map(positions.map(position => [position.id, position]));
  return quotes.every(quote => {
    const position = byId.get(quote.positionId);
    return !!position && paperCashOutQuoteMatches(quote, quotePaperCashOut(position, market, quote.amountSats, pricing, nowMs));
  });
}

function executePaperCashOut(account: PaperAccount, action: PaperCashOut): PaperAccount {
  if (!validatePaperCashOut(account.positions, action)) return account;
  const sales = new Map(action.quotes.map(quote => [quote.positionId, quote]));
  return {
    ...account,
    balanceSats: account.balanceSats + action.quotes.reduce((sum, quote) => sum + quote.proceedsSats, 0n),
    positions: account.positions.flatMap(position => {
      const sale = sales.get(position.id);
      return sale ? splitPositionSale(position, sale, action.nowMs) : [position];
    }),
  };
}

export type PaperAction =
  | { type: "setBalance"; balanceSats: bigint }
  | { type: "transfer"; totalSats: bigint }
  | { type: "place"; position: PaperPosition }
  | PaperCashOut
  | {
      type: "settle";
      price: number;
      fetchedAtMs: number;
      nowMs: number;
      historicalSettlement?: boolean;
      positionId?: string;
    };
export function paperAccountReducer(
  account: PaperAccount,
  action: PaperAction,
): PaperAccount {
  if (action.type === 'setBalance') return action.balanceSats >= 0n ? { ...account, balanceSats: action.balanceSats } : account;
  if (action.type === 'transfer') return action.totalSats > 0n && action.totalSats <= account.balanceSats ? { ...account, balanceSats: account.balanceSats - action.totalSats } : account;
  if (action.type === 'cashOut') return executePaperCashOut(account, action);
  if (action.type === "place") {
    const position = action.position;
    if (
      position.status !== "ACTIVE" ||
      position.sats <= 0n ||
      position.sats > account.balanceSats ||
      position.payoutSats < position.sats ||
      account.positions.some((p) => p.id === position.id)
    )
      return account;
    return {
      balanceSats: account.balanceSats - position.sats,
      positions: [position, ...account.positions],
      buys: [...account.buys.slice(-95), {
        id: position.id, marketId: position.marketId, bucketId: position.bucketId,
        sats: position.sats, timestampMs: position.placedAtMs,
      }],
    };
  }
  if (
    !Number.isFinite(action.nowMs) ||
    !Number.isFinite(action.price) ||
    action.price <= 0 ||
    !Number.isFinite(action.fetchedAtMs) ||
    action.fetchedAtMs > action.nowMs + 5000 ||
    (!action.historicalSettlement && action.nowMs - action.fetchedAtMs > 60_000)
  )
    return account;
  const priceCents = Math.round(action.price * 100);
  let credited = 0n;
  const positions = account.positions.map((position) => {
    if (
      position.status !== "ACTIVE" ||
      action.nowMs < position.expiresAtMs ||
      action.fetchedAtMs < position.expiresAtMs ||
      (action.historicalSettlement
        ? action.positionId !== position.id || action.fetchedAtMs !== position.expiresAtMs
        : action.fetchedAtMs > position.expiresAtMs + 10_000)
    )
      return position;
    const rule = position.rule;
    const won =
      rule.kind === "above"
        ? priceCents >= rule.thresholdCents
        : rule.kind === "below"
          ? priceCents < rule.thresholdCents
          : priceCents >= rule.lowerCents && priceCents <= rule.upperCents;
    if (won) credited += position.payoutSats;
    return {
      ...position,
      status: won ? ("WON" as const) : ("LOST" as const),
      settledAtMs: action.fetchedAtMs,
      settlementPrice: action.price,
    };
  });
  return positions.every((p, i) => p === account.positions[i])
    ? account
    : { ...account, balanceSats: account.balanceSats + credited, positions };
}

export type PaperWalletAction = Exclude<PaperAction, { type: 'settle' }>;
export type PaperAccounts = Record<string, PaperAccount>;

export function paperAccountsReducer(accounts: PaperAccounts, event: { scopeId: string; action: PaperWalletAction } | Extract<PaperAction, { type: 'settle' }>): PaperAccounts {
  if ('scopeId' in event) {
    const previous = accounts[event.scopeId] ?? initialPaperAccount;
    const next = paperAccountReducer(previous, event.action);
    return next === previous ? accounts : { ...accounts, [event.scopeId]: next };
  }
  let next = accounts;
  for (const [scopeId, previous] of Object.entries(accounts)) {
    const settled = paperAccountReducer(previous, event);
    if (settled !== previous) {
      if (next === accounts) next = { ...accounts };
      next[scopeId] = settled;
    }
  }
  return next;
}

/** A one-minute expiry close must match the epoch boundary exactly. */
export function exactPaperExpiryClose(
  candles: Array<{ time: number; close: number }>, expiryMs: number,
): number | undefined {
  const candle = candles.find(c => (c.time + 60) * 1000 === expiryMs);
  return candle && Number.isFinite(candle.close) && candle.close > 0 ? candle.close : undefined;
}
