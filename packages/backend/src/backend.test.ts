import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { compilePredictionPoolContract } from '@cashingularity/contracts-cashscript';
import { validateAndConvertCashAddr } from '@cashingularity/shared';
import { buildBackendServer, BackendServerContext } from './index.js';

const TEST_DATA_DIR = './.cashingularity-test-data';

describe('@cashingularity/backend - Fastify Market Engine, Payroll, Identity, Bridge & Read-Only AI', () => {
  it('rejects public contract preparation before consulting a wallet or chain service', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    try {
      const response = await ctx.app.inject({ method: 'POST', url: '/api/contracts/prepare',
        payload: { contractType: 'PREDICTION_STAKE', network: 'mainnet' } });
      expect(response.statusCode).toBe(403);
      expect(response.json().error).toMatch(/Paper Trading/);
    } finally {
      vi.unstubAllEnvs();
    }
  });
  let ctx: BackendServerContext;

  it('never serves third-party verification code from the wallet origin',async()=>{
    for(const ext of ['html','js','css']) {
      const response=await ctx.app.inject({method:'GET',url:`/verification-frame.${ext}`});
      expect(response.statusCode).toBe(404);
    }
  });

  it('exposes only recent paper orders in active rounds without wallet or receipt data', async () => {
    const now = Math.floor(Date.now() / 300_000) * 300_000 + 90_000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const url = '/api/markets?timeframe=5m';
      const { markets } = (await ctx.app.inject({ method: 'GET', url })).json();
      const current = markets.find((market: { isCurrentSlot?: boolean }) => market.isCurrentSlot);
      expect(current).toBeDefined();
      const stake = {
        stakeId: 'flow-test', marketId: current.marketId, bucketId: current.buckets[0].bucketId,
        stakeSats: 29_000n, predictorAddress: 'address-private', nftCommitmentHex: 'receipt-private',
        mode: 'SANDBOX_MODE' as const, txid: 'txid-private', createdAtMs: now - 1000,
      };
      ctx.store.insertStake({ ...stake, createdAtMs: now - 301_000 });
      ctx.store.insertStake({ ...stake, mode: 'MAINNET_MODE' });
      ctx.store.insertStake({ ...stake, marketId: current.marketId + 1 });
      ctx.store.insertStake({ ...stake, bucketId: 99 });
      ctx.store.insertStake(stake);
      const order = { id: '03730599-b96e-4772-8b85-14b0e3ae627b', bucketId: stake.bucketId, sats: '12100', expiryMs: current.expiryTimestampMs };
      const report = (payload = order) => ctx.app.inject({ method: 'POST', url: `/api/markets/${stake.marketId}/paper-flow`, payload });
      expect((await report()).statusCode).toBe(204);
      expect((await report()).statusCode).toBe(204);
      expect((await report({ ...order, id: '94653fa1-fa2b-4a11-b169-1303c170a253', expiryMs: now - 1000 })).statusCode).toBe(204);
      expect((await report({ ...order, sats: '-1000' })).statusCode).toBe(400);
      const response = await ctx.app.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(200);
      expect(response.json().paperBuys).toEqual([
        { id: order.id, marketId: stake.marketId, bucketId: order.bucketId, sats: order.sats, timestampMs: now },
        { id: expect.any(String), marketId: stake.marketId, bucketId: stake.bucketId, sats: '29000', timestampMs: stake.createdAtMs },
      ]);
    } finally {
      clock.mockRestore();
    }
  });

  it('validates bounded candle windows and returns the exact historical response without a live fetch', async () => {
    const endTimeMs = Date.now()-3600000;
    const window = {interval:'1m' as const,symbol:'BCH/USD',source:'binance' as const,candles:[],fetchedAtMs:Date.now()};
    const spy = vi.spyOn(ctx.priceFeed,'fetchCandleWindow').mockResolvedValue(window);
    try {
      const res=await ctx.app.inject({method:'GET',url:`/api/markets/candles?interval=1m&limit=10&endTimeMs=${endTimeMs}`});
      expect(res.statusCode).toBe(200);expect(res.json()).toEqual(window);expect(spy).toHaveBeenCalledWith('1m',10,endTimeMs);
      for (const invalid of ['NaN','1.2',String(Date.now()+86400000),String(Date.now()-9*86400000)]) {
        expect((await ctx.app.inject({method:'GET',url:`/api/markets/candles?endTimeMs=${invalid}`})).statusCode).toBe(400);
      }
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {spy.mockRestore();}
  });

  const oldAdmin = process.env.CASHINGULARITY_ADMIN_KEY;
  const oldXo = process.env.CASHINGULARITY_XO_RPC_KEY;
  beforeAll(async () => {
    process.env.CASHINGULARITY_ADMIN_KEY = 'audit-test-admin';
    process.env.CASHINGULARITY_XO_RPC_KEY = 'audit-test-xo';
    try {
      rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      // Ignore cleanup error before test
    }
    ctx = await buildBackendServer({ dataDir: TEST_DATA_DIR });
  });

  afterAll(async () => {
    await ctx.app.close();
    if (oldAdmin === undefined) delete process.env.CASHINGULARITY_ADMIN_KEY; else process.env.CASHINGULARITY_ADMIN_KEY = oldAdmin;
    if (oldXo === undefined) delete process.env.CASHINGULARITY_XO_RPC_KEY; else process.env.CASHINGULARITY_XO_RPC_KEY = oldXo;
    try {
      rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // Ignore Windows file lock on teardown
    }
  });

  it('serves /api/health and /api/rates with 60s FX quote lock and EWMA volatility cone', async () => {
    const healthRes = await ctx.app.inject({ method: 'GET', url: '/api/health' });
    expect(healthRes.statusCode).toBe(200);
    const health = healthRes.json();
    expect(health.status).toBe('ok');
    expect(health.marketCount).toBeGreaterThanOrEqual(2);

    const ratesRes = await ctx.app.inject({ method: 'GET', url: '/api/rates?horizonSeconds=300' });
    expect(ratesRes.statusCode).toBe(200);
    const rates = ratesRes.json();
    for (const curr of ['USD', 'EUR', 'KZT', 'RUB', 'GBP', 'USDT', 'PUSD', 'BCH']) {
      expect(rates.quoteLock.ratesToBch[curr]).toBeGreaterThan(0);
    }
    expect(rates.volatilityCone.length).toBeGreaterThan(10);
  });

  it('creates a curated admin market, rejects unauthenticated market spam, and serves BCH/USD OHLCV candles', async () => {
    const unauthRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/markets',
      payload: {
        title: 'Spam Unauthenticated Market',
        description: 'Should be rejected',
        strikePriceCents: 55_000,
        durationSeconds: 300,
      },
    });
    expect(unauthRes.statusCode).toBe(403);

    const candlesRes = await ctx.app.inject({
      method: 'GET',
      url: '/api/markets/candles?interval=5m&limit=24',
    });
    expect(candlesRes.statusCode).toBe(200);
    const candlesJson = candlesRes.json();
    expect(candlesJson.interval).toBe('5m');
    expect(candlesJson.candles.length).toBeGreaterThanOrEqual(10);
    expect(candlesJson.candles[0].open).toBeGreaterThan(0);

    const createRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/markets',
      headers: { 'x-admin-key': 'audit-test-admin' },
      payload: {
        title: 'Custom 3-Day BCH Hashrate Milestone',
        description: 'Configurable 72-hour event market',
        strikePriceCents: 55_000,
        durationSeconds: 259_200,
        bucketLabels: ['BELOW TARGET', 'ABOVE TARGET'],
        initialBucketsSats: ['500000', '500000'],
      },
    });
    expect(createRes.statusCode).toBe(200);
    const createdMarket = createRes.json().market;
    expect(createdMarket.durationSeconds).toBe(259_200);
    expect(createdMarket.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(createdMarket.slug).toBeTruthy();

    // Verify GET /api/markets/:idOrSlug resolves by slug, UUID id, and numeric marketId
    for (const lookup of ['bchusd-5m-flash', 'bchusd-1h-breakout', 'bchusd-24h-range']) {
      const slugRes = await ctx.app.inject({ method: 'GET', url: `/api/markets/${lookup}` });
      expect(slugRes.statusCode).toBe(200);
      expect(slugRes.json().market.slug).toBe(lookup);
      expect(slugRes.json().market.id).toMatch(/^[0-9a-f-]{36}$/i);
    }
    const uuidLookupRes = await ctx.app.inject({
      method: 'GET',
      url: `/api/markets/${createdMarket.id}`,
    });
    expect(uuidLookupRes.statusCode).toBe(200);
    expect(uuidLookupRes.json().market.marketId).toBe(createdMarket.marketId);

    const missingMarketRes = await ctx.app.inject({
      method: 'GET',
      url: '/api/markets/non-existent-slug',
    });
    expect(missingMarketRes.statusCode).toBe(404);

    // Verify rolling wall-clock epochs (5m, 1h, 24h) spanning up to 7d past & 24h future with human slotLabels
    const allMarketsRes = await ctx.app.inject({ method: 'GET', url: '/api/markets' });
    expect(allMarketsRes.statusCode).toBe(200);
    const allPayload = allMarketsRes.json();
    expect(allPayload.epochsMeta.retentionDays).toBe(7);
    expect(allPayload.epochsMeta.futureHorizonHours).toBe(24);
    const allMarkets = allPayload.markets as Array<{
      slug: string;
      slotLabel?: string;
      timeframe?: string;
      status: string;
      expiryTimestampMs: number;
      isHistoricalSlot?: boolean;
      isFutureSlot?: boolean;
      isCurrentSlot?: boolean;
      resolutionPriceCents?: number;
    }>;

    const nowMs = Date.now();
    const historical5m = allMarkets.filter(
      (m) => m.timeframe === '5m' && m.isHistoricalSlot
    );
    const futureHourly = allMarkets.filter(
      (m) => m.timeframe === '1h' && m.isFutureSlot
    );
    const weekOldDaily = allMarkets.filter(
      (m) =>
        m.timeframe === '24h' &&
        m.isHistoricalSlot &&
        nowMs - m.expiryTimestampMs >= 5 * 86_400_000
    );

    expect(historical5m.length).toBeGreaterThanOrEqual(6);
    expect(historical5m.every((m) => m.status !== 'RESOLVED' || (m.resolutionPriceCents ?? 0) > 0)).toBe(true);
    expect(allMarkets[0].slotLabel).toMatch(/\d{1,2}:\d{2}\s[AP]M/);
    expect(futureHourly.some((m) => m.expiryTimestampMs - nowMs >= 20 * 3_600_000)).toBe(true);
    expect(weekOldDaily.length).toBeGreaterThanOrEqual(1);

    // Also verify deep lookup by dynamic rolling time-indexed slug
    const dynamicSlugRes = await ctx.app.inject({
      method: 'GET',
      url: `/api/markets/${historical5m[0].slug}`,
    });
    expect(dynamicSlugRes.statusCode).toBe(200);
    expect(dynamicSlugRes.json().market.slug).toBe(historical5m[0].slug);
    expect(['OPEN', 'LOCKED', 'RESOLVED']).toContain(dynamicSlugRes.json().market.status);

    const stakeRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/markets/${createdMarket.marketId}/stake`,
      payload: {
        bucketId: 1,
        stakeSats: '50000',
        mode: 'SANDBOX_MODE',
      },
    });
    expect(stakeRes.statusCode).toBe(200);
    const stakeData = stakeRes.json();
    expect(stakeData.market.totalPoolSats).toBe('1050000');
    expect(stakeData.dagInspection.inputs).toHaveLength(2);
    expect(stakeData.dagInspection.outputs[1].decodedCommitment.stakeSats).toBe('50000');
    expect(stakeData.wizardSignRequest.inputPaths).toEqual([
      [0, 'defi', 0],
      [1, 'receive', 0],
    ]);
    expect(stakeData.position.positionId).toContain(`pos-${createdMarket.marketId}-`);
    expect(stakeData.position.status).toBe('OPEN');
    expect(stakeData.position.bucketLabel).toBe('ABOVE TARGET');

    const posListRes = await ctx.app.inject({
      method: 'GET',
      url: `/api/markets/positions?marketId=${createdMarket.marketId}`,
    });
    expect(posListRes.statusCode).toBe(200);
    expect(posListRes.json().positions.length).toBeGreaterThanOrEqual(1);

    const settleRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/markets/positions/${stakeData.position.positionId}/settle`,
      payload: {},
    });
    expect(settleRes.statusCode).toBe(403);
  });

  it('keeps spot price unaltered across ticks, exposes FX freshness metadata, and auto-settles expired positions', async () => {
    const t1 = ctx.priceFeed.stepTick();
    const t2 = ctx.priceFeed.stepTick(t1.timestampMs + 1000);
    expect(t2.bchUsdSpot).toBe(t1.bchUsdSpot);
    expect(t2.spotPriceCents).toBe(Math.round(t2.bchUsdSpot * 100));

    const ratesRes = await ctx.app.inject({ method: 'GET', url: '/api/rates' });
    expect(ratesRes.statusCode).toBe(200);
    const ratesJson = ratesRes.json();
    expect(ratesJson).toHaveProperty('fxSource');
    expect(ratesJson).toHaveProperty('fxFetchedAtMs');
    expect(ratesJson).toHaveProperty('spotSource');
    expect(ratesJson).toHaveProperty('spotFetchedAtMs');
    expect(ratesJson.quoteLock.fxSource).toBe(ratesJson.fxSource);
    expect(Array.isArray(ratesJson.recentTicks)).toBe(true);
    expect(ratesJson.recentTicks.length).toBeGreaterThanOrEqual(60);
    expect(typeof ratesJson.recentTicks[0].timestampMs).toBe('number');
    expect(typeof ratesJson.recentTicks[0].priceUsd).toBe('number');

    const marketDetailRes = await ctx.app.inject({
      method: 'GET',
      url: '/api/markets/bchusd-5m-flash',
    });
    expect(marketDetailRes.statusCode).toBe(200);
    const marketDetail = marketDetailRes.json();
    expect(Array.isArray(marketDetail.recentTicks)).toBe(true);
    expect(marketDetail.recentTicks.length).toBeGreaterThanOrEqual(60);
    expect(marketDetail.market.strikePriceCents).toBeGreaterThan(0);

    const expiredStake = await ctx.app.inject({
      method: 'POST',
      url: '/api/markets/1/stake',
      payload: {
        bucketId: 0,
        stakeSats: '15000',
        mode: 'SANDBOX_MODE',
        expiresAtMs: Date.now() - 1_000,
      },
    });
    expect(expiredStake.statusCode).toBe(400);
    expect(expiredStake.json().error).toContain('expiry');
  });

  it('parses batch payroll, schedules nLockTime jobs, verifies Nostr-BCH identity, and quotes PUSD bridge', async () => {
    const parseRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/payroll/parse',
      payload: {
        rawText: 'bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a - $250.00 - Dev Bounty',
      },
    });
    expect(parseRes.statusCode).toBe(200);
    expect(parseRes.json().allValid).toBe(true);

    const schedRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/payroll/schedule',
      payload: {
        nLockTime: 880_000,
        signedTxHex: '0200000001deadbeef',
        totalSats: '50000000',
        recipientCount: 1,
      },
    });
    expect(schedRes.statusCode).toBe(200);
    expect(schedRes.json().job.status).toBe('PENDING_LOCKTIME');

    const nostrRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/identity/verify',
      payload: {
        cashAddrZ: 'bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a',
        npub: 'npub1cashingularityblaze2026xyz',
        timestamp: 1763200000,
        nonce: 'nonce-99',
      },
    });
    expect(nostrRes.statusCode).toBe(200);
    const proof = nostrRes.json().proof;
    expect(proof.cashAddrZ.startsWith('bitcoincash:z')).toBe(true);
    expect(proof.verified).toBe(false);

    const bridgeRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/bridge/quote',
      payload: {
        direction: 'BCH_TO_EVM',
        sourceToken: 'PUSD',
        targetToken: 'USDC',
        inputAmountUnits: '100000000',
        bchAddress: proof.cashAddrZ,
        evmAddress: '0x1111111111111111111111111111111111111111',
      },
    });
    expect(bridgeRes.statusCode).toBe(200);
    expect(bridgeRes.json().quote.outputAmountUnits).toBe('99850000');
  });

  it('enforces read-only AI security boundaries and exports valid PKZIP analytics archive', async () => {
    const safeAiRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/ai/analyze',
      payload: {
        mode: 'LOCAL',
        txSummary: {
          inputCount: 2,
          outputCount: 3,
          minerFeeSats: 360,
          minOutputSats: 546,
          addressReuseDetected: false,
          bcmrVerified: true,
        },
      },
    });
    expect(safeAiRes.statusCode).toBe(200);
    expect(safeAiRes.json().aiVerdict).toBe('SAFE');
    expect(safeAiRes.json().suggestedOnly).toBe(true);

    // Must reject any payload leaking mnemonic or privateKey
    const leakedSecretRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/ai/analyze',
      payload: {
        mode: 'CLOUD_API',
        rawInspectJson: {
          mnemonic: 'placeholder for a recovery phrase',
        },
      },
    });
    expect(leakedSecretRes.statusCode).toBe(400);
    expect(leakedSecretRes.json().error).toContain('Security Boundary Violation');

    const zipRes = await ctx.app.inject({
      method: 'GET',
      url: '/api/analytics/export-zip',
    });
    expect(zipRes.statusCode).toBe(200);
    expect(zipRes.headers['content-type']).toBe('application/zip');
    // Check PK\x03\x04 magic bytes
    expect(zipRes.rawPayload[0]).toBe(0x50);
    expect(zipRes.rawPayload[1]).toBe(0x4b);
  });

  it('serves SPA frontend routes and rejects unauthenticated or fabricated XO sidecar results', async () => {
    for (const route of ['/', '/market', '/wallet', '/settings', '/batch']) {
      const spaRes = await ctx.app.inject({ method: 'GET', url: route });
      expect(spaRes.statusCode).toBe(200);
      expect(spaRes.headers['content-type']).toContain('text/html');
      expect(spaRes.body).toContain('Cashingularity');
    }

    for (const asset of ['/logo-market.png', '/logo-wallet.png']) {
      const pngRes = await ctx.app.inject({ method: 'GET', url: asset });
      expect(pngRes.statusCode).toBe(200);
      expect(pngRes.headers['content-type']).toBe('image/png');
      expect(pngRes.rawPayload.length).toBeGreaterThan(100_000);
    }

    const unauth = await ctx.app.inject({ method: 'POST', url: '/api/xo/rpc', payload: { method: 'wallet.getReceiveAddress' } });
    expect(unauth.statusCode).toBe(403);
    const simulation = await ctx.app.inject({ method: 'POST', url: '/api/xo/rpc', headers: { 'x-xo-key': 'audit-test-xo' }, payload: { id: 'offline', method: 'wallet.openChipnetAccount', params: { skipLiveEngine: true } } });
    expect(simulation.json().error.message).toContain('simulated RPC results are disabled');
    expect(simulation.json().result).toBeUndefined();
  }, 15_000);

  it('proxies and validates /api/bcmr/:categoryId with 64-char hex validation and zero 502 errors', async () => {
    const marketsRes = await ctx.app.inject({ method: 'GET', url: '/api/markets' });
    const firstMarketCategory = marketsRes.json().markets[0].categoryId as string;
    expect(firstMarketCategory).toMatch(/^[0-9a-f]{64}$/i);

    const validBcmrRes = await ctx.app.inject({
      method: 'GET',
      url: `/api/bcmr/${firstMarketCategory}`,
    });
    expect(validBcmrRes.statusCode).toBe(200);
    expect(validBcmrRes.json().isVerified).toBe(false);
    expect(validBcmrRes.json().categoryId).toBe(firstMarketCategory);

    // Truncated or non-hex categoryId must return clean 200 fallback without hitting upstream
    const truncatedRes = await ctx.app.inject({
      method: 'GET',
      url: '/api/bcmr/9aa80f3_',
    });
    expect(truncatedRes.statusCode).toBe(200);
    expect(truncatedRes.json().isVerified).toBe(false);
  });

  it('rejects premature administrative resolution and never fabricates oracle signatures', () => {
    const market = ctx.marketEngine.createMarket({ title: 'Audit resolution check', description: 'Audit fixture', strikePriceCents: 20000, durationSeconds: 10 });
    expect(() => ctx.marketEngine.resolveMarket({ marketId: market.marketId, winningBucketId: 1, resolutionPriceCents: 21000 })).toThrow(/not expired/);
    ctx.store.upsertMarket({ ...market, expiryTimestampMs: Date.now() - 1 });
    expect(() => ctx.marketEngine.resolveMarket({ marketId: market.marketId, winningBucketId: 1, resolutionPriceCents: NaN })).toThrow(/valid resolution/);
    const resolved = ctx.marketEngine.resolveMarket({ marketId: market.marketId, winningBucketId: 1, resolutionPriceCents: 21000 });
    expect(resolved.status).toBe('RESOLVED');
    expect(resolved.resolutionSignatureHex).toBeUndefined();
  });

  it('keeps reviewed epoch targets fixed as the live spot changes', () => {
    const nowMs = Date.now();
    const before = ctx.marketEngine.getCuratedMarketsWithLiveSpot(201, { nowMs }).filter(m => m.marketId <= 3);
    const after = ctx.marketEngine.getCuratedMarketsWithLiveSpot(250, { nowMs }).filter(m => m.marketId <= 3);
    expect(after.map(m => m.strikePriceCents)).toEqual(before.map(m => m.strikePriceCents));
    expect(after.map(m => m.buckets.map(b => b.label))).toEqual(before.map(m => m.buckets.map(b => b.label)));
  });

  it('rejects unsafe admin, origin, market, and malformed chain requests before remote work', async () => {
    for (const url of ['/api/markets/1/resolve', '/api/markets/positions/unknown/settle']) {
      const response = await ctx.app.inject({ method: 'POST', url, payload: {} });
      expect(response.statusCode).toBe(403);
    }
    const origin = await ctx.app.inject({ method: 'POST', url: '/api/payroll/parse', headers: { origin: 'https://attacker.example' }, payload: { rawText: '' } });
    expect(origin.statusCode).toBe(403);
    const unknown = await ctx.app.inject({ method: 'POST', url: '/api/contracts/prepare', payload: { address: 'bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a', marketId: 999999999, contractType: 'PREDICTION_STAKE' } });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().error).toContain('Unknown market');
    const candles = await ctx.app.inject({ method: 'GET', url: '/api/markets/candles?limit=NaN' });
    expect(candles.statusCode).toBe(400);
    for (const url of ['/api/chain/broadcast', '/api/broadcast']) {
      const malformed = await ctx.app.inject({ method: 'POST', url, payload: { rawTxHex: '00', network: 'chipnet' } });
      expect(malformed.statusCode).toBe(400);
      expect(malformed.json().txid).toBeUndefined();
    }
    const utxos = await ctx.app.inject({ method: 'GET', url: '/api/chain/utxos?address=invalid' });
    expect(utxos.statusCode).toBe(400);
    const historyInvalid = await ctx.app.inject({ method: 'GET', url: '/api/chain/history?address=invalid' });
    expect(historyInvalid.statusCode).toBe(400);

    // Structured bucket bounds parity on curated 5m, 1h, and 24h markets
    const curatedRes = await ctx.app.inject({ method: 'GET', url: '/api/markets' });
    const curatedMarkets = curatedRes.json().markets as Array<{
      marketId: number;
      buckets: Array<{ outcomeRule?: string; lowerBoundCents?: number; upperBoundCents?: number }>;
    }>;
    const m5 = curatedMarkets.find((m) => m.marketId === 1)!;
    expect(m5.buckets[0].outcomeRule).toBe('BELOW');
    expect(m5.buckets[0].upperBoundCents).toBeGreaterThan(0);
    expect(m5.buckets[1].outcomeRule).toBe('ABOVE');
    expect(m5.buckets[1].lowerBoundCents).toBe(m5.buckets[0].upperBoundCents);
    const m24 = curatedMarkets.find((m) => m.marketId === 3)!;
    expect(m24.buckets.map((b) => b.outcomeRule)).toEqual(['BELOW', 'RANGE', 'ABOVE']);
    expect(m24.buckets[1].lowerBoundCents).toBe(m24.buckets[0].upperBoundCents);
    expect(m24.buckets[2].lowerBoundCents).toBe((m24.buckets[1].upperBoundCents ?? 0) + 1);
    const mainnet = await ctx.app.inject({ method: 'POST', url: '/api/markets/1/stake', payload: { bucketId: 1, stakeSats: '10000', mode: 'MAINNET_MODE' } });
    expect(mainnet.statusCode).toBe(400);
    const openPosition = ctx.marketEngine.listPositions().find(p => p.status === 'OPEN' && p.expiresAtMs > Date.now());
    expect(openPosition).toBeDefined();
    expect(() => ctx.marketEngine.settlePosition({ positionId: openPosition!.positionId, settlementSpotUsd: 999, requireExpired: false })).toThrow(/not expired/);
    expect(ctx.marketEngine.autoSettleExpiredPositions(999, Date.now() + 10 * 86400_000)).toEqual([]);
  });

  it('prepares a 1,000-sat Mainnet stake using only the wallet outpoint and standard receipt dust', async () => {
    const missingAddr = await ctx.app.inject({
      method: 'POST',
      url: '/api/contracts/prepare',
      payload: { contractType: 'PREDICTION_STAKE' },
    });
    expect(missingAddr.statusCode).toBe(400);
    expect(missingAddr.json().error).toContain('address');

    const pool = compilePredictionPoolContract({
      marketId: 1,
      bucketId: 1,
      predictorPkhHex: '76a04053bda0a88bda5177b86a15c3b29f559873',
      network: 'chipnet',
    });
    expect(pool.covenantProof.covenantSemantics).toBe('USER_FUNDED_ESCROW_TICKET');

    const address = 'bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a';
    const tokenAddress = validateAndConvertCashAddr(address).tokenAwareAddress!;
    const txid = '77'.repeat(32);
    const funding = {
      address, tokenAwareAddress: tokenAddress, network: 'mainnet' as const,
      scriptHash: 'aa'.repeat(32), source: 'fixture',
      confirmedSats: 3000n, unconfirmedSats: 0n, totalBalanceSats: 3000n,
      utxos: [{ txid, vout: 0, address, tokenAddress, satoshis: 3000n, isGenesisCapable: true,
        derivationScope: 'receive' as const, addressIndex: 0 }],
    };
    const lookup = vi.spyOn(ctx.bchNetwork, 'fetchAddressUtxos').mockResolvedValue(funding);
    const review = () => ctx.app.inject({
      method: 'POST', url: '/api/contracts/prepare',
      payload: { contractType: 'PREDICTION_STAKE', marketId: 1, bucketId: 0, network: 'mainnet', address, stakeSats: '1000' },
    });
    try {
      const response = await review();
      expect(response.statusCode, response.body).toBe(200);
      const { dag, transactionTemplate } = response.json();
      expect(dag.inputs).toEqual([expect.objectContaining({ txid, vout: 0, satoshis: '3000' })]);
      expect(dag.outputs.map((output: { satoshis: string }) => output.satoshis)).toEqual(['1000', '690', '890']);
      expect(dag.outputs[0]).toMatchObject({ scriptType: 'P2SH32', isChange: false });
      expect(dag.outputs[1].token).toMatchObject({ categoryId: txid, amount: '0', nft: { capability: 'none', commitment: '000000010000000000000003e8' } });
      expect(dag.audit.minerFeeSats).toBe('420');
      expect(transactionTemplate.transaction.outputs.map((output: { valueSatoshis: string }) => output.valueSatoshis))
        .toEqual(['1000', '690', '890']);

      lookup.mockResolvedValueOnce({ ...funding, utxos: [{ ...funding.utxos[0], vout: 1, isGenesisCapable: false }] });
      const withoutGenesis = await review();
      expect(withoutGenesis.statusCode, withoutGenesis.body).toBe(200);
      expect(withoutGenesis.json().dag.outputs).toEqual([
        expect.objectContaining({ satoshis: '1000', scriptType: 'P2SH32' }),
        expect.objectContaining({ satoshis: '1580', isChange: true }),
      ]);
    } finally {
      lookup.mockRestore();
    }
  });

  it('enforces security headers, bounded integer parsing, and zero persistence on rejected epoch stakes', async () => {
    const healthRes = await ctx.app.inject({ method: 'GET', url: '/api/health' });
    expect(healthRes.statusCode).toBe(200);
    expect(healthRes.headers['x-content-type-options']).toBe('nosniff');
    expect(healthRes.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(healthRes.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(healthRes.headers['permissions-policy']).toBe('camera=(), microphone=(), geolocation=()');

    const badBridge = await ctx.app.inject({
      method: 'POST',
      url: '/api/bridge/quote',
      payload: { inputAmountUnits: 'not-a-bigint' },
    });
    expect(badBridge.statusCode).toBe(400);

    const overflowBridge = await ctx.app.inject({
      method: 'POST',
      url: '/api/bridge/quote',
      payload: { inputAmountUnits: '99999999999999999999' },
    });
    expect(overflowBridge.statusCode).toBe(400);

    const overflowStake = await ctx.app.inject({
      method: 'POST',
      url: '/api/markets/1/stake',
      payload: { bucketId: 1, stakeSats: '2100000000000001' },
    });
    expect(overflowStake.statusCode).toBe(400);

    const badTxidStake = await ctx.app.inject({
      method: 'POST',
      url: '/api/markets/1/stake',
      payload: { bucketId: 1, stakeSats: '10000', txid: 'deadbeef' },
    });
    expect(badTxidStake.statusCode).toBe(400);

    const badAddrStake = await ctx.app.inject({
      method: 'POST',
      url: '/api/markets/1/stake',
      payload: { bucketId: 1, stakeSats: '10000', predictorAddress: 'bitcoincash:invalidaddr' },
    });
    expect(badAddrStake.statusCode).toBe(400);

    const marketsRes = await ctx.app.inject({ method: 'GET', url: '/api/markets?timeframe=5m' });
    const live5m = (marketsRes.json().markets as Array<{ slug?: string; marketId: number }>).find(
      (m) => m.slug && m.slug.startsWith('bchusd-5m-') && m.marketId > 3
    );
    if (live5m?.slug) {
      const persistedBefore = ctx.store.listMarkets().some((m) => m.marketId === live5m.marketId);
      const rejectedEpochStake = await ctx.app.inject({
        method: 'POST',
        url: `/api/markets/${live5m.slug}/stake`,
        payload: { bucketId: 1, stakeSats: '10000', mode: 'MAINNET_MODE' },
      });
      expect(rejectedEpochStake.statusCode).toBe(400);
      const persistedAfter = ctx.store.listMarkets().some((m) => m.marketId === live5m.marketId);
      expect(persistedAfter).toBe(persistedBefore);
    }

    const badPayroll = await ctx.app.inject({
      method: 'POST',
      url: '/api/payroll/schedule',
      payload: { nLockTime: 100, signedTxHex: 'zz-not-hex', totalSats: '10000', recipientCount: 1 },
    });
    expect(badPayroll.statusCode).toBe(400);

    const clampedRates = await ctx.app.inject({
      method: 'GET',
      url: '/api/rates?horizonSeconds=999999999',
    });
    expect(clampedRates.statusCode).toBe(200);
    expect(Array.isArray(clampedRates.json().volatilityCone)).toBe(true);
  });
});
