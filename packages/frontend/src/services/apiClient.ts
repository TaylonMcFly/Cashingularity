/**
 * Backend API & WebSocket Client (`http://localhost:3000`) with Local Price and FX Fallbacks
 */

import { buildPredictionStakeDagPreview } from "@cashingularity/contracts-cashscript";
import { binToHex, getDustThreshold } from "@bitauth/libauth";
import {
  materializePreparedContractPayment,
  type PreparedPayment,
} from "./paymentService.js";
import { wizardWalletSingleton } from "./walletRuntime.js";
import {
  AiExecutionMode,
  BchNetwork,
  ConfigurableMarket,
  encodeNftReceiptCommitment,
  createDefaultFxQuoteLock,
  ExecutionMode,
  FxQuoteLock,
  generateEwmaVolatilityCone,
  type MarketBuy,
  PreparedContractTransactionTemplate,
  PreparedContractType,
  UtxoDagInspection,
  validateAndConvertCashAddr,
  VolatilityBandPoint,
} from "@cashingularity/shared";

const API_BASE = "";

function reviveMarketFromApi(raw: Record<string, unknown>): ConfigurableMarket {
  const buckets = ((raw.buckets as Array<Record<string, unknown>>) ?? []).map(
    (b) => ({
      bucketId: Number(b.bucketId),
      label: String(b.label),
      poolSats: BigInt(String(b.poolSats ?? "0")),
      participantCount: Number(b.participantCount ?? 0),
      impliedProbability: Number(b.impliedProbability ?? 0.5),
      currentMultiplier: Number(b.currentMultiplier ?? 1.98),
      ...(b.outcomeRule === "ABOVE" ||
      b.outcomeRule === "BELOW" ||
      b.outcomeRule === "RANGE"
        ? { outcomeRule: b.outcomeRule as "ABOVE" | "BELOW" | "RANGE" }
        : {}),
      ...(b.lowerBoundCents !== undefined
        ? { lowerBoundCents: Number(b.lowerBoundCents) }
        : {}),
      ...(b.upperBoundCents !== undefined
        ? { upperBoundCents: Number(b.upperBoundCents) }
        : {}),
    }),
  );

  return {
    id: raw.id ? String(raw.id) : undefined,
    marketId: Number(raw.marketId),
    ...(typeof raw.slug === "string" ? { slug: raw.slug } : {}),
    ...(typeof raw.epochSeriesId === "string"
      ? { epochSeriesId: raw.epochSeriesId }
      : typeof raw.seriesId === "string"
        ? { epochSeriesId: raw.seriesId }
        : {}),
    title: String(raw.title),
    description: String(raw.description),
    assetPair: String(raw.assetPair ?? "BCH/USD"),
    strikePriceCents: Number(raw.strikePriceCents ?? 50_000),
    createdAtMs: Number(raw.createdAtMs ?? Date.now()),
    durationSeconds: Number(raw.durationSeconds ?? 300),
    expiryTimestampMs: Number(raw.expiryTimestampMs ?? Date.now() + 300_000),
    feeBps: BigInt(String(raw.feeBps ?? "100")),
    status: (raw.status as ConfigurableMarket["status"]) ?? "OPEN",
    totalPoolSats: BigInt(String(raw.totalPoolSats ?? "1000000")),
    buckets,
    oraclePubKeyHex: String(raw.oraclePubKeyHex ?? ""),
    covenantAddress: String(raw.covenantAddress ?? ""),
    categoryId: String(raw.categoryId ?? "a".repeat(64)),
    resolvedOutcome:
      raw.resolvedOutcome !== undefined
        ? Number(raw.resolvedOutcome)
        : undefined,
    resolutionPriceCents:
      raw.resolutionPriceCents !== undefined
        ? Number(raw.resolutionPriceCents)
        : undefined,
    timeframe:
      raw.timeframe === "1m" ||
      raw.timeframe === "5m" ||
      raw.timeframe === "1h" ||
      raw.timeframe === "24h"
        ? raw.timeframe
        : undefined,
    slotStartMs:
      raw.slotStartMs !== undefined ? Number(raw.slotStartMs) : undefined,
    slotLabel: raw.slotLabel ? String(raw.slotLabel) : undefined,
    isCurrentSlot:
      raw.isCurrentSlot !== undefined ? Boolean(raw.isCurrentSlot) : undefined,
    isFutureSlot:
      raw.isFutureSlot !== undefined ? Boolean(raw.isFutureSlot) : undefined,
    isHistoricalSlot:
      raw.isHistoricalSlot !== undefined
        ? Boolean(raw.isHistoricalSlot)
        : undefined,
    retentionExpiresAtMs:
      raw.retentionExpiresAtMs !== undefined
        ? Number(raw.retentionExpiresAtMs)
        : undefined,
    epochKey: raw.epochKey ? String(raw.epochKey) : undefined,
  };
}

