import { describe, expect, it } from "vitest";
import {
  marketPriceBook,
  type ConfigurableMarket,
  type MarketBucketPool,
} from "@cashingularity/shared";
import {
  initialPaperAccount,
  makePaperPosition,
  paperAccountReducer,
  paperAccountsReducer,
  exactPaperExpiryClose,
  openPaperPositions,
  PAPER_QUOTE_TTL_MS,
  type PaperAccounts,
  quotePaperCashOut,
} from "./paperTrading.js";

const now = 1_800_000_000_000;
const buckets = [
  { bucketId: 0, label: "BELOW $500", outcomeRule: "BELOW", upperBoundCents: 50_000, poolSats: 450_000n },
  { bucketId: 1, label: "ABOVE $500", outcomeRule: "ABOVE", lowerBoundCents: 50_000, poolSats: 550_000n },
] as MarketBucketPool[];
const market = {
  marketId: 5,
  title: "BCH above $500",
  status: "OPEN",
  strikePriceCents: 50_000,
  createdAtMs: now - 1_000,
  expiryTimestampMs: now + 10_000,
  totalPoolSats: 1_000_000n,
  buckets,
} as ConfigurableMarket;
const position = () =>
  makePaperPosition(market, buckets[1], 100_000n, 180_000n, 1.8, 500, now);
const book = (market: ConfigurableMarket, quotedAt = now, spot = 500) => marketPriceBook(market, {
  spot: { usd: spot, timestampMs: quotedAt }, minuteVolatility: 0.0015, buys: [],
}, quotedAt)!;

