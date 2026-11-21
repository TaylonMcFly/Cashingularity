import type { EncryptedAccount } from './authService.js';
/**
 * @cashingularity/backend - Zero-Native-Compile Atomic WAL Persistence Store
 * Persists Configurable Markets, User Stakes, Scheduled nLockTime Payrolls & Nostr-BCH Identities
 */

import {
  ConfigurableMarket,
  ExecutionMode,
  MarketPositionRecord,
  MarketPositionStatus,
  NostrBchIdentityProof,
  ScheduledPayrollJob,
} from '@cashingularity/shared';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

export interface MarketStakeRecord {
  stakeId: string;
  marketId: number;
  bucketId: number;
  stakeSats: bigint;
  predictorAddress: string;
  nftCommitmentHex: string;
  mode: ExecutionMode;
  txid: string;
  createdAtMs: number;
}

export interface DatabaseSnapshot {
  markets: ConfigurableMarket[];
  stakes: MarketStakeRecord[];
  positions: MarketPositionRecord[];
  scheduledPayrolls: ScheduledPayrollJob[];
  nostrIdentities: NostrBchIdentityProof[];
}

function bigIntReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') {
    return `__BIGINT__:${value.toString()}`;
  }
  return value;
}

function bigIntReviver(_key: string, value: unknown): unknown {
  if (typeof value === 'string' && value.startsWith('__BIGINT__:')) {
    return BigInt(value.slice('__BIGINT__:'.length));
  }
  return value;
}

export function serializeWithBigInt(data: unknown): string {
  return JSON.stringify(data, bigIntReplacer);
}

export function deserializeWithBigInt<T>(json: string): T {
  return JSON.parse(json, bigIntReviver) as T;
}

/**
 * Atomic JSON + Write-Ahead Log (WAL) store for deterministic persistence on Windows/Linux.
 */
export class CashingularityWalStore {
  private readonly snapshotPath: string;
  private readonly walPath: string;
  private state: DatabaseSnapshot;
  private securityAccounts: EncryptedAccount[] = [];

  constructor(dataDir = './.cashingularity-data') {
    if (!existsSync(dataDir)) {
      mkdirSync(dataDir, { recursive: true });
    }
    this.snapshotPath = join(dataDir, 'cashingularity.db.json');
    this.walPath = join(dataDir, 'cashingularity.wal.jsonl');
    this.state = this.loadInitialState();
  }

  private loadInitialState(): DatabaseSnapshot {
    if (existsSync(this.snapshotPath)) {
      try {
        const raw = readFileSync(this.snapshotPath, 'utf-8');
        const parsed = deserializeWithBigInt<DatabaseSnapshot & { securityAccounts?: EncryptedAccount[] }>(raw);
        this.securityAccounts = Array.isArray(parsed.securityAccounts) ? parsed.securityAccounts : [];
        return {
          markets: parsed.markets ?? [],
          stakes: parsed.stakes ?? [],
          positions: parsed.positions ?? [],
          scheduledPayrolls: parsed.scheduledPayrolls ?? [],
          nostrIdentities: parsed.nostrIdentities ?? [],
        };
      } catch {
        // Fallback to clean state if snapshot is unreadable
      }
    }
    return {
      markets: [],
      stakes: [],
      positions: [],
      scheduledPayrolls: [],
      nostrIdentities: [],
    };
  }