async function readMarketData<T>(path: string, signal = AbortSignal.timeout(10_000)): Promise<T | undefined> {
  try {
    const response = await fetch(`${API_BASE}${path}`, { signal });
    if (response.ok) return await response.json() as T;
  } catch {
    // A failed read leaves the associated view unavailable.
  }
}

export async function fetchMarketsAndTick(signal = AbortSignal.timeout(15_000)): Promise<{
  markets?: ConfigurableMarket[];
  paperBuys: MarketBuy[];
  bchUsdPrice: number;
  ewmaSigma: number;
  volatilityCone: VolatilityBandPoint[];
  quoteLock: FxQuoteLock;
  spotObservation?: { price?: number; source?: string; fetchedAtMs?: number };
  recentTicks?: Array<{ timestampMs: number; priceUsd: number }>;
}> {
  const [marketData, rates] = await Promise.all([
    readMarketData<{ markets: Array<Record<string, unknown>>; paperBuys?: unknown; tick?: { bchUsdPrice: number; ewmaSigma: number } }>('/api/markets', signal),
    readMarketData<{
      quoteLock: FxQuoteLock;
      volatilityCone: VolatilityBandPoint[];
      recentTicks?: Array<{ timestampMs: number; priceUsd: number }>;
      tick?: { bchUsdPrice: number; spotSource?: string; spotFetchedAtMs?: number };
    }>('/api/rates?horizonSeconds=300', signal),
  ]);
  let markets: ConfigurableMarket[] | undefined;
  try {
    if (Array.isArray(marketData?.markets)) markets = marketData.markets.map(reviveMarketFromApi);
  } catch {
    // Keep malformed market records out of the live trading view.
  }
  const bchUsdPrice = rates?.tick?.bchUsdPrice ?? marketData?.tick?.bchUsdPrice ?? 500.45;
  const ewmaSigma = marketData?.tick?.ewmaSigma ?? 0.0021;
  const paperBuys: MarketBuy[] = [];
  if (Array.isArray(marketData?.paperBuys)) {
    for (const buy of marketData.paperBuys.slice(0, 96)) {
      if (!buy || typeof buy.id !== 'string' || !buy.id.length || buy.id.length > 96 ||
          !Number.isSafeInteger(buy.marketId) || !Number.isSafeInteger(buy.bucketId) ||
          !Number.isSafeInteger(buy.timestampMs) || typeof buy.sats !== 'string' || !/^\d{1,16}$/.test(buy.sats)) continue;
      paperBuys.push({ id: buy.id, marketId: buy.marketId, bucketId: buy.bucketId,
        sats: BigInt(buy.sats), timestampMs: buy.timestampMs });
    }
  }
  return {
    markets,
    paperBuys,
    bchUsdPrice,
    ewmaSigma,
    volatilityCone: rates?.volatilityCone ?? generateEwmaVolatilityCone({ currentPrice: bchUsdPrice, muAiDrift: 0.00018, sigma: ewmaSigma, remainingSeconds: 300, steps: 25 }),
    quoteLock: rates?.quoteLock ?? createDefaultFxQuoteLock(),
    spotObservation: rates?.tick && { price: rates.tick.bchUsdPrice, source: rates.tick.spotSource, fetchedAtMs: rates.tick.spotFetchedAtMs },
    recentTicks: Array.isArray(rates?.recentTicks) ? rates.recentTicks : undefined,
  };
}

