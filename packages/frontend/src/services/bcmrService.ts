/**
 * Paytaca BCMR Token Metadata Resolver via Backend Proxy (`GET /api/bcmr/:categoryId`)
 * Eliminates direct browser CORS / 502 errors against `bcmr.paytaca.com`.
 */

import { BcmrTokenMetadata } from '@cashingularity/shared';

const KNOWN_BCMR_REGISTRY: Record<string, BcmrTokenMetadata> = {
  e9c70516ef03826067f128228d76f80f2704b311969dfca11bb4e461b5cf8757: {
    categoryId: 'e9c70516ef03826067f128228d76f80f2704b311969dfca11bb4e461b5cf8757',
    name: 'Parity USD Stablecoin',
    symbol: 'PUSD',
    decimals: 2,
    description: 'Paytaca Parity USD CashTokens Stablecoin on Bitcoin Cash Mainnet',
    isVerified: true,
  },
  b38a33f750f84c5c169a6f23cb873e6e79605021585d4f3408789689ed87f366: {
    categoryId: 'b38a33f750f84c5c169a6f23cb873e6e79605021585d4f3408789689ed87f366',
    name: 'Moria USD Stablecoin',
    symbol: 'MUSD',
    decimals: 2,
    description: 'Overcollateralized BCH CashTokens Stablecoin',
    isVerified: true,
  },
  f1d0c4582026f1d0c4582026f1d0c4582026f1d0c4582026f1d0c45820260001: {
    categoryId: 'f1d0c4582026f1d0c4582026f1d0c4582026f1d0c4582026f1d0c45820260001',
    name: 'FoldingCash Compute Reward Token',
    symbol: 'FLDCH',
    decimals: 8,
    description: 'Folding@Home biomedical compute reward token on Bitcoin Cash',
    isVerified: false,
  },
  eb202600eb202600eb202600eb202600eb202600eb202600eb202600eb202600: {
    categoryId: 'eb202600eb202600eb202600eb202600eb202600eb202600eb202600eb202600',
    name: 'BCH BLAZE 2026 Voting Token',
    symbol: 'EMBER2026',
    decimals: 0,
    description: 'Official BCH BLAZE 2026 People Choice & Judge Voting Token',
    isVerified: false,
  },
};

const clientBcmrCache = new Map<string, { expires: number; metadata: BcmrTokenMetadata }>();
const requests = new Map<string, Promise<BcmrTokenMetadata>>();
const store = (id: string, metadata: BcmrTokenMetadata, ttl: number) => {
  if (!clientBcmrCache.has(id) && clientBcmrCache.size >= 256) {
    const oldest = clientBcmrCache.keys().next().value;
    if (oldest !== undefined) clientBcmrCache.delete(oldest);
  }
  clientBcmrCache.set(id, { expires: Date.now() + ttl, metadata });
  return metadata;
};

export async function resolvePaytacaBcmrMetadata(
  categoryId: string
): Promise<BcmrTokenMetadata> {
  const cleanId = categoryId.trim().toLowerCase();
  const named = Object.values(KNOWN_BCMR_REGISTRY).find((token) => token.symbol.toLowerCase() === cleanId);
  if (named) return named;
  if (KNOWN_BCMR_REGISTRY[cleanId]) {
    return KNOWN_BCMR_REGISTRY[cleanId];
  }
  const cached = clientBcmrCache.get(cleanId);
  if (cached && cached.expires > Date.now()) return cached.metadata;
  const pending = requests.get(cleanId);
  if (pending) return pending;
  const request = loadMetadata(cleanId).finally(() => { requests.delete(cleanId); });
  requests.set(cleanId, request);
  return request;
}

async function loadMetadata(cleanId: string): Promise<BcmrTokenMetadata> {
  // Only query backend proxy if cleanId is a valid 64-character hex string
  if (/^[0-9a-f]{64}$/.test(cleanId)) {
    try {
      const response = await fetch('/api/bcmr/' + cleanId, { signal: AbortSignal.timeout(8_000) });
      if (response.ok) {
        const meta = (await response.json()) as BcmrTokenMetadata;
        return store(cleanId, meta, 15 * 60_000);
      }
    } catch {
      // Fallback to local metadata below
    }
  }

  const fallbackMeta: BcmrTokenMetadata = {
    categoryId: cleanId,
    name: cleanId === 'csg-pos' || !/^[0-9a-f]{64}$/.test(cleanId) ? 'Position Receipt NFT' : 'Unknown CashToken',
    symbol: cleanId === 'csg-pos' || !/^[0-9a-f]{64}$/.test(cleanId) ? 'CSG-POS' : 'UNKNOWN',
    decimals: 0,
    description: 'Metadata unavailable or preview identifier',
    isVerified: false,
  };
  return store(cleanId, fallbackMeta, 30_000);
}
