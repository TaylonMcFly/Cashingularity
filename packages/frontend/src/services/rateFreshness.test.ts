import { describe, expect, it } from "vitest";
import { createDefaultFxQuoteLock } from "@cashingularity/shared";
import {
  freshFxExpiry,
  hasFreshSpot,
  hasFreshSpotObservation,
  type FeedQuote,
} from "./rateFreshness.js";

describe("rate freshness", () => {
  const now = 1_800_000_000_000;
  const quote = (): FeedQuote => ({
    ...createDefaultFxQuoteLock(undefined, now),
    fxFetchedAtMs: now - 10_000,
    fxSource: "open.er-api.com",
    spotFetchedAtMs: now - 5_000,
    spotSource: "coinbase",
  });
  it("accepts independently timestamped live feeds and caps the lock at their freshness", () => {
    expect(hasFreshSpot(quote(), now)).toBe(true);
    expect(freshFxExpiry(quote(), now)).toBe(now + 50_000);
  });
  it("rejects missing, fallback, stale, future, and expired feed data", () => {
    for (const invalid of [
      { fxFetchedAtMs: undefined },
      { fxSource: "fallback" },
      { fxFetchedAtMs: now - 60_001 },
      { spotFetchedAtMs: now + 5_001 },
      { expiresAtMs: now },
    ]) {
      expect(freshFxExpiry({ ...quote(), ...invalid }, now)).toBeUndefined();
    }
    expect(hasFreshSpot({ ...quote(), spotSource: "fallback" }, now)).toBe(
      false,
    );
    expect(
      hasFreshSpotObservation(
        { price: 500, source: "binance", fetchedAtMs: now },
        now,
      ),
    ).toBe(true);
    expect(
      hasFreshSpotObservation(
        { price: 500, source: "fallback", fetchedAtMs: now },
        now,
      ),
    ).toBe(false);
  });
});
