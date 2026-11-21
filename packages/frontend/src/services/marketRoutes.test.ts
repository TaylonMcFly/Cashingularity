import { describe, expect, it } from "vitest";
import type { ConfigurableMarket } from "@cashingularity/shared";
import {
  findMarketBySlug,
  marketSlug,
  parseMarketSlug,
  liveMarketSlug,
  parseRollingMarketSlug,
} from "./marketRoutes.js";
import { parseWorkspacePath, WORKSPACES } from './workspaceRoutes.js';

describe("market links", () => {
  it("keeps curated slugs stable when spot-dependent titles change", () => {
    const market = {
      marketId: 1,
      durationSeconds: 300,
      title: "BCH > $500",
    } as ConfigurableMarket;
    expect(marketSlug(market)).toBe("bchusd-5m-flash");
    expect(marketSlug({ ...market, title: "BCH > $800" })).toBe(
      "bchusd-5m-flash",
    );
    expect(findMarketBySlug([market], "market-1")).toBe(market);
  });
  it("accepts valid supplied slugs and falls back to a unique market ID", () => {
    const market = { marketId: 42, durationSeconds: 300 } as ConfigurableMarket;
    expect(
      marketSlug({ ...market, slug: "custom-market" } as ConfigurableMarket),
    ).toBe("custom-market");
    expect(
      marketSlug({ ...market, slug: "../unsafe" } as ConfigurableMarket),
    ).toBe("market-42");
    expect(marketSlug({ ...market, marketId: 43 })).toBe("market-43");
  });
  it("parses market links without treating other paths as market slugs", () => {
    expect(parseMarketSlug("/market/bchusd-5m-flash")).toBe("bchusd-5m-flash");
    expect(parseMarketSlug("/market/bchusd-5m-flash/")).toBe("bchusd-5m-flash");
    expect(parseMarketSlug("/market/a/b")).toBeNull();
    expect(parseMarketSlug("/wallet")).toBeNull();
  });
  it('puts Wallet first and restores legacy and market routes from the pathname', () => {
    expect(WORKSPACES.map(workspace => workspace.label)).toEqual(['Wallet', 'Market', 'Arcade', 'Settings']);
    for (const path of ['/', '/wallet', '/wallet/', '/index.html']) expect(parseWorkspacePath(path).route).toBe('/wallet');
    expect(parseWorkspacePath('/batch')).toEqual({ route: '/wallet', marketSlug: null, batch: true });
    expect(parseWorkspacePath('/market/bchusd-1m')).toEqual({ route: '/market', marketSlug: 'bchusd-1m', batch: false });
    expect(parseWorkspacePath('/settings').route).toBe('/settings');
  });
  it('keeps rolling market links stable while archived links retain their inspection time', () => {
    const minute = { marketId: 100_000_001, durationSeconds: 60, epochSeriesId: 'bchusd-1m', slug: 'bchusd-1m-1800000000' } as ConfigurableMarket;
    expect(liveMarketSlug(minute)).toBe('bchusd-1m');
    expect(parseRollingMarketSlug(minute.slug!)).toEqual({ timeframe: '1m', expiryMs: 1_800_000_000_000 });
    expect(parseRollingMarketSlug(liveMarketSlug(minute))).toEqual({ timeframe: '1m' });
    expect(liveMarketSlug({ ...minute, epochSeriesId: undefined })).toBe(minute.slug);
  });
});