describe("paper positions", () => {
  it("allows an arbitrary virtual BCH balance and debits virtual transfers without overspending", () => {
    const balanceSats = 999999999999999999999999n;
    const updated = paperAccountReducer(initialPaperAccount, { type: 'setBalance', balanceSats });
    expect(updated.balanceSats).toBe(balanceSats);
    expect(paperAccountReducer(updated, { type: 'transfer', totalSats: 10000n }).balanceSats).toBe(balanceSats - 10000n);
    expect(paperAccountReducer(updated, { type: 'transfer', totalSats: balanceSats + 1n })).toBe(updated);
    expect(paperAccountReducer(updated, { type: 'setBalance', balanceSats: 0n }).balanceSats).toBe(0n);
  });
  it("locks structured position terms, settles a win once and credits the locked payout", () => {
    const p = position();
    const placed = paperAccountReducer(initialPaperAccount, {
      type: "place",
      position: p,
    });
    expect(placed.balanceSats).toBe(249_900_000n);
    const settled = paperAccountReducer(placed, {
      type: "settle",
      price: 501,
      fetchedAtMs: market.expiryTimestampMs + 1000,
      nowMs: market.expiryTimestampMs + 1000,
    });
    expect(settled.positions[0].status).toBe("WON");
    expect(settled.balanceSats).toBe(250_080_000n);
    expect(
      paperAccountReducer(settled, {
        type: "settle",
        price: 501,
        fetchedAtMs: market.expiryTimestampMs + 1000,
        nowMs: market.expiryTimestampMs + 1000,
      }),
    ).toBe(settled);
  });
  it("does not settle before expiry or with stale prices, and settles late tab returns", () => {
    const placed = paperAccountReducer(initialPaperAccount, {
      type: "place",
      position: position(),
    });
    // Before expiry: must remain ACTIVE
    expect(
      paperAccountReducer(placed, {
        type: "settle",
        price: 501,
        fetchedAtMs: now,
        nowMs: market.expiryTimestampMs - 1,
      }),
    ).toBe(placed);
    // Live observation fetched >60s before nowMs without historicalSettlement: stale
    expect(
      paperAccountReducer(placed, {
        type: "settle",
        price: 501,
        fetchedAtMs: market.expiryTimestampMs + 1_000,
        nowMs: market.expiryTimestampMs + 120_000,
      }),
    ).toBe(placed);
    // A later current spot must never replace the missing expiry price.
    const lateLiveSettled = paperAccountReducer(placed, {
      type: "settle",
      price: 501,
      fetchedAtMs: market.expiryTimestampMs + 300_000,
      nowMs: market.expiryTimestampMs + 301_000,
    });
    expect(lateLiveSettled).toBe(placed);
    // Late tab return settled via historical Binance candle close
    const historicalSettled = paperAccountReducer(placed, {
      type: "settle",
      price: 499,
      fetchedAtMs: market.expiryTimestampMs,
      nowMs: market.expiryTimestampMs + 600_000,
      historicalSettlement: true,
      positionId: placed.positions[0].id,
    });
    expect(historicalSettled.positions[0].status).toBe("LOST");
  });
  it("uses only the exact expiry candle and never settles another position with its price", () => {
    const expiry = market.expiryTimestampMs;
    expect(exactPaperExpiryClose([{ time: expiry / 1000, close: 999 }], expiry)).toBeUndefined();
    expect(exactPaperExpiryClose([{ time: expiry / 1000 - 60, close: 499 }], expiry)).toBe(499);
    const first = position(), second = { ...position(), expiresAtMs: expiry + 60_000 };
    const account = { ...initialPaperAccount, balanceSats: 0n, positions: [first, second] };
    const settled = paperAccountReducer(account, { type: "settle", price: 501, fetchedAtMs: second.expiresAtMs, nowMs: second.expiresAtMs + 1_000, historicalSettlement: true, positionId: second.id });
    expect(settled.positions[0].status).toBe("ACTIVE");
    expect(settled.positions[1].status).toBe("WON");
    expect(settled.balanceSats).toBe(second.payoutSats);
  });
  it("aligns equality 1:1 with backend (price >= threshold wins ABOVE, loses BELOW)", () => {
    const pBelow = makePaperPosition(
      market,
      buckets[0],
      100_000n,
      180_000n,
      1.8,
      500,
      now,
    );
    const placedBelow = paperAccountReducer(initialPaperAccount, {
      type: "place",
      position: pBelow,
    });
    const lossAtEqual = paperAccountReducer(placedBelow, {
      type: "settle",
      price: 500,
      fetchedAtMs: market.expiryTimestampMs,
      nowMs: market.expiryTimestampMs,
    });
    expect(lossAtEqual.positions[0].status).toBe("LOST");

    const placedAbove = paperAccountReducer(initialPaperAccount, {
      type: "place",
      position: position(),
    });
    const winAtEqual = paperAccountReducer(placedAbove, {
      type: "settle",
      price: 500,
      fetchedAtMs: market.expiryTimestampMs,
      nowMs: market.expiryTimestampMs,
    });
    expect(winAtEqual.positions[0].status).toBe("WON");
  });
  it("rejects unstructured outcomes, expired markets and duplicate positions", () => {
    expect(() =>
      makePaperPosition(
        {
          ...market,
          strikePriceCents: 0,
          buckets: [{ bucketId: 0, label: "MAYBE" } as MarketBucketPool, buckets[1]],
        },
        { bucketId: 0, label: "MAYBE" } as MarketBucketPool,
        1n,
        1n,
        1,
        500,
        now,
      ),
    ).toThrow();
    expect(() =>
      makePaperPosition(
        {
          ...market,
          buckets: [
            buckets[0],
            { bucketId: 1, label: "RANGE", outcomeRule: "RANGE" } as MarketBucketPool,
          ],
        },
        { bucketId: 1, label: "RANGE", outcomeRule: "RANGE" } as MarketBucketPool,
        1n,
        1n,
        1,
        500,
        now,
      ),
    ).toThrow();
    expect(() =>
      makePaperPosition(
        { ...market, expiryTimestampMs: now },
        buckets[0],
        1n,
        1n,
        1,
        500,
        now,
      ),
    ).toThrow();
    expect(() =>
      makePaperPosition(
        { ...market, createdAtMs: now + 1 },
        buckets[0],
        1n,
        1n,
        1,
        500,
        now,
      ),
    ).toThrow();
    const p = position();
    const placed = paperAccountReducer(initialPaperAccount, {
      type: "place",
      position: p,
    });
    expect(paperAccountReducer(placed, { type: "place", position: p })).toBe(
      placed,
    );
  });
  it("locks structured range boundaries and resolves inclusive range endpoints", () => {
    const rangeBuckets = [
      { bucketId: 0, label: "BEAR (< $485)", outcomeRule: "BELOW", upperBoundCents: 48_500, poolSats: 300_000n },
      { bucketId: 1, label: "RANGE ($485 – $515)", outcomeRule: "RANGE", lowerBoundCents: 48_500, upperBoundCents: 51_500, poolSats: 400_000n },
      { bucketId: 2, label: "BULL (> $515)", outcomeRule: "ABOVE", lowerBoundCents: 51_501, poolSats: 300_000n },
    ] as MarketBucketPool[];
    const rangeMarket = { ...market, buckets: rangeBuckets };
    const p = makePaperPosition(
      rangeMarket,
      rangeBuckets[1],
      100_000n,
      180_000n,
      1.8,
      500,
      now,
    );
    const placed = paperAccountReducer(initialPaperAccount, {
      type: "place",
      position: p,
    });
    const settled = paperAccountReducer(placed, {
      type: "settle",
      price: 515,
      fetchedAtMs: rangeMarket.expiryTimestampMs,
      nowMs: rangeMarket.expiryTimestampMs,
    });
    expect(settled.positions[0].status).toBe("WON");
  });

  it('credits precise partial cash-out proceeds and leaves only the unsold payout eligible at expiry', () => {
    const p = position();
    const opened = paperAccountReducer(initialPaperAccount, { type: 'place', position: p });
    const pricing = book(market);
    const quote = quotePaperCashOut(p, market, 40_000n, pricing, now + 1000)!;
    const expectedCredit = 72_000n * BigInt(pricing.outcomes[1].bidBps) / 10_000n;
    expect(quote).toMatchObject({ bidBps: pricing.outcomes[1].bidBps, payoutShareSats: 72_000n, proceedsSats: expectedCredit });
    const cashOut = { type: 'cashOut' as const, market, pricing, quotes: [quote], nowMs: now + 1000 };
    const partial = paperAccountReducer(opened, cashOut);
    expect(partial.balanceSats).toBe(opened.balanceSats + expectedCredit);
    expect(partial.positions).toEqual([
      expect.objectContaining({ id: p.id, status: 'ACTIVE', sats: 60_000n, payoutSats: 108_000n }),
      expect.objectContaining({ status: 'CASHED_OUT', sats: 40_000n, cashOutSats: expectedCredit }),
    ]);
    expect(paperAccountReducer(partial, cashOut)).toBe(partial);
    const settled = paperAccountReducer(partial, {
      type: 'settle', price: 501, nowMs: p.expiresAtMs, fetchedAtMs: p.expiresAtMs,
    });
    expect(settled.positions.map(item => item.status)).toEqual(['WON', 'CASHED_OUT']);
    expect(settled.balanceSats).toBe(partial.balanceSats + 108_000n);
  });

  it('closes the entire position at its reviewed bid and excludes it from further settlement', () => {
    const p = position();
    const opened = paperAccountReducer(initialPaperAccount, { type: 'place', position: p });
    const pricing = book(market);
    const quote = quotePaperCashOut(p, market, p.sats, pricing, now)!;
    const expectedCredit = 180_000n * BigInt(pricing.outcomes[1].bidBps) / 10_000n;
    const closed = paperAccountReducer(opened, { type: 'cashOut', market, pricing, quotes: [quote], nowMs: now });
    expect(closed.positions).toEqual([expect.objectContaining({ id: p.id, status: 'CASHED_OUT', cashOutSats: expectedCredit })]);
    expect(closed.balanceSats).toBe(opened.balanceSats + expectedCredit);
    expect(paperAccountReducer(closed, {
      type: 'settle', price: 501, nowMs: p.expiresAtMs, fetchedAtMs: p.expiresAtMs,
    })).toBe(closed);
  });

  it('holds the reviewed bid through price ticks and rejects expired quotes or changed terms', () => {
    const extended = { ...market, expiryTimestampMs: now + 300_000 };
    const p = { ...position(), expiresAtMs: extended.expiryTimestampMs };
    const opened = paperAccountReducer(initialPaperAccount, { type: 'place', position: p });
    const pricing = book(extended);
    const quote = quotePaperCashOut(p, extended, p.sats, pricing, now)!;
    const sale = { type: 'cashOut' as const, market: extended, pricing, quotes: [quote], nowMs: now + 1000 };
    const moved = book(extended, now + 1000, 505);
    expect(quotePaperCashOut(p, extended, p.sats, moved, now + 1000)!.proceedsSats).toBeGreaterThan(quote.proceedsSats);
    expect(paperAccountReducer(opened, sale).balanceSats).toBe(opened.balanceSats + quote.proceedsSats);
    expect(paperAccountReducer(opened, { ...sale, nowMs: now + PAPER_QUOTE_TTL_MS })).toBe(opened);
    const lastBook = book(extended, p.expiresAtMs - 1);
    const lastQuote = quotePaperCashOut(p, extended, p.sats, lastBook, p.expiresAtMs - 1)!;
    expect(paperAccountReducer(opened, { ...sale, nowMs: p.expiresAtMs, pricing: lastBook, quotes: [lastQuote] })).toBe(opened);
    expect(quotePaperCashOut(p, { ...extended, marketId: 6 }, p.sats, pricing, now)).toBeUndefined();
    expect(quotePaperCashOut(p, { ...extended, status: 'LOCKED' }, p.sats, pricing, now)).toBeUndefined();
    expect(quotePaperCashOut(p, { ...extended, buckets: [buckets[0], { ...buckets[1], lowerBoundCents: 50_500 }] }, p.sats, pricing, now)).toBeUndefined();
    expect(quotePaperCashOut(p, extended, p.sats + 1n, pricing, now)).toBeUndefined();
    expect(quotePaperCashOut(p, extended, 0n, pricing, now)).toBeUndefined();
  });

  it('keeps independent tranches and atomically sells all remaining positions for the selected wallet', () => {
    const first = position();
    const second = makePaperPosition(market, buckets[1], 40_000n, 88_000n, 2.2, 499.5, now + 1000, 4300);
    const third = makePaperPosition(market, buckets[0], 17_000n, 24_000n, 24 / 17, 499, now + 2000, 6100);
    const accounts = [first, second, third].reduce<PaperAccounts>((state, position) => paperAccountsReducer(state, {
      scopeId: 'wallet-a', action: { type: 'place', position },
    }), {});
    const walletA = accounts['wallet-a'];
    expect(walletA.buys.map(buy => buy.id)).toEqual([first.id, second.id, third.id]);
    expect(openPaperPositions(walletA.positions, market, now + 2500).map(p => p.entryOddsBps)).toEqual([6100, 4300, 5500]);
    expect(openPaperPositions((accounts['wallet-b'] ?? initialPaperAccount).positions, market, now + 2500)).toEqual([]);
    expect(openPaperPositions(walletA.positions, undefined, now + 2500)).toEqual([]);
    expect(openPaperPositions(walletA.positions, market, market.expiryTimestampMs)).toEqual([]);
    expect(openPaperPositions(walletA.positions, { ...market, createdAtMs: market.expiryTimestampMs, expiryTimestampMs: market.expiryTimestampMs + 300_000 }, market.expiryTimestampMs)).toEqual([]);

    const pricing = book(market, now + 2500);
    const quotes = [first, second, third].map(p => quotePaperCashOut(p, market, p.sats, pricing, now + 2500)!);
    const sale = { type: 'cashOut' as const, market, pricing, quotes, nowMs: now + 2500 };
    expect(paperAccountsReducer(accounts, { scopeId: 'wallet-b', action: sale })).toBe(accounts);
    expect(paperAccountReducer(walletA, { ...sale, quotes: [...quotes, quotes[0]] })).toBe(walletA);
    expect(paperAccountReducer(walletA, { ...sale, quotes: [{ ...quotes[0], amountSats: 1n }, ...quotes.slice(1)] })).toBe(walletA);
    const after = paperAccountsReducer(accounts, { scopeId: 'wallet-a', action: sale });
    expect(openPaperPositions(after['wallet-a'].positions, market, now + 2500)).toEqual([]);
    expect(after['wallet-a'].positions.every(p => p.status === 'CASHED_OUT')).toBe(true);
    expect(after['wallet-a'].balanceSats).toBe(walletA.balanceSats + quotes.reduce((sum, quote) => sum + quote.proceedsSats, 0n));
    expect(paperAccountsReducer(after, { scopeId: 'wallet-a', action: sale })).toBe(after);
  });
});