export async function publishPaperBuy(order: { id: string; marketId: number; bucketId: number; sats: bigint; expiresAtMs: number }) {
  if (order.sats > 2_100_000_000_000_000n) return;
  try {
    await fetch(`${API_BASE}/api/markets/${order.marketId}/paper-flow`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(5000),
      body: JSON.stringify({ id: order.id, bucketId: order.bucketId, sats: order.sats.toString(), expiryMs: order.expiresAtMs }),
    });
  } catch {
    // Paper balances and positions stay usable when the shared flow feed is unavailable.
  }
}

export async function fetchMarketEpochsApi(timeframe: '1m' | '5m' | '1h' | '24h', signal: AbortSignal): Promise<ConfigurableMarket[] | undefined> {
  const data = await readMarketData<{ markets?: Array<Record<string, unknown>> }>(`/api/markets?timeframe=${encodeURIComponent(timeframe)}&extended=true`, AbortSignal.any([signal, AbortSignal.timeout(15_000)]));
  try {
    if (Array.isArray(data?.markets)) return data.markets.map(reviveMarketFromApi);
  } catch { /* Ignore malformed archive responses. */ }
}

export async function fetchMarketBySlugApi(slug: string, signal: AbortSignal): Promise<ConfigurableMarket | undefined> {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) return;
  const key = /^market-(\d+)$/.exec(slug)?.[1] ?? slug;
  const data = await readMarketData<{ market?: Record<string, unknown> }>(`/api/markets/${encodeURIComponent(key)}`, AbortSignal.any([signal, AbortSignal.timeout(15_000)]));
  try {
    if (data?.market) return reviveMarketFromApi(data.market);
  } catch { /* Ignore malformed market responses. */ }
}

export function buildPaperStakeDag(params: {
  market: ConfigurableMarket;
  bucketId: number;
  stakeSats: bigint;
  analysisMode: AiExecutionMode;
}): UtxoDagInspection {
  const dag = buildPredictionStakeDagPreview({
    marketId: params.market.marketId,
    bucketId: params.bucketId,
    stakeSats: params.stakeSats,
    poolTxid: params.market.categoryId,
    poolCurrentSats: params.market.totalPoolSats,
    poolAddress: params.market.covenantAddress,
    categoryId: params.market.categoryId,
    userFundingTxid: "f".repeat(64),
    userFundingVout: 0,
    userFundingSats: params.stakeSats + 50_000n,
    userAddress: "bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a",
    userTokenAddress: "bitcoincash:zpm2qsznhks23z7629mms6s4cwef74vcwva509496m",
    userChangeAddress: "bitcoincash:qp3wjpa3tjlj042z2wv7hahsldgwhwy0rq9sywjpyy",
    analysisMode: params.analysisMode,
  });
  dag.audit.aiVerdict = "CAUTION";
  dag.audit.bcmrVerified = false;
  dag.audit.aiExplanation = "Paper stake simulation.";
  return dag;
}

