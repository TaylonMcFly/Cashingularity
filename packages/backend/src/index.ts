import { registerAuthRoutes } from './authService.js';
import { createBotVerificationServer } from './botVerificationServer.js';
/**
 * @cashingularity/backend - Fastify + WebSocket + Single-Origin Static UI + Atomic WAL Server (Port 3000)
 * BCH BLAZE 2026
 */

import {
  buildVerifiableContractTransaction,
  compileInactivityVaultContract,
  compilePredictionPoolContract,
  compilePullRewardClaimContract,
  extractPkhHexFromCashAddr,
  INACTIVITY_VAULT_CONTRACT,
  PREDICTION_POOL_CONTRACT,
  PULL_REWARD_CLAIM_CONTRACT,
} from '@cashingularity/contracts-cashscript';
import {
  AiExecutionMode,
  BchNetwork,
  CovenantProof,
  DUST_LIMIT_SATS,
  encodeNftReceiptCommitment,
  ExecutionMode,
  isMarketOpenAt,
  MARKET_FLOW_WINDOW_MS,
  type MarketBuy,
  NostrBchIdentityProof,
  parsePayrollText,
  PusdBridgeQuote,
  ScheduledPayrollJob,
  validateAndConvertCashAddr,
  WalletUtxo,
} from '@cashingularity/shared';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import Fastify, { FastifyInstance, FastifyReply } from 'fastify';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AiAnalysisRequest, AiAnalyticsService } from './aiService.js';
import { BchNetworkService } from './bchNetworkService.js';
import { registerWalletSync } from './electrumWalletSync.js';
import { CashingularityWalStore } from './db.js';
import { ConfigurableMarketEngine, EPOCH_RETENTION_DAYS, MarketTimeframe } from './marketEngine.js';
import { CandleInterval, PriceFeedService } from './priceFeed.js';
import { registerRocketRace } from './rocketRace.js';
import { registerOnlineRacing } from './rocketRaceOnline.js';

export interface BackendServerContext {
  app: FastifyInstance;
  store: CashingularityWalStore;
  priceFeed: PriceFeedService;
  marketEngine: ConfigurableMarketEngine;
  aiService: AiAnalyticsService;
  bchNetwork: BchNetworkService;
}

const MAX_BCH_SUPPLY_SATS = 2_100_000_000_000_000n;
const MAX_CACHE_ENTRIES = 500;

function parseBoundedBigInt(
  raw: unknown,
  fieldName: string,
  minVal = 1n,
  maxVal = MAX_BCH_SUPPLY_SATS
): bigint {
  let value: bigint;
  if (typeof raw === 'bigint') {
    value = raw;
  } else if (typeof raw === 'number') {
    if (!Number.isSafeInteger(raw)) {
      throw new Error(`${fieldName} must be a safe integer value.`);
    }
    value = BigInt(raw);
  } else if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!/^\d{1,16}$/.test(trimmed)) {
      throw new Error(`${fieldName} must be an unsigned decimal integer string.`);
    }
    value = BigInt(trimmed);
  } else {
    throw new Error(`${fieldName} must be a numeric satoshi integer.`);
  }
  if (value < minVal || value > maxVal) {
    throw new Error(
      `${fieldName} (${value.toString()}) must be between ${minVal.toString()} and ${maxVal.toString()}.`
    );
  }
  return value;
}

function sanitizeHttpsUri(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 512) return undefined;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'https:' ? parsed.toString() : undefined;
  } catch {
    return undefined;
  }
}

function setBoundedMapEntry<V>(cache: Map<string, V>, key: string, value: V): void {
  if (!cache.has(key) && cache.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) {
      cache.delete(oldestKey);
    }
  }
  cache.set(key, value);
}

/**
 * Serializes all BigInt fields as exact decimal strings over HTTP/WebSocket JSON boundaries.
 */
function safeJsonStringify(payload: unknown): string {
  return JSON.stringify(payload, (_key, value) =>
    typeof value === 'bigint' ? value.toString() : value
  );
}

function resolveFrontendDistDir(): string | null {
  const currentFileDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(process.cwd(), 'packages/frontend/dist'),
    path.resolve(currentFileDir, '../../frontend/dist'),
    path.resolve(currentFileDir, '../frontend/dist'),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'index.html'))) {
      return dir;
    }
  }
  return null;
}