  private appendWalEntry(action: string, payload: unknown): void {
    const dir = dirname(this.walPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const line = serializeWithBigInt({ ts: Date.now(), action, payload }) + '\n';
    appendFileSync(this.walPath, line, 'utf-8');
    this.flushAtomicSnapshot();
    try {
      if (existsSync(this.walPath) && statSync(this.walPath).size > 5 * 1024 * 1024) {
        const walTmp = `${this.walPath}.tmp`;
        writeFileSync(walTmp, serializeWithBigInt({ ts: Date.now(), action: 'WAL_COMPACT', payload: null }) + '\n', 'utf-8');
        renameSync(walTmp, this.walPath);
      }
    } catch {
      // Non-fatal: next snapshot/compact will retry
    }
  }

  private flushAtomicSnapshot(): void {
    const tmpPath = `${this.snapshotPath}.tmp`;
    writeFileSync(tmpPath, serializeWithBigInt({ ...this.state, securityAccounts: this.securityAccounts }), 'utf-8');
    renameSync(tmpPath, this.snapshotPath);
  }

  public findSecurityAccount(lookup: string): EncryptedAccount | undefined { return this.securityAccounts.find(account => account.lookup === lookup); }
  public findSecurityAccountById(id: string): EncryptedAccount | undefined { return this.securityAccounts.find(account => account.id === id); }
  public saveSecurityAccount(record: EncryptedAccount): void {
    const index = this.securityAccounts.findIndex(account => account.id === record.id);
    if (index >= 0) this.securityAccounts[index] = record; else this.securityAccounts.push(record);
    this.appendWalEntry('SECURITY_ACCOUNT_UPDATED', { id: record.id });
  }
  public listMarkets(): ConfigurableMarket[] {
    return this.state.markets;
  }

  public getMarket(marketId: number): ConfigurableMarket | undefined {
    return this.state.markets.find((m) => m.marketId === marketId);
  }

  public pruneExpiredEpochMarkets(nowMs: number = Date.now()): number {
    const activePositionMarketIds = new Set(
      this.state.positions.filter((p) => p.status === 'OPEN').map((p) => p.marketId)
    );
    const before = this.state.markets.length;
    this.state.markets = this.state.markets.filter((m) => {
      if (m.marketId <= 3 || !m.epochKey) return true;
      if (activePositionMarketIds.has(m.marketId)) return true;
      return !m.retentionExpiresAtMs || m.retentionExpiresAtMs > nowMs;
    });
    const removed = before - this.state.markets.length;
    if (removed > 0) {
      this.flushAtomicSnapshot();
    }
    return removed;
  }

  public upsertMarket(market: ConfigurableMarket): ConfigurableMarket {
    const idx = this.state.markets.findIndex((m) => m.marketId === market.marketId);
    if (idx >= 0) {
      this.state.markets[idx] = market;
    } else {
      this.state.markets.push(market);
    }
    this.appendWalEntry('UPSERT_MARKET', { marketId: market.marketId, status: market.status });
    return market;
  }

  public archiveResolvedEpochs(markets: ConfigurableMarket[]): void {
    const changed: number[] = [];
    for (const market of markets) {
      if (market.status !== 'RESOLVED' || !Number.isFinite(market.resolutionPriceCents) || market.resolutionPriceCents! <= 0 || market.resolvedOutcome === undefined) continue;
      const index = this.state.markets.findIndex(m => m.marketId === market.marketId);
      if (index >= 0 && this.state.markets[index].status === 'RESOLVED') continue;
      if (index >= 0) this.state.markets[index] = market; else this.state.markets.push(market);
      changed.push(market.marketId);
    }
    if (changed.length) this.appendWalEntry('ARCHIVE_RESOLVED_EPOCHS', { marketIds: changed });
  }

  public insertStake(stake: MarketStakeRecord): MarketStakeRecord {
    this.state.stakes.push(stake);
    this.appendWalEntry('INSERT_STAKE', stake);
    return stake;
  }

  public listStakesByMarket(marketId?: number): MarketStakeRecord[] {
    if (marketId === undefined) {
      return this.state.stakes;
    }
    return this.state.stakes.filter((s) => s.marketId === marketId);
  }

  public upsertPosition(position: MarketPositionRecord): MarketPositionRecord {
    const idx = this.state.positions.findIndex((p) => p.positionId === position.positionId);
    if (idx >= 0) {
      this.state.positions[idx] = position;
    } else {
      this.state.positions.unshift(position);
    }
    this.appendWalEntry('UPSERT_POSITION', position);
    return position;
  }

  public getPosition(positionId: string): MarketPositionRecord | undefined {
    return this.state.positions.find((p) => p.positionId === positionId);
  }

  public listPositions(filters?: {
    marketId?: number;
    status?: MarketPositionStatus;
    predictorAddress?: string;
  }): MarketPositionRecord[] {
    return this.state.positions.filter((p) => {
      if (filters?.marketId !== undefined && p.marketId !== filters.marketId) return false;
      if (filters?.status !== undefined && p.status !== filters.status) return false;
      if (
        filters?.predictorAddress !== undefined &&
        p.predictorAddress !== filters.predictorAddress
      ) {
        return false;
      }
      return true;
    });
  }

  public insertScheduledPayroll(job: ScheduledPayrollJob): ScheduledPayrollJob {
    this.state.scheduledPayrolls.push(job);
    this.appendWalEntry('INSERT_PAYROLL_SCHEDULE', job);
    return job;
  }

  public listScheduledPayrolls(): ScheduledPayrollJob[] {
    return this.state.scheduledPayrolls;
  }

  public insertNostrIdentity(proof: NostrBchIdentityProof): NostrBchIdentityProof {
    const existingIdx = this.state.nostrIdentities.findIndex(
      (p) => p.cashAddrZ === proof.cashAddrZ && p.npub === proof.npub
    );
    if (existingIdx >= 0) {
      this.state.nostrIdentities[existingIdx] = proof;
    } else {
      this.state.nostrIdentities.push(proof);
    }
    this.appendWalEntry('UPSERT_NOSTR_IDENTITY', proof);
    return proof;
  }

  public listNostrIdentities(): NostrBchIdentityProof[] {
    return this.state.nostrIdentities;
  }

  public exportFullSnapshot(): DatabaseSnapshot {
    return this.state;
  }
}