function reviveDagFromApi(raw: Record<string, unknown>): UtxoDagInspection {
  const inputs = ((raw.inputs as Array<Record<string, unknown>>) ?? []).map(
    (inp) => {
      const tok = inp.token as Record<string, unknown> | undefined;
      return {
        inputIndex: Number(inp.inputIndex ?? 0),
        txid: String(inp.txid ?? ""),
        vout: Number(inp.vout ?? 0),
        satoshis: BigInt(String(inp.satoshis ?? "0")),
        address: String(inp.address ?? ""),
        isGenesisInput: Boolean(inp.isGenesisInput),
        categoryId: inp.categoryId ? String(inp.categoryId) : undefined,
        unlockingBytecodeHex: inp.unlockingBytecodeHex
          ? String(inp.unlockingBytecodeHex)
          : undefined,
        derivationPath: inp.derivationPath
          ? String(inp.derivationPath)
          : undefined,
        token: tok
          ? {
              categoryId: String(tok.categoryId ?? ""),
              amount: BigInt(String(tok.amount ?? "0")),
              nft: tok.nft as
                | {
                    capability: "none" | "mutable" | "minting";
                    commitment: string;
                  }
                | undefined,
            }
          : undefined,
      };
    },
  );

  const outputs = ((raw.outputs as Array<Record<string, unknown>>) ?? []).map(
    (out) => {
      const tok = out.token as Record<string, unknown> | undefined;
      return {
        index: Number(out.index ?? 0),
        address: String(out.address ?? ""),
        scriptType:
          (out.scriptType as "P2PKH" | "P2SH32" | "OP_RETURN" | "UNKNOWN") ??
          "P2PKH",
        lockingBytecodeHex: String(out.lockingBytecodeHex ?? ""),
        satoshis: BigInt(String(out.satoshis ?? "0")),
        isChange: Boolean(out.isChange),
        token: tok
          ? {
              categoryId: String(tok.categoryId ?? ""),
              amount: BigInt(String(tok.amount ?? "0")),
              nft: tok.nft as
                | {
                    capability: "none" | "mutable" | "minting";
                    commitment: string;
                  }
                | undefined,
            }
          : undefined,
      };
    },
  );

  const auditRaw = (raw.audit as Record<string, unknown>) ?? {};
  return {
    txidPreview: String(raw.txidPreview ?? ""),
    inputs,
    outputs,
    audit: {
      disassembledOpcodes:
        (auditRaw.disassembledOpcodes as UtxoDagInspection["audit"]["disassembledOpcodes"]) ??
        [],
      minerFeeSats: BigInt(String(auditRaw.minerFeeSats ?? "0")),
      feeRateSatsPerByte: Number(auditRaw.feeRateSatsPerByte ?? 1),
      dustPassed: Boolean(auditRaw.dustPassed ?? true),
      bcmrVerified: Boolean(auditRaw.bcmrVerified ?? true),
      bcmrMetadata:
        auditRaw.bcmrMetadata as UtxoDagInspection["audit"]["bcmrMetadata"],
      addressReuseDetected: Boolean(auditRaw.addressReuseDetected),
      aiVerdict:
        (auditRaw.aiVerdict as UtxoDagInspection["audit"]["aiVerdict"]) ??
        "SAFE",
      aiExplanation: String(auditRaw.aiExplanation ?? ""),
      analysisMode: (auditRaw.analysisMode as AiExecutionMode) ?? "LOCAL",
    },
  };
}