export async function buildBackendServer(options?: {
  dataDir?: string;
  onlineRacing?: Parameters<typeof registerOnlineRacing>[2];
}): Promise<BackendServerContext> {
  const proxyIps = (process.env.CASHINGULARITY_TRUST_PROXY_IPS ?? '').split(',').map(ip => ip.trim()).filter(Boolean);
  const app = Fastify({ logger: false, bodyLimit: 262_144, trustProxy: proxyIps.length ? proxyIps : false });

  app.setReplySerializer((payload) => safeJsonStringify(payload));
  app.setErrorHandler((err, _request, reply) => {
    const rawStatus =
      err && typeof err === 'object' ? (err as { statusCode?: unknown }).statusCode : undefined;
    const statusCode =
      typeof rawStatus === 'number' && rawStatus >= 400 && rawStatus < 500 ? rawStatus : 500;
    const errMessage = err instanceof Error ? err.message : 'Invalid request.';
    reply.code(statusCode).send({
      error: statusCode >= 500 ? 'Internal server error.' : errMessage || 'Invalid request.',
    });
  });

  await app.register(cors, { origin: ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:4173', 'http://127.0.0.1:4173'] });
  app.addHook('onSend', async (_request, reply, payload) => {
    if (!reply.hasHeader('x-content-type-options')) {
      reply.header('X-Content-Type-Options', 'nosniff');
    }
    if (!reply.hasHeader('x-frame-options')) {
      reply.header('X-Frame-Options', 'SAMEORIGIN');
    }
    if (!reply.hasHeader('referrer-policy')) {
      reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    }
    if (!reply.hasHeader('permissions-policy')) {
      reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    }
    return payload;
  });
  app.addHook('preHandler', async (request, reply) => {
    if (request.method === 'POST' && request.url.startsWith('/api/') && (!request.body || typeof request.body !== 'object' || Array.isArray(request.body))) return reply.code(400).send({ error: 'A JSON object body is required.' });
    if (request.method === 'GET' || !request.url.startsWith('/api/') || !request.headers.origin) return;
    try { const origin = new URL(request.headers.origin); const host = new URL(`http://${request.headers.host}`).hostname; const loopback = (h: string) => ['localhost', '127.0.0.1', '[::1]'].includes(h); if (origin.hostname !== host && !(loopback(origin.hostname) && loopback(host))) return reply.code(403).send({error:'Cross-origin state changes are not allowed.'}); } catch { return reply.code(403).send({error:'Invalid request origin.'}); }
  });
  // The wallet uses an 8 KiB application limit. Limit inbound transport buffering too.
  await app.register(websocket, { options: { maxPayload: 32_768 } });

  const dataDir = options?.dataDir ?? './.cashingularity-data';
  const store = new CashingularityWalStore(dataDir);
  registerAuthRoutes(app, store, dataDir);
  registerRocketRace(app, dataDir);
  registerOnlineRacing(app, dataDir, options?.onlineRacing);
  const priceFeed = new PriceFeedService();
  const marketEngine = new ConfigurableMarketEngine(store);
  const aiService = new AiAnalyticsService();
  const bchNetwork = new BchNetworkService();

  // Dynamically load isolated `@cashingularity/contracts-xo` XoBridgeService
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let realXoBridge: any = null;
  async function getOrLoadRealXoBridge() {
    if (realXoBridge) return realXoBridge;
    const currentFileDir = path.dirname(fileURLToPath(import.meta.url));
    const candidates = [
      path.resolve(process.cwd(), 'packages/contracts-xo/dist/index.js'),
      path.resolve(currentFileDir, '../../contracts-xo/dist/index.js'),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        const mod = await import(pathToFileURL(candidate).href);
        if (mod.XoBridgeService) {
          realXoBridge = new mod.XoBridgeService();
          return realXoBridge;
        }
      }
    }
    return null;
  }

  // 1. Health & Status
  app.get('/api/health', async () => {
    const tick = priceFeed.getCurrentTick();
    return {
      status: 'ok',
      service: 'cashingularity-backend',
      timestampMs: Date.now(),
      bchUsdPrice: tick.bchUsdPrice,
      ewmaSigma: tick.ewmaSigma,
      marketCount: marketEngine.listMarkets().length,
    };
  });

  // 1B. Server-Side Paytaca BCMR Metadata Proxy & Cache (Zero Browser CORS / 502 Errors)
  const bcmrCache = new Map<
    string,
    {
      categoryId: string;
      name: string;
      symbol: string;
      decimals: number;
      description?: string;
      iconUri?: string;
      isVerified: boolean;
    }
  >([
    [
      'e9c70516ef03826067f128228d76f80f2704b311969dfca11bb4e461b5cf8757',
      {
        categoryId: 'e9c70516ef03826067f128228d76f80f2704b311969dfca11bb4e461b5cf8757',
        name: 'Parity USD Stablecoin',
        symbol: 'PUSD',
        decimals: 2,
        description: 'Paytaca Parity USD CashTokens Stablecoin on Bitcoin Cash Mainnet',
        isVerified: true,
      },
    ],
    [
      'b38a33f750f84c5c169a6f23cb873e6e79605021585d4f3408789689ed87f366',
      {
        categoryId: 'b38a33f750f84c5c169a6f23cb873e6e79605021585d4f3408789689ed87f366',
        name: 'Moria USD Stablecoin',
        symbol: 'MUSD',
        decimals: 2,
        description: 'Overcollateralized BCH CashTokens Stablecoin',
        isVerified: true,
      },
    ],
    [
      'f1d0c4582026f1d0c4582026f1d0c4582026f1d0c4582026f1d0c45820260001',
      {
        categoryId: 'f1d0c4582026f1d0c4582026f1d0c4582026f1d0c4582026f1d0c45820260001',
        name: 'FoldingCash Compute Reward Token',
        symbol: 'FLDCH',
        decimals: 8,
        description: 'Folding@Home biomedical compute reward token on Bitcoin Cash',
        isVerified: false,
      },
    ],
    [
      'eb202600eb202600eb202600eb202600eb202600eb202600eb202600eb202600',
      {
        categoryId: 'eb202600eb202600eb202600eb202600eb202600eb202600eb202600eb202600',
        name: 'BCH BLAZE 2026 Voting Token',
        symbol: 'EMBER2026',
        decimals: 0,
        description: 'Official BCH BLAZE 2026 People Choice & Judge Voting Token',
        isVerified: false,
      },
    ],
  ]);

  app.get('/api/bcmr/:categoryId', async (request) => {
    const { categoryId } = request.params as { categoryId: string };
    const cleanId = (categoryId ?? '').trim().toLowerCase();

    if (bcmrCache.has(cleanId)) {
      const cached = bcmrCache.get(cleanId)!;
      return {
        ...cached,
        verified: cached.isVerified,
        token: { symbol: cached.symbol, decimals: cached.decimals, category: cached.categoryId },
      };
    }

    // Check if categoryId belongs to one of our active prediction markets
    const marketMatch = marketEngine
      .listMarkets()
      .find((m) => m.categoryId.toLowerCase() === cleanId);

      if (!/^[0-9a-f]{64}$/.test(cleanId) || marketMatch) {
      const localMeta = {
        categoryId: cleanId,
        name: marketMatch
          ? `Position Receipt — ${marketMatch.title}`
          : 'Cashingularity Position Receipt NFT',
        symbol: 'CSG-POS',
        decimals: 0,
        description: 'On-Chain CashTokens Prediction Position Receipt',
        isVerified: false,
        verified: false,
        token: { symbol: 'CSG-POS', decimals: 0, category: cleanId },
      };
      if (/^[0-9a-f]{64}$/.test(cleanId)) {
        setBoundedMapEntry(bcmrCache, cleanId, localMeta);
      }
      return localMeta;
    }

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1500);
      const upstream = await fetch(`https://bcmr.paytaca.com/api/tokens/${cleanId}/`, {
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (upstream.ok) {
        const data = (await upstream.json()) as {
          name?: string;
          token?: { symbol?: string; decimals?: number };
          description?: string;
          uris?: Record<string, string>;
        };
        const resolved = {
          categoryId: cleanId,
          name: data.name ?? 'CashToken',
          symbol: data.token?.symbol ?? 'TOKEN',
          decimals: data.token?.decimals ?? 0,
          description: data.description,
          iconUri: sanitizeHttpsUri(data.uris?.icon),
          isVerified: false,
          verified: false,
          token: {
            symbol: data.token?.symbol ?? 'TOKEN',
            decimals: data.token?.decimals ?? 0,
            category: cleanId,
          },
        };
        setBoundedMapEntry(bcmrCache, cleanId, resolved);
        return resolved;
      }
    } catch {
      // Upstream unreachable or 502; cache clean fallback
    }

    const fallback = {
      categoryId: cleanId,
      name: 'Unknown CashToken',
      symbol: 'UNKNOWN',
      decimals: 0,
      description: 'Token metadata unavailable',
      isVerified: false,
      verified: false,
      token: { symbol: 'UNKNOWN', decimals: 0, category: cleanId },
    };
    setBoundedMapEntry(bcmrCache, cleanId, fallback);
    return fallback;
  });

  // 2. Live Price, Volatility Cone & 60s FX Quote Lock
  app.get('/api/rates', async (request) => {
    const query = (request.query as { refresh?: string; horizonSeconds?: string }) ?? {};
    const forceRefresh = query.refresh === 'true';
    if (forceRefresh) {
      await priceFeed.refreshLiveRatesFromNetwork(true);
    }
    const recentTicks = await priceFeed.ensureRecentTicksPopulated(120);
    const quoteLock = priceFeed.getQuoteLock(false);
    const rawHorizon = Number(query.horizonSeconds);
    const horizon = Number.isFinite(rawHorizon)
      ? Math.min(86_400, Math.max(60, Math.trunc(rawHorizon)))
      : 300;
    const tick = priceFeed.stepTick();
    const volatilityCone = priceFeed.getVolatilityCone(horizon, 25);

    return {
      tick,
      recentTicks,
      quoteLock,
      volatilityCone,
      fxSource: quoteLock.fxSource,
      fxFetchedAtMs: quoteLock.fxFetchedAtMs,
      spotSource: quoteLock.spotSource,
      spotFetchedAtMs: quoteLock.spotFetchedAtMs,
    };
  });

  // 3. Curated Prediction Markets, Real BCH/USD Historical Candles & Position Settlement
  const ADMIN_MARKET_KEY =
    process.env.CASHINGULARITY_ADMIN_KEY || '';
  const paperFlow = new Map<string, MarketBuy>();
  const paperFlowRate = new Map<string, { resetMs: number; count: number }>();

  app.post('/api/markets/:id/paper-flow', (request, reply) => {
    const { id: marketId } = request.params as { id: string };
    const order = request.body as { id?: string; bucketId?: number; sats?: string; expiryMs?: number } | null;
    if (!order || typeof order.id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(order.id) ||
        !Number.isSafeInteger(order.bucketId) || !Number.isSafeInteger(order.expiryMs) || !/^\d{1,10}$/.test(marketId)) {
      return reply.code(400).send({ error: 'Invalid paper order.' });
    }
    try {
      const sats = parseBoundedBigInt(order.sats, 'sats', DUST_LIMIT_SATS);
      const nowMs = Date.now();
      const recent = paperFlowRate.get(request.ip);
      const limit = recent && recent.resetMs > nowMs ? recent : { resetMs: nowMs + 60_000, count: 0 };
      // Anonymous paper activity is advisory and bounded. It never modifies a market pool or wallet.
      if (limit.count >= 40 || paperFlow.has(order.id)) return reply.code(204).send();
      setBoundedMapEntry(paperFlowRate, request.ip, { ...limit, count: limit.count + 1 });
      const market = marketEngine.resolveMarketByIdOrSlug(marketId, priceFeed.getCurrentTick().bchUsdPrice, nowMs);
      const bucket = market?.buckets.find(item => item.bucketId === order.bucketId);
      if (market && bucket && isMarketOpenAt(market, nowMs) && market.expiryTimestampMs === order.expiryMs) {
        setBoundedMapEntry(paperFlow, order.id, { id: order.id, marketId: market.marketId, bucketId: bucket.bucketId, sats, timestampMs: nowMs });
      }
      return reply.code(204).send();
    } catch {
      return reply.code(400).send({ error: 'Invalid paper order amount.' });
    }
  });

  app.get('/api/markets', async (request) => {
    const query =
      (request.query as { timeframe?: string; extended?: string; includeExtended?: string }) ?? {};
    const tfParam = query.timeframe;
    const timeframe: MarketTimeframe | undefined =
      tfParam === '1m' || tfParam === '5m' || tfParam === '1h' || tfParam === '24h' ? tfParam : undefined;
    const includeExtended =
      query.extended === 'true' || query.includeExtended === 'true';

    const nowMs = Date.now();
    const oracles = await priceFeed.getHistoricalSettlementOracles();
    marketEngine.autoSettleExpiredPositions(
      oracles.latestSpotUsd,
      nowMs,
      oracles.findCloseUsdForTimestamp
    );
    const tick = priceFeed.getCurrentTick();
    const markets = marketEngine.getCuratedMarketsWithLiveSpot(tick.bchUsdPrice, {
      nowMs, oracles, timeframe, includeExtended,
    });
    const openMarkets = new Map(markets.filter(market => isMarketOpenAt(market, nowMs)).map(market => [market.marketId, market]));
    const paperBuys: MarketBuy[] = [];
    if (!includeExtended && openMarkets.size) {
      for (const order of paperFlow.values()) {
        const market = openMarkets.get(order.marketId);
        if (market && order.timestampMs >= market.createdAtMs && order.timestampMs >= nowMs - MARKET_FLOW_WINDOW_MS &&
            order.timestampMs <= nowMs && market.buckets.some(bucket => bucket.bucketId === order.bucketId)) paperBuys.push(order);
      }
      const stakes = store.listStakesByMarket();
      for (let index = stakes.length - 1, collected = 0; index >= 0 && collected < 96; index--) {
        const stake = stakes[index];
        if (stake.createdAtMs < nowMs - MARKET_FLOW_WINDOW_MS) break;
        const market = openMarkets.get(stake.marketId);
        if (stake.mode !== 'SANDBOX_MODE' || !market || stake.stakeSats <= 0n ||
            stake.createdAtMs < market.createdAtMs || stake.createdAtMs > nowMs ||
            !market.buckets.some(bucket => bucket.bucketId === stake.bucketId)) continue;
        paperBuys.push({
          id: `${stake.marketId}:${stake.createdAtMs}:${index}`, marketId: stake.marketId, bucketId: stake.bucketId,
          sats: stake.stakeSats, timestampMs: stake.createdAtMs,
        });
        collected++;
      }
    }
    return {
      markets,
      paperBuys: paperBuys.sort((a, b) => b.timestampMs - a.timestampMs).slice(0, 96).map(order => ({ ...order, sats: order.sats.toString() })),
      tick,
      positions: marketEngine.listPositions(),
      epochsMeta: {
        retentionDays: EPOCH_RETENTION_DAYS,
        futureHorizonHours: 24,
        candleOracleSource: oracles.source,
      },
    };
  });

  app.get('/api/markets/positions', async (request) => {
    const query =
      (request.query as {
        marketId?: string;
        status?: 'OPEN' | 'WON' | 'LOST';
        address?: string;
      }) ?? {};
    const nowMs = Date.now();
    const oracles = await priceFeed.getHistoricalSettlementOracles();
    const settledNow = marketEngine.autoSettleExpiredPositions(
      oracles.latestSpotUsd,
      nowMs,
      oracles.findCloseUsdForTimestamp
    );
    const positions = marketEngine.listPositions({
      marketId: query.marketId !== undefined ? Number(query.marketId) : undefined,
      status: query.status,
      predictorAddress: query.address,
    });
    return {
      positions,
      settledCount: settledNow.length,
      settlementSpotUsd: oracles.latestSpotUsd,
      spotSource: oracles.source,
      spotFetchedAtMs: oracles.fetchedAtMs,
    };
  });

  app.post('/api/markets/positions/:id/settle', async (request, reply) => {
    if (!ADMIN_MARKET_KEY || request.headers['x-admin-key'] !== ADMIN_MARKET_KEY) return reply.code(403).send({error:'Administrator authorization required.'});
    try {
      const params = request.params as { id: string };
      const body = (request.body as { requireExpired?: boolean } | undefined) ?? {};
      const existing = marketEngine.listPositions().find(p => p.positionId === params.id);
      if (!existing) return reply.code(404).send({error:'Position not found.'});
      const oracle = await priceFeed.getHistoricalSettlementOracles();
      const price = oracle.findCloseUsdForTimestamp(existing.expiresAtMs, '1m');
      if (price === undefined) return reply.code(409).send({error:'Exact expiry candle unavailable.'});
      const settlement = {spotUsd:price,source:oracle.source,fetchedAtMs:oracle.fetchedAtMs};
      const position = marketEngine.settlePosition({
        positionId: params.id,
        settlementSpotUsd: settlement.spotUsd,
        requireExpired: true,
      });
      return {
        position,
        settlementSpotUsd: settlement.spotUsd,
        spotSource: settlement.source,
        spotFetchedAtMs: settlement.fetchedAtMs,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      reply.code(msg.includes('not found') ? 404 : 400);
      return { error: msg };
    }
  });

  app.get('/api/markets/candles', async (request, reply) => {
    const query = (request.query as { interval?: string; limit?: string; endTimeMs?: string }) ?? {};
    const rawInterval = (query.interval ?? '5m').trim();
    const allowedIntervals: readonly CandleInterval[] = ['1m', '5m', '1h', '1d'];
    if (!allowedIntervals.includes(rawInterval as CandleInterval)) {
      reply.code(400);
      return { error: 'Invalid interval. Allowed values: 1m, 5m, 1h, 1d.' };
    }
    const limit = Number(query.limit ?? 60);
    if (!Number.isInteger(limit) || limit < 10 || limit > 200) return reply.code(400).send({ error: 'Candle limit must be an integer from 10 to 200.' });
    if (query.endTimeMs !== undefined) {
      const endTimeMs = Number(query.endTimeMs);
      const nowMs = Date.now();
      if (!Number.isSafeInteger(endTimeMs) || endTimeMs < nowMs - 8 * 86_400_000 || endTimeMs > nowMs + 5000) {
        return reply.code(400).send({ error: 'endTimeMs must be a Unix millisecond timestamp within the last eight days.' });
      }
      return await priceFeed.fetchCandleWindow(rawInterval as CandleInterval, limit, endTimeMs);
    }
    return await priceFeed.fetchCandles(rawInterval as CandleInterval, limit);
  });

  app.get('/api/markets/:idOrSlug', async (request, reply) => {
    const { idOrSlug } = request.params as { idOrSlug: string };
    const nowMs = Date.now();
    const oracles = await priceFeed.getHistoricalSettlementOracles();
    marketEngine.autoSettleExpiredPositions(
      oracles.latestSpotUsd,
      nowMs,
      oracles.findCloseUsdForTimestamp
    );
    const tick = priceFeed.getCurrentTick();
    const market = marketEngine.resolveMarketByIdOrSlug(
      idOrSlug,
      tick.bchUsdPrice,
      nowMs,
      oracles
    );
    if (!market) {
      reply.code(404);
      return { error: `Market "${idOrSlug}" not found` };
    }
    return {
      market,
      tick,
      recentTicks: priceFeed.getRecentTicks(120),
      positions: marketEngine.listPositions({ marketId: market.marketId }),
    };
  });

  app.post('/api/markets', async (request, reply) => {
    const adminHeader = String(request.headers['x-admin-key'] ?? '');
    if (!ADMIN_MARKET_KEY || !adminHeader || adminHeader !== ADMIN_MARKET_KEY) {
      reply.code(403);
      return {
        error: 'Market creation is restricted to curated administrator epochs.',
      };
    }

    try {
      const body = request.body as {
        slug?: string;
        title: string;
        description: string;
        assetPair?: string;
        strikePriceCents: number;
        durationSeconds: number;
        bucketLabels?: string[];
        initialBucketsSats?: string[];
      };

      const initialBucketsSats = body.initialBucketsSats?.map((s) => BigInt(s));
      const created = marketEngine.createMarket({
        slug: body.slug,
        title: body.title,
        description: body.description,
        assetPair: body.assetPair,
        strikePriceCents: Number(body.strikePriceCents),
        durationSeconds: Number(body.durationSeconds),
        bucketLabels: body.bucketLabels,
        initialBucketsSats,
      });

      return { market: created };
    } catch (err) {
      reply.code(400);
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  app.post('/api/markets/:id/stake', async (request, reply) => {
    try {
      const params = request.params as { id: string };
      const body = request.body as {
        bucketId: number;
        stakeSats: string | number;
        predictorAddress?: string;
        predictorTokenAddress?: string;
        mode?: ExecutionMode;
        txid?: string;
        expiresAtMs?: number;
      };

      const stakeSats = parseBoundedBigInt(body.stakeSats, 'stakeSats', DUST_LIMIT_SATS);
      const bucketId = Number(body.bucketId);
      if (!Number.isInteger(bucketId) || bucketId < 0) {
        reply.code(400);
        return { error: 'Outcome bucketId must be a non-negative integer.' };
      }
      if (body.mode === 'MAINNET_MODE') {
        reply.code(400);
        return { error: 'On-chain stake indexing requires independently verified chain transactions.' };
      }
      if (body.txid !== undefined && !/^[a-f0-9]{64}$/i.test(body.txid)) {
        reply.code(400);
        return { error: 'txid must be a valid 64-character hexadecimal hash.' };
      }
      if (body.predictorAddress !== undefined && !validateAndConvertCashAddr(body.predictorAddress).valid) {
        reply.code(400);
        return { error: 'Invalid predictorAddress CashAddr.' };
      }
      if (
        body.predictorTokenAddress !== undefined &&
        !validateAndConvertCashAddr(body.predictorTokenAddress).valid
      ) {
        reply.code(400);
        return { error: 'Invalid predictorTokenAddress CashAddr.' };
      }

      const tick = priceFeed.getCurrentTick();
      const resolved = marketEngine.resolveMarketByIdOrSlug(params.id, tick.bchUsdPrice);
      const now = Date.now();
      if (resolved) {
        if (resolved.createdAtMs > now || resolved.expiryTimestampMs <= now) {
          reply.code(400);
          return { error: 'Market is not in its active epoch.' };
        }
        if (body.expiresAtMs !== undefined && body.expiresAtMs !== resolved.expiryTimestampMs) {
          reply.code(400);
          return { error: 'Position expiry must match the market epoch.' };
        }
        if (resolved.status !== 'OPEN') {
          reply.code(400);
          return { error: `Market ${resolved.marketId} is ${resolved.status} and cannot accept new stakes.` };
        }
        if (!resolved.buckets.some((b) => b.bucketId === bucketId)) {
          reply.code(400);
          return { error: `Invalid outcome bucketId ${bucketId} for market ${resolved.marketId}` };
        }
        marketEngine.ensureMarketPersisted(resolved);
      } else if (!/^\d+$/.test(params.id)) {
        reply.code(400);
        return { error: 'Unknown market identifier.' };
      }

      const targetMarketId = resolved ? resolved.marketId : Number(params.id);
      const result = marketEngine.placeStake({
        marketId: targetMarketId,
        bucketId,
        stakeSats,
        predictorAddress: body.predictorAddress,
        predictorTokenAddress: body.predictorTokenAddress,
        mode: body.mode ?? 'SANDBOX_MODE',
        entrySpotUsd: tick.bchUsdPrice,
        txid: body.txid,
        expiresAtMs: body.expiresAtMs,
      });

      return result;
    } catch (err) {
      reply.code(400);
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  app.post('/api/markets/:id/resolve', async (request, reply) => {
    if (!ADMIN_MARKET_KEY || request.headers['x-admin-key'] !== ADMIN_MARKET_KEY) return reply.code(403).send({error:'Administrator authorization required.'});
    try {
      const params = request.params as { id: string };
      const body = request.body as {
        winningBucketId: number;
        resolutionPriceCents: number;
      };

      const resolved = marketEngine.resolveMarket({
        marketId: Number(params.id),
        winningBucketId: Number(body.winningBucketId),
        resolutionPriceCents: Number(body.resolutionPriceCents),
      });

      return { market: resolved };
    } catch (err) {
      reply.code(400);
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  // 4. Multi-Currency Batch Payroll Parser & nLockTime Scheduler
  app.post('/api/payroll/parse', async (request, reply) => {
    const body = (request.body as { rawText?: string }) ?? {};
    const quoteLock = priceFeed.getQuoteLock();
    if (body.rawText !== undefined && typeof body.rawText !== 'string') return reply.code(400).send({ error: 'rawText must be a string.' });
    const summary = parsePayrollText(body.rawText ?? '', quoteLock);
    return summary;
  });

  app.post('/api/payroll/schedule', async (request, reply) => {
    try {
      const body = request.body as {
        nLockTime: number;
        signedTxHex: string;
        totalSats: string | number;
        recipientCount: number;
      };

      const nLockTime = Number(body.nLockTime);
      const recipientCount = Number(body.recipientCount);
      if (
        typeof body.signedTxHex !== 'string' ||
        !/^(?:[a-f0-9]{2})+$/i.test(body.signedTxHex) ||
        body.signedTxHex.length > 200_000 ||
        !Number.isSafeInteger(nLockTime) ||
        nLockTime <= 0 ||
        nLockTime > 0xffffffff
      ) {
        reply.code(400);
        return { error: 'Valid nLockTime and pre-signed hexadecimal transaction are required.' };
      }
      if (!Number.isSafeInteger(recipientCount) || recipientCount <= 0 || recipientCount > 500) {
        reply.code(400);
        return { error: 'recipientCount must be an integer between 1 and 500.' };
      }
      const totalSats = parseBoundedBigInt(body.totalSats, 'totalSats', DUST_LIMIT_SATS);

      const job: ScheduledPayrollJob = {
        jobId: `payroll-lock-${Date.now()}`,
        nLockTime,
        signedTxHex: body.signedTxHex.toLowerCase(),
        totalSats,
        recipientCount,
        createdAtMs: Date.now(),
        status: 'PENDING_LOCKTIME',
      };

      store.insertScheduledPayroll(job);
      return { job };
    } catch (err) {
      reply.code(400);
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  app.get('/api/payroll/schedule', async () => {
    return { jobs: store.listScheduledPayrolls() };
  });

  // 5. Nostr-BCH Cryptographic Identity Binding (Paytaca Bounty)
  // SHA256("BCH-NOSTR-ID-V1" || cashaddr_z || npub || timestamp || nonce)
  app.post('/api/identity/verify', async (request, reply) => {
    const body = request.body as {
      cashAddrZ: string;
      npub: string;
      timestamp: number;
      nonce: string;
      bchSignatureHex?: string;
      nostrSigHex?: string;
      relayUrls?: string[];
    };

    const addrCheck = validateAndConvertCashAddr(body.cashAddrZ ?? '');
    if (!addrCheck.valid || !addrCheck.tokenAwareAddress) {
      reply.code(400);
      return { error: `Invalid BCH CashAddr: ${addrCheck.error ?? 'checksum failed'}` };
    }
    if (!body.npub || !body.npub.startsWith('npub1')) {
      reply.code(400);
      return { error: 'Invalid Nostr public key: must start with npub1' };
    }

    const canonicalChallenge = `BCH-NOSTR-ID-V1||${addrCheck.tokenAwareAddress}||${body.npub}||${body.timestamp}||${body.nonce}`;
    const challengeHashHex = createHash('sha256').update(canonicalChallenge).digest('hex');

    const proof: NostrBchIdentityProof = {
      cashAddrZ: addrCheck.tokenAwareAddress,
      npub: body.npub,
      timestamp: Number(body.timestamp),
      nonce: String(body.nonce),
      challengeHashHex,
      bchSignatureHex:
        body.bchSignatureHex || '',
      nostrSigHex:
        body.nostrSigHex || '',
      relayUrls: body.relayUrls ?? ['wss://relay.damus.io', 'wss://nos.lol'],
      verified: false,
    };

    store.insertNostrIdentity(proof);
    return { proof };
  });

  app.get('/api/identity', async () => {
    return { identities: store.listNostrIdentities() };
  });

  // 6. PUSD / MUSD <-> EVM USDC / USDT Stable Bridge Quote
  app.post('/api/bridge/quote', async (request, reply) => {
    try {
      const body = request.body as {
        direction: 'BCH_TO_EVM' | 'EVM_TO_BCH';
        sourceToken: 'PUSD' | 'MUSD' | 'USDC' | 'USDT';
        targetToken: 'PUSD' | 'MUSD' | 'USDC' | 'USDT';
        inputAmountUnits: string | number;
        bchAddress: string;
        evmAddress: string;
      };

      const inputUnits = parseBoundedBigInt(
        body.inputAmountUnits,
        'inputAmountUnits',
        1n,
        1_000_000_000_000_000n
      );

      // 0.15% (15 bps) cross-chain liquidity fee
      const feeUnits = (inputUnits * 15n) / 10_000n;
      const outputUnits = inputUnits - feeUnits;

      const quote: PusdBridgeQuote = {
        quoteId: `bridge-${Date.now()}`,
        direction: body.direction ?? 'BCH_TO_EVM',
        sourceToken: body.sourceToken ?? 'PUSD',
        targetToken: body.targetToken ?? 'USDC',
        inputAmountUnits: inputUnits,
        outputAmountUnits: outputUnits,
        bridgeFeeUnits: feeUnits,
        bchAddress: body.bchAddress,
        evmAddress: body.evmAddress,
        estimatedTimeSeconds: 18,
      };

      return { quote };
    } catch (err) {
      reply.code(400);
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  // 7. Read-Only AI Risk Analysis & ZIP Export
  app.post('/api/ai/analyze', async (request, reply) => {
    try {
      const body = request.body as AiAnalysisRequest;
      const analysis = aiService.analyze(body);
      return analysis;
    } catch (err) {
      reply.code(400);
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  app.get('/api/analytics/export', async () => {
    return store.exportFullSnapshot();
  });

  app.get('/api/analytics/export-zip', async (_request, reply) => {
    const zipBuffer = aiService.buildAnalyticsZipBuffer(store.exportFullSnapshot());
    reply
      .header('Content-Type', 'application/zip')
      .header('Content-Disposition', 'attachment; filename="cashingularity-analytics.zip"');
    return reply.send(zipBuffer);
  });

  // 7B. Real On-Chain UTXO & Broadcast Endpoints (Electrum / Fulcrum Mainnet & Chipnet)
  const handleUtxosRequest = async (request: { query: unknown }, reply: FastifyReply) => {
    try {
      const query =
        (request.query as { address?: string; network?: BchNetwork; refresh?: string }) ?? {};
      if (!query.address) {
        reply.code(400);
        return { error: 'Missing required query parameter: address' };
      }
      const result = await bchNetwork.fetchAddressUtxos(
        query.address,
        query.network,
        query.refresh === 'true'
      );
      return result;
    } catch (err) {
      reply.code(400);
      return { error: err instanceof Error ? err.message : String(err) };
    }
  };

  const handleBroadcastRequest = async (request: { body: unknown }, reply: FastifyReply) => {
    try {
      const body = (request.body as { rawTxHex?: string; network?: BchNetwork }) ?? {};
      if (!body.rawTxHex) {
        reply.code(400);
        return { error: 'Missing required field: rawTxHex' };
      }
      const result = await bchNetwork.broadcastRawTransaction(
        body.rawTxHex,
        body.network ?? 'mainnet'
      );
      return result;
    } catch (err) {
      reply.code(400);
      return { error: err instanceof Error ? err.message : String(err) };
    }
  };

  const handleHistoryRequest = async (request: { query: unknown }, reply: FastifyReply) => {
    try {
      const query =
        (request.query as { address?: string; network?: BchNetwork; refresh?: string }) ?? {};
      if (!query.address) {
        reply.code(400);
        return { error: 'Missing required query parameter: address' };
      }
      if (query.network && query.network !== 'mainnet' && query.network !== 'chipnet') {
        reply.code(400);
        return { error: 'Invalid network. Expected mainnet or chipnet.' };
      }
      return await bchNetwork.fetchAddressHistory(
        query.address,
        query.network,
        query.refresh === 'true'
      );
    } catch (err) {
      reply.code(400);
      return { error: err instanceof Error ? err.message : String(err) };
    }
  };

  app.get('/api/chain/utxos', handleUtxosRequest);
  registerWalletSync(app);
  app.get('/api/wallet/utxos', handleUtxosRequest);
  app.get('/api/chain/history', handleHistoryRequest);
  app.get('/api/wallet/history', handleHistoryRequest);
  app.post('/api/chain/broadcast', handleBroadcastRequest);
  app.post('/api/broadcast', handleBroadcastRequest);
  app.post('/api/wallet/broadcast', handleBroadcastRequest);

  // 7C. Real Contract Transaction & DAG Preparation Endpoint (/api/contracts/prepare)
  app.post('/api/contracts/prepare', async (request, reply) => {
    if (process.env.NODE_ENV === 'production') {
      return reply.code(403).send({ error: 'Public markets use Paper Trading. Contract demonstrations run separately on Chipnet.' });
    }
    try {
      const body = (request.body as {
        contractType?: 'PREDICTION_STAKE' | 'INACTIVITY_VAULT' | 'PULL_REWARD_CLAIM';
        address?: string;
        changeAddress?: string;
        network?: BchNetwork;
        stakeSats?: string | number;
        depositSats?: string | number;
        marketId?: number;
        bucketId?: number;
        ownerPkhHex?: string;
        beneficiaryPkhHex?: string;
        inactivityBlocks?: number;
        actionType?: 'heartbeatOrSpend' | 'reclaimByBeneficiary';
        lastClaimedEpoch?: number;
        currentEpoch?: number;
        analysisMode?: AiExecutionMode;
      }) ?? {};

      if (!body.address) {
        reply.code(400);
        return { error: 'Missing required field: address' };
      }

      const contractType = body.contractType ?? 'PREDICTION_STAKE';
      if (!['PREDICTION_STAKE', 'INACTIVITY_VAULT', 'PULL_REWARD_CLAIM'].includes(contractType)) throw new Error('Unknown contract type.');
      const selectedMarket = contractType === 'PREDICTION_STAKE'
        ? marketEngine.resolveMarketByIdOrSlug(String(body.marketId ?? 1), priceFeed.getCurrentTick().bchUsdPrice)
        : undefined;
      if (contractType === 'PREDICTION_STAKE') {
        if (!selectedMarket) throw new Error('Unknown market ID.');
        if (selectedMarket.status !== 'OPEN' || selectedMarket.createdAtMs > Date.now() || selectedMarket.expiryTimestampMs <= Date.now()) throw new Error('Market is not in its active epoch.');
        if (!selectedMarket.buckets.some(b => b.bucketId === (body.bucketId ?? 1))) throw new Error('Unknown outcome bucket.');
      }
      const receiveLookup = await bchNetwork.fetchAddressUtxos(body.address, body.network);
      const changeValidation = body.changeAddress
        ? validateAndConvertCashAddr(body.changeAddress)
        : undefined;
      const validChangeAddr =
        changeValidation?.valid &&
        changeValidation.network === receiveLookup.network &&
        changeValidation.standardAddress &&
        changeValidation.standardAddress !== receiveLookup.address
          ? changeValidation.standardAddress
          : receiveLookup.address;

      let combinedUtxos: WalletUtxo[] = [...receiveLookup.utxos];
      if (validChangeAddr !== receiveLookup.address) {
        try {
          const changeLookup = await bchNetwork.fetchAddressUtxos(
            validChangeAddr,
            receiveLookup.network
          );
          combinedUtxos = [
            ...combinedUtxos,
            ...changeLookup.utxos.map((u) => ({
              ...u,
              derivationScope: 'change' as const,
            })),
          ];
        } catch {
          // Proceed with receive branch UTXOs
        }
      }

      const analysisMode: AiExecutionMode = body.analysisMode ?? 'LOCAL';
      const userPkhHex = extractPkhHexFromCashAddr(receiveLookup.address);

      let covenantAddress: string;
      let covenantLockingBytecodeHex: string;
      let covenantProof: CovenantProof;
      let commitAmountSats: bigint;
      let nftCommitmentHex: string | undefined;
      let covenantOpcodes = PREDICTION_POOL_CONTRACT.covenantOpcodes;
      let aiExplanation = '';

      if (contractType === 'INACTIVITY_VAULT') {
        const defaultDummyOwner = '76a04053bda0a88bda5177b86a15c3b29f559873';
        const ownerPkh =
          body.ownerPkhHex && body.ownerPkhHex.toLowerCase() !== defaultDummyOwner
            ? body.ownerPkhHex
            : userPkhHex;
        const beneficiaryPkh =
          body.beneficiaryPkhHex ?? 'cb481232299cd5743151ac4b2d63ae198e7bb0a9';
        const blocks = Number(body.inactivityBlocks ?? 4320);
        if (!Number.isInteger(blocks) || blocks < 1 || blocks > 525_960) {
          reply.code(400);
          return { error: 'inactivityBlocks must be an integer between 1 and 525960.' };
        }
        const vault = compileInactivityVaultContract({
          ownerPkhHex: ownerPkh,
          beneficiaryPkhHex: beneficiaryPkh,
          inactivityBlocks: blocks,
          network: receiveLookup.network,
        });
        covenantAddress = vault.covenantAddress;
        covenantLockingBytecodeHex = vault.lockingBytecodeHex;
        covenantProof = vault.covenantProof;
        commitAmountSats = parseBoundedBigInt(
          body.depositSats ?? body.stakeSats ?? 10_000,
          'depositSats',
          DUST_LIMIT_SATS
        );
        covenantOpcodes = INACTIVITY_VAULT_CONTRACT.covenantOpcodes;
        aiExplanation = `InactivityVault (${body.actionType ?? 'heartbeatOrSpend'}, ${blocks} blocks timelock)`;
      } else if (contractType === 'PULL_REWARD_CLAIM') {
        const categoryId =
          'f1d0c4582026f1d0c4582026f1d0c4582026f1d0c4582026f1d0c45820260001';
        const lastEp = Number(body.lastClaimedEpoch ?? 10);
        const curEp = Number(body.currentEpoch ?? 14);
        if (!Number.isInteger(lastEp) || !Number.isInteger(curEp) || lastEp < 0 || curEp < 0) {
          reply.code(400);
          return { error: 'Epoch bounds must be non-negative integers.' };
        }
        const claim = compilePullRewardClaimContract({
          categoryId,
          currentEpoch: curEp,
          contributorPkhHex: userPkhHex,
          network: receiveLookup.network,
        });
        covenantAddress = claim.covenantAddress;
        covenantLockingBytecodeHex = claim.lockingBytecodeHex;
        covenantProof = claim.covenantProof;
        commitAmountSats = parseBoundedBigInt(
          body.stakeSats ?? 2_500,
          'stakeSats',
          DUST_LIMIT_SATS
        );
        if (commitAmountSats <= 2_000n) {
          commitAmountSats = 2_500n;
        }
        const claimHex = (BigInt(Math.max(0, curEp - lastEp)) * 25_000n)
          .toString(16)
          .padStart(16, '0');
        nftCommitmentHex = `${userPkhHex}${curEp
          .toString(16)
          .padStart(8, '0')}${claimHex}`;
        covenantOpcodes = PULL_REWARD_CLAIM_CONTRACT.covenantOpcodes;
        aiExplanation = `PullRewardClaim Covenant (Epoch #${lastEp} -> #${curEp})`;
      } else {
        const market = selectedMarket!;
        const bucketId = Number(body.bucketId ?? 1);
        if (!Number.isInteger(bucketId) || bucketId < 0 || bucketId > 255) {
          reply.code(400);
          return { error: 'bucketId must be an integer between 0 and 255.' };
        }
        const stakeSats = parseBoundedBigInt(
          body.stakeSats ?? 10_000,
          'stakeSats',
          DUST_LIMIT_SATS
        );
        const pool = compilePredictionPoolContract({
          marketId: market.marketId,
          bucketId,
          predictorPkhHex: userPkhHex,
          oraclePubKeyHex: market.oraclePubKeyHex,
          network: receiveLookup.network,
        });
        covenantAddress = pool.covenantAddress;
        covenantLockingBytecodeHex = pool.lockingBytecodeHex;
        covenantProof = pool.covenantProof;
        commitAmountSats = stakeSats;
        nftCommitmentHex = Array.from(
          encodeNftReceiptCommitment({
            marketId: market.marketId,
            bucketId,
            stakeSats,
          })
        )
          .map((b) => b.toString(16).padStart(2, '0'))
          .join('');
        covenantOpcodes = PREDICTION_POOL_CONTRACT.covenantOpcodes;
        aiExplanation = `PredictionPool Market #${market.marketId} (Bucket #${bucketId})`;
      }

      const built = buildVerifiableContractTransaction({
        contractType,
        network: receiveLookup.network,
        covenantAddress,
        covenantLockingBytecodeHex,
        covenantProof,
        commitAmountSats,
        walletUtxos: combinedUtxos,
        userAddress: receiveLookup.address,
        userTokenAddress: receiveLookup.tokenAwareAddress,
        userChangeAddress: validChangeAddr,
        nftCommitmentHex,
        covenantOpcodes,
        aiExplanation,
        analysisMode,
      });

      const preparedProof: CovenantProof | undefined =
        built.transactionTemplate.covenantProof
          ? {
              ...built.transactionTemplate.covenantProof,
              covenantSemantics:
                contractType === 'PREDICTION_STAKE'
                  ? 'USER_FUNDED_ESCROW_TICKET'
                  : contractType === 'INACTIVITY_VAULT'
                    ? 'INACTIVITY_VAULT'
                    : 'PULL_REWARD_CLAIM',
            }
          : undefined;

      if (preparedProof) {
        built.transactionTemplate.covenantProof = preparedProof;
      }

      return {
        contractType,
        covenantAddress: built.transactionTemplate.covenantAddress,
        covenantLockingBytecodeHex: built.transactionTemplate.covenantLockingBytecodeHex,
        covenantProof: preparedProof,
        transactionTemplate: built.transactionTemplate,
        dag: built.dag,
        selectedUtxos: built.selectedUtxos,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      reply.code(400);
      return { error: msg };
    }
  });

  // The isolated engine is the only authority for XO addresses, balances, and broadcasts.
  app.post('/api/xo/rpc', async (request, reply) => {
    const rpcKey = process.env.CASHINGULARITY_XO_RPC_KEY;
    if (!rpcKey || request.headers['x-xo-key'] !== rpcKey) {
      return reply.code(403).send({ error: 'XO sidecar access requires a configured local RPC key.' });
    }
    const rpc = (request.body ?? {}) as { id?: string | number; method?: string; params?: Record<string, unknown> };
    const id = rpc.id ?? 'rpc-1';
    try {
      if (!rpc.method || rpc.params?.skipLiveEngine) throw new Error('A live XO engine is required; simulated RPC results are disabled.');
      if (rpc.method === 'wallet.openChipnetAccount' && !rpc.params?.mnemonic) throw new Error('Missing BIP39 mnemonic.');
      const bridge = await getOrLoadRealXoBridge();
      if (!bridge) throw new Error('Live XO engine unavailable. No transaction signed or broadcast.');
      const params = { ...rpc.params };
      // Never accept caller-selected server filesystem paths for a wallet database.
      delete params.databasePath;
      delete params.databaseFilename;
      if (rpc.method === 'wallet.openChipnetAccount') {
        params.databasePath = path.resolve(process.cwd(), '.xo-runtime-cache');
        params.databaseFilename = 'local-chipnet-account';
      }
      return await bridge.handleJsonRpcRequest({ id, method: rpc.method, params });
    } catch (err) {
      return { id, error: { code: -32000, message: err instanceof Error ? err.message : String(err) } };
    }
  });

  // 9. WebSocket Live Stream (/ws)
  app.get('/ws', { websocket: true }, (socket) => {
    const sendSnapshot = () => {
      if (socket.readyState !== 1) return;
      try {
        const tick = priceFeed.stepTick();
        const cone = priceFeed.getVolatilityCone(300, 15);
        socket.send(
          safeJsonStringify({
            type: 'MARKET_PULSE',
            tick,
            volatilityCone: cone,
            markets: marketEngine.listMarkets(),
          })
        );
      } catch {
        clearInterval(timer);
      }
    };

    const timer = setInterval(sendSnapshot, 2000);
    sendSnapshot();
    socket.on('error', () => clearInterval(timer));
    socket.on('close', () => clearInterval(timer));
  });

  // 10. Single-Port Production & Dev Frontend Static Serving (SPA Fallback)
  const frontendDistDir = resolveFrontendDistDir();
  // These files are served only by the isolated verification origin.
  app.get('/verification-frame.:ext', async (_request, reply) => reply.code(404).send({ error: 'Verification is served on a separate origin.' }));
  if (frontendDistDir) {
    const indexHtmlPath = path.join(frontendDistDir, 'index.html');

    const serveIndexHtml = async (_request: unknown, reply: FastifyReply) => {
      const htmlBuffer = fs.readFileSync(indexHtmlPath);
      return reply.type('text/html; charset=utf-8').send(htmlBuffer);
    };

    // Serve static assets in /assets/*
    app.get('/assets/:filename', async (request, reply) => {
      const { filename } = request.params as { filename: string };
      const safeName = path.basename(filename);
      const assetPath = path.join(frontendDistDir, 'assets', safeName);
      if (!fs.existsSync(assetPath)) {
        return reply.code(404).send({ error: 'Asset not found' });
      }
      const ext = path.extname(safeName).toLowerCase();
      const contentType =
        ext === '.css'
          ? 'text/css; charset=utf-8'
          : ext === '.js'
          ? 'application/javascript; charset=utf-8'
          : ext === '.svg'
          ? 'image/svg+xml'
          : 'application/octet-stream';
      return reply.type(contentType).send(fs.readFileSync(assetPath));
    });

    const MIME_TYPES: Record<string, string> = {
      '.html': 'text/html; charset=utf-8',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon',
      '.json': 'application/json; charset=utf-8',
      '.webmanifest': 'application/manifest+json; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.woff2': 'font/woff2',
    };

    const distRootResolved = path.resolve(frontendDistDir);

    // Serve Chrome Extension Manifest V3
    app.get('/manifest.json', async (_request, reply) => {
      const manifestPath = path.join(frontendDistDir, 'manifest.json');
      if (fs.existsSync(manifestPath)) {
        return reply.type('application/json; charset=utf-8').send(fs.readFileSync(manifestPath));
      }
      return reply.code(404).send({ error: 'manifest.json not found' });
    });

    // Serve SPA routes
    for (const spaRoute of ['/', '/market', '/wallet', '/batch', '/arcade', '/arcade/rocket-race', '/arcade/rocket-race/online']) {
      app.get(spaRoute, serveIndexHtml);
    }

    // Serve static files from Vite dist (e.g. /logo-market.png, /logo-wallet.png) or fall back to SPA index.html
    app.setNotFoundHandler(async (request, reply) => {
      if (request.method === 'GET' && !request.url.startsWith('/api/')) {
        const rawPath = request.url.split('?')[0].replace(/^\/+/, '');
        if (rawPath) {
          const candidate = path.resolve(distRootResolved, rawPath);
          if (
            candidate.startsWith(distRootResolved + path.sep) &&
            fs.existsSync(candidate) &&
            fs.statSync(candidate).isFile()
          ) {
            const ext = path.extname(candidate).toLowerCase();
            return reply
              .type(MIME_TYPES[ext] ?? 'application/octet-stream')
              .send(fs.readFileSync(candidate));
          }
        }
        return serveIndexHtml(request, reply);
      }
      return reply.code(404).send({ error: `Route ${request.method}:${request.url} not found` });
    });
  }

  return {
    app,
    store,
    priceFeed,
    marketEngine,
    aiService,
    bchNetwork,
  };
}

// Start server on port 3000 if run directly
const isMain =
  process.argv[1] &&
  path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);

if (isMain) {
  const port = Number(process.env.PORT ?? 3000);
  const production = process.env.NODE_ENV === 'production';
  const host = process.env.CASHINGULARITY_BIND_HOST ?? (production ? '127.0.0.1' : '0.0.0.0');
  buildBackendServer({ dataDir: process.env.CASHINGULARITY_DATA_DIR }).then(async ({ app }) => {
    const origins = (process.env.TURNSTILE_WALLET_ORIGINS ?? (production ? '' : 'http://localhost:3000,http://127.0.0.1:3000,http://localhost:5173,http://127.0.0.1:5173')).split(',').map(value => value.trim()).filter(Boolean);
    const verification = createBotVerificationServer(origins);
    await verification.listen({ port: Number(process.env.TURNSTILE_FRAME_PORT ?? 3001), host: '127.0.0.1' });
    app.addHook('onClose', async () => { await verification.close(); });
    const address = await app.listen({ port, host });
    console.log(`Cashingularity listening at ${address}`);
    function stop() {
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
      void app.close().catch(() => { process.exitCode = 1; });
    }
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  }).catch(() => {
    console.error('Cashingularity failed to start. Check the listener, data directory and verification origin settings.');
    process.exit(1);
  });
}