export async function prepareContractPaymentApi(params: {
  contractType: PreparedContractType;
  stakeSats?: bigint;
  depositSats?: bigint;
  marketId?: number;
  bucketId?: number;
  ownerPkhHex?: string;
  beneficiaryPkhHex?: string;
  inactivityBlocks?: number;
  actionType?: "heartbeatOrSpend" | "reclaimByBeneficiary";
  lastClaimedEpoch?: number;
  currentEpoch?: number;
  analysisMode: AiExecutionMode;
}): Promise<{
  prepared?: PreparedPayment;
  dag?: UtxoDagInspection;
  error?: string;
}> {
  let wallet = wizardWalletSingleton.getAddresses();
  if (!wallet.isConnected) {
    return { error: "Connect a live wallet before signing on-chain." };
  }
  try {
    wallet = await wizardWalletSingleton.refreshOnChainBalance();
  } catch (err) {
    return {
      error:
        err instanceof Error
          ? err.message
          : "Unable to refresh on-chain UTXOs from Fulcrum.",
    };
  }

  if (!wallet.utxos.some(utxo => !utxo.token && utxo.satoshis > 0n)) {
    return { error: `Insufficient On-Chain Balance (Fund this address first): ${wallet.receiveTokenAddress}` };
  }

  try {
    const res = await fetch(`${API_BASE}/api/contracts/prepare`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contractType: params.contractType,
        address: wallet.receiveAddress,
        changeAddress: wallet.changeAddress,
        network: wallet.network as BchNetwork,
        stakeSats: params.stakeSats?.toString(),
        depositSats: params.depositSats?.toString(),
        marketId: params.marketId,
        bucketId: params.bucketId,
        ownerPkhHex: params.ownerPkhHex,
        beneficiaryPkhHex: params.beneficiaryPkhHex,
        inactivityBlocks: params.inactivityBlocks,
        actionType: params.actionType,
        lastClaimedEpoch: params.lastClaimedEpoch,
        currentEpoch: params.currentEpoch,
        analysisMode: params.analysisMode,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const data = (await res.json()) as {
      transactionTemplate?: PreparedContractTransactionTemplate;
      dag?: Record<string, unknown>;
      error?: string;
    };
    if (!res.ok || !data.transactionTemplate || !data.dag) {
      return { error: data.error || "Unable to prepare contract transaction." };
    }
    if (data.transactionTemplate.contractType !== params.contractType) {
      return { error: "The prepared transaction has a different contract type." };
    }
    const dag = reviveDagFromApi(data.dag);
    const prepared = materializePreparedContractPayment(
      data.transactionTemplate,
      dag,
      wallet,
      wizardWalletSingleton.getLocalWallet(),
    );
    if (params.contractType === 'PREDICTION_STAKE') {
      const [lock, receipt, ...extra] = dag.outputs.filter(output => !output.isChange);
      const change = dag.outputs.filter(output => output.isChange);
      if (!lock || lock.scriptType !== 'P2SH32' || lock.token || lock.satoshis !== params.stakeSats ||
          prepared.inputs.length !== prepared.transaction.inputs.length || extra.length ||
          change.length > 1 || change.some(output => output.scriptType !== 'P2PKH' || output.token) ||
          prepared.transaction.outputs.some(output => output.valueSatoshis < getDustThreshold(output))) {
        return { error: 'The prepared transaction differs from the requested wallet-funded stake.' };
      }
      if (receipt) {
        const nft = receipt.token?.nft;
        const commitment = binToHex(encodeNftReceiptCommitment({
          marketId: params.marketId ?? 1, bucketId: params.bucketId ?? 1, stakeSats: params.stakeSats!,
        }));
        if (receipt.address !== wallet.receiveTokenAddress || !nft || nft.capability !== 'none' ||
            nft.commitment.toLowerCase() !== commitment || receipt.token?.amount !== 0n ||
            receipt.satoshis !== getDustThreshold(prepared.transaction.outputs[receipt.index]) ||
            !prepared.inputs.some(input => input.vout === 0 && input.txid.toLowerCase() === receipt.token?.categoryId.toLowerCase())) {
          return { error: 'The prepared CashTokens receipt does not match this stake.' };
        }
      }
    }
    return { prepared, dag };
  } catch (err) {
    return {
      error:
        err instanceof Error
          ? err.message
          : "Contract preparation request failed.",
    };
  }
}

export interface OhlcvCandlePoint {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export async function fetchMarketCandlesApi(
  interval: "1m" | "5m" | "1h" | "1d" = "5m",
  limit = 60,
  endTimeMs?: number,
): Promise<{
  source: "binance" | "coinbase" | "fallback";
  candles: OhlcvCandlePoint[];
  fetchedAtMs?: number;
}> {
  try {
    const res = await fetch(
      `${API_BASE}/api/markets/candles?interval=${encodeURIComponent(interval)}&limit=${limit}${endTimeMs === undefined ? "" : `&endTimeMs=${endTimeMs}`}`,
      { signal: AbortSignal.timeout(10_000) },
    );
    if (res.ok) {
      const data = (await res.json()) as {
        source?: "binance" | "coinbase" | "fallback";
        candles?: OhlcvCandlePoint[];
        fetchedAtMs?: number;
      };
      if (
        (data.source === "binance" || data.source === "coinbase") &&
        Array.isArray(data.candles) &&
        data.candles.length > 0 &&
        data.candles.every(
          (c, i, all) =>
            Number.isSafeInteger(c.time) &&
            (i === 0 || c.time > all[i - 1].time) &&
            [c.open, c.high, c.low, c.close].every(
              (v) => Number.isFinite(v) && v > 0,
            ) &&
            c.high >= Math.max(c.open, c.close, c.low) &&
            c.low <= Math.min(c.open, c.close),
        )
      ) {
        return {
          source: data.source ?? "fallback",
          candles: data.candles,
          fetchedAtMs: data.fetchedAtMs,
        };
      }
    }
  } catch {
    // Missing observations remain unavailable; never invent market prices.
  }
  return { source: "fallback", candles: [] };
}
