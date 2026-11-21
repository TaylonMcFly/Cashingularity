import { ThemeContext } from './services/ThemeContext.js';
import { applyTheme, DARK_THEME_QUERY, readTheme, readThemePreference } from './services/appearance.js';
import { DappSessionHost } from './components/DappSessionHost.js';
import { AccountAuthorization } from './components/AccountAuthorization.js';
import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import {
  ArrowDownLeft,
  ArrowUpRight,
  BarChart3,
  Gamepad2,
  Layers,
  Wallet,
  Settings,
} from "lucide-react";
import {
  AiExecutionMode,
  ConfigurableMarket,
  createDefaultFxQuoteLock,
  ExecutionMode,
  estimateMinuteVolatility,
  generateEwmaVolatilityCone,
  type MarketBuy,
  type MarketPricingInput,
  satsToBchString,
} from "@cashingularity/shared";
import {
  fetchMarketCandlesApi,
  fetchMarketsAndTick,
  publishPaperBuy,
} from "./services/apiClient.js";
import {
  wizardWalletSingleton,
  type SignedTransactionReceipt,
} from "./services/walletRuntime.js";
import { QRCodeSVG } from 'qrcode.react';
import { ActionPopup } from './components/ActionPopup.js';
import { SettingsPage } from './components/SettingsPage.js';
import { ConnectedApps } from './components/ConnectedApps.js';
import type { PreparedPayment } from "./services/paymentService.js";
import { profileManager } from "./services/profileManager.js";
import { pauseWizardSessions, startWizardPairing } from './services/wizardSessions.js';
import { WalletProfiles } from "./components/WalletProfiles.js";
import { NotificationsMenu } from './components/NotificationsMenu.js';
import { WalletPortfolio } from './components/WalletPortfolio.js';
import { BlazeBanner } from "./components/BlazeBanner.js";
import { DynamicMarketCanvas } from "./components/DynamicMarketCanvas.js";
import { MarketExplorer } from "./components/MarketExplorer.js";
import { PayrollBatchSender } from "./components/PayrollBatchSender.js";
import { SendBch } from "./components/SendBch.js";
import { SessionWalletModal } from "./components/SessionWalletModal.js";
import {
  WalletDashboard,
  type WalletTransaction,
} from "./components/WalletDashboard.js";
import { hasFreshSpotObservation } from "./services/rateFreshness.js";
import { appSessions } from './services/connectedApps.js';
import { observeConfirmations, paperNoticeScope, paperResolutionNotices, visibleActivity, walletNoticeScope,
  type ActivityNotice, type WalletNoticeScope } from './services/activityNotices.js';
import {
  initialPaperAccount,
  paperAccountsReducer,
  type PaperWalletAction,
  exactPaperExpiryClose,
} from "./services/paperTrading.js";
import { liveMarketSlug, LIVE_SERIES_SLUGS } from "./services/marketRoutes.js";
import { bchSeries, findLiveEpoch, type MarketFeedState } from './services/marketEpochs.js';
import { ARCADE_PATHS, parseArcadePath, parseWorkspacePath, WORKSPACES, type ArcadeView, type Workspace } from './services/workspaceRoutes.js';

import {
  liveWalletHistory,
  mergeWalletTransactions,
  readTransactionHistory,
  reconcileWalletHistory,
  saveTransactionHistory,
  transactionAmounts,
} from "./services/transactionHistory.js";
type QuickAction = "send" | "receive" | "batch" | "apps";
const workspaceIcons = { '/wallet': Wallet, '/market': BarChart3, '/arcade': Gamepad2, '/settings': Settings };
const ChipnetProofPanel = React.lazy(() => import('./components/ChipnetProofPanel.js').then(module => ({ default: module.ChipnetProofPanel })));
const Arcade = React.lazy(() => import('./arcade/Arcade.js'));

export const App: React.FC = () => {
  const [chipnetProof] = useState(() => {
    if (!['http://localhost:3000', 'http://127.0.0.1:3000'].includes(location.origin)) return;
    const match = /^#chipnet-proof=(\d{1,5})\.([a-f0-9]{48})$/.exec(location.hash);
    const port = Number(match?.[1]);
    if (match && port > 0 && port <= 65535) return { port, token: match[2] };
  });
  const [appearance, setAppearance] = useState(readThemePreference);
  const [theme, setTheme] = useState(readTheme);
  useLayoutEffect(() => {
    const system = window.matchMedia(DARK_THEME_QUERY);
    const apply = () => setTheme(applyTheme(appearance, system.matches));
    apply();
    if (appearance !== 'system') return;
    system.addEventListener('change', apply);
    return () => system.removeEventListener('change', apply);
  }, [appearance]);
  const [pathname, setPathname] = useState(() => window.location.pathname);
  const { route, marketSlug: selectedSlug } = parseWorkspacePath(pathname);
  const [quickAction, setQuickAction] = useState<QuickAction | null>(() => parseWorkspacePath(pathname).batch ? 'batch' : null);
  const [receiveFormat, setReceiveFormat] = useState<"token" | "standard">("token");
  const [transactions, setTransactions] = useState<WalletTransaction[]>(readTransactionHistory);
  const transactionHistory = useRef(transactions);
  transactionHistory.current = transactions;
  const pendingConfirmations = useRef(new Map<WalletNoticeScope, Set<string>>());
  const [mode, setMode] = useState<ExecutionMode>("MAINNET_MODE");
  const [profileRevision, setProfileRevision] = useState(0);
  const profiles = useMemo(() => profileManager.list(), [profileRevision]);
  const lockedProfiles = useMemo(() => profileManager.getLockedProfiles(), [profileRevision]);
  const savedPairings = useMemo(() => profileManager.getSavedWizardProfiles(), [profileRevision]);
  const [analysisMode, setAnalysisMode] = useState<AiExecutionMode>("LOCAL");
  const [markets, setMarkets] = useState<ConfigurableMarket[]>([]);
  const [marketFeed, setMarketFeed] = useState<MarketFeedState>('loading');
  const [price, setPrice] = useState(500.45);
  const [priceSource, setPriceSource] = useState<"live" | "fallback">(
    "fallback",
  );
  const [spotFeed, setSpotFeed] = useState<string | null>(null);
  const [spotObservedAt, setSpotObservedAt] = useState<number | null>(null);
  const [paperAccounts, dispatchPaper] = useReducer(paperAccountsReducer, {});
  // The header switches the runtime to the simulator in Paper mode. Keep the last wallet's paper ledger selected.
  const [paperScope, setPaperScope] = useState('sandbox');
  const paperAccount = paperAccounts[paperScope] ?? initialPaperAccount;
  const allPaperPositions = useMemo(() => Object.values(paperAccounts).flatMap(account => account.positions), [paperAccounts]);
  const applyPaperAction = (action: PaperWalletAction) => dispatchPaper({ scopeId: paperScope, action });
  const [recordedBuys, setRecordedBuys] = useState<MarketBuy[]>([]);
  const [priceSamples, setPriceSamples] = useState<
    Array<{ time: number; value: number }>
  >([]);
  const arcadeMarket = useMemo(() => ({ price, fresh: priceSource === 'live', samples: priceSamples }), [price, priceSource, priceSamples]);
  const minuteVolatility = useMemo(() => estimateMinuteVolatility(priceSamples), [priceSamples]);
  const marketPricing: MarketPricingInput = {
    spot: priceSource === 'live' && spotObservedAt !== null ? { usd: price, timestampMs: spotObservedAt } : undefined,
    minuteVolatility,
    buys: mode === 'SANDBOX_MODE' ? [...paperAccount.buys, ...recordedBuys] : recordedBuys,
  };
  const [sigma, setSigma] = useState(0.0021);
  const [cone, setCone] = useState(() =>
    generateEwmaVolatilityCone({
      currentPrice: 500.45,
      muAiDrift: 0.00018,
      sigma: 0.0021,
      remainingSeconds: 300,
      steps: 25,
    }),
  );
  const [quote, setQuote] = useState(() => createDefaultFxQuoteLock());
  const [profile, setProfile] = useState(() =>
    wizardWalletSingleton.getAddresses(),
  );
  const lastLiveProfile = useRef<string>();
  const [syncingProfile, setSyncingProfile] = useState<string>();
  const [headerPanel, setHeaderPanel] = useState<'profile' | 'notifications'>();
  const [notices, setNotices] = useState<ActivityNotice[]>([]);
  const addNotices = useCallback((items: ActivityNotice[]) => {
    if (!items.length) return;
    setNotices(previous => {
      const seen = new Set(previous.map(item => item.id));
      const incoming = items.filter(item => {
        if (seen.has(item.id)) return false;
        seen.add(item.id);
        return true;
      });
      return incoming.length ? [...incoming, ...previous].sort((a, b) => b.timeMs - a.timeMs).slice(0, 80) : previous;
    });
  }, []);
  const demo = mode === 'SANDBOX_MODE';
  const activeProfileId = profileManager.getActiveId();
  const liveConnected = !demo && activeProfileId !== 'sandbox' && profile.isConnected && profile.utxoSource !== 'sandbox' &&
    profile.connectionType !== 'SANDBOX_DEMO';
  const liveNoticeScope = liveConnected ? walletNoticeScope(activeProfileId, profile.network) : undefined;
  const liveHistory = useMemo(() => profile.chainHistory && profile.chainHeight && liveConnected
    ? liveWalletHistory(profile.chainHistory, profile.receiveAddress, profile.network, profile.chainHeight) : [],
  [liveConnected, profile.chainHistory, profile.chainHeight, profile.receiveAddress, profile.network]);
  const walletHistory = useMemo(() => reconcileWalletHistory(liveHistory, transactions, activeProfileId), [liveHistory, transactions, activeProfileId]);
  const noticeScope = demo ? paperNoticeScope(paperScope) : liveNoticeScope;
  const appScope = liveConnected ? `${profile.network}:${activeProfileId}:${profile.receiveAddress}` : noticeScope ?? 'unconnected';
  const visibleNotices = visibleActivity(notices, noticeScope);
  const visibleNoticeIds = new Set(visibleNotices.map(notice => notice.id));
  const [modal, setModal] = useState(false);
  const [toast, setToast] = useState("");
  const notify = useCallback((message: string) => setToast(message), []);
  useEffect(() => profileManager.subscribe(() => setProfileRevision(revision => revision + 1)), []);
  useEffect(() => wizardWalletSingleton.subscribe(next => {
    profileManager.updateCurrent(next);
    setProfile(next);
  }), []);
  useEffect(() => {
    if (liveConnected && profile.utxoSource === 'syncing') void wizardWalletSingleton.refreshOnChainBalance().catch(() => {});
  }, [liveConnected, activeProfileId, profile.network, profile.utxoSource]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 5000);
    return () => clearTimeout(timer);
  }, [toast]);
  const [modalTab, setModalTab] = useState<
    "CONNECTED" | "WIZARD_CONNECT" | "BUILTIN_HD" | "RECEIVE_QR" | "IMPORT"
  >("WIZARD_CONNECT");
  const [upgradeProfileId, setUpgradeProfileId] = useState<string>();
  const [unlockProfileId, setUnlockProfileId] = useState<string>();
  useEffect(() => {
    const controller = new AbortController();
    let refreshing = false;
    const refresh = async () => {
      if (refreshing || document.visibilityState === 'hidden' || navigator.onLine === false) return;
      refreshing = true;
      try {
        const d = await fetchMarketsAndTick(AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]));
        if (controller.signal.aborted) return;
        const now = Date.now();
        const spot = d.spotObservation;
        const freshSpot = hasFreshSpotObservation(spot, now);
        if (d.markets) setMarkets(d.markets);
        setRecordedBuys(d.paperBuys);
        setMarketFeed(d.markets ? 'ready' : 'unavailable');
        setPrice(freshSpot ? spot.price : d.bchUsdPrice);
        setPriceSource(freshSpot ? "live" : "fallback");
        if (freshSpot || (d.recentTicks && d.recentTicks.length > 0)) {
          if (freshSpot) {
            setSpotFeed(spot.source!);
            setSpotObservedAt(spot.fetchedAtMs!);
          }
          setPriceSamples((previous) => {
            const byTime = new Map<number, number>();
            for (const item of previous) byTime.set(item.time, item.value);
            let changed = false;
            const add = (time: number, value: number) => {
              if (byTime.get(time) === value) return;
              byTime.set(time, value);
              changed = true;
            };
            for (const pt of d.recentTicks ?? []) {
              const t = Math.floor(pt.timestampMs / 1000);
              if (Number.isFinite(pt.priceUsd) && pt.priceUsd > 0) {
                add(t, pt.priceUsd);
              }
            }
            if (freshSpot) {
              add(Math.floor(spot.fetchedAtMs! / 1000), spot.price!);
            }
            if (!changed) return previous;
            return [...byTime.entries()]
              .sort(([a], [b]) => a - b)
              .slice(-720)
              .map(([time, value]) => ({ time, value }));
          });
          if (freshSpot) {
            dispatchPaper({
              type: "settle",
              price: spot.price!,
              fetchedAtMs: spot.fetchedAtMs!,
              nowMs: now,
            });
          }
        }
        setSigma(d.ewmaSigma);
        setCone(d.volatilityCone);
        setQuote(d.quoteLock);
      } finally { refreshing = false; }
    };
    void refresh();
    const timer = window.setInterval(refresh, route === '/market' ? 5_000 : 15_000);
    const wake = () => { if (document.visibilityState === 'visible') void refresh(); };
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('online', wake);
    return () => {
      controller.abort();
      clearInterval(timer);
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('online', wake);
    };
  }, [route]);
  useEffect(() => {
    const pop = () => {
      const path = window.location.pathname;
      setPathname(path);
      setQuickAction(parseWorkspacePath(path).batch ? 'batch' : null);
    };
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, []);
  useEffect(() => {
    let active = true;
    let timer = 0;
    const scheduleNext = (minimumDelay = 0) => {
      const now = Date.now();
      const next = allPaperPositions
        .filter((p) => p.status === "ACTIVE")
        .sort((a, b) => a.expiresAtMs - b.expiresAtMs)[0];
      if (active && next)
        timer = window.setTimeout(
          refreshSettlement,
          Math.max(minimumDelay, next.expiresAtMs - now),
        );
    };
    const refreshSettlement = async () => {
      try {
        const observedAt = Date.now();
        const expiredOverdue = allPaperPositions.some(
          (p) => p.status === "ACTIVE" && observedAt - p.expiresAtMs > 10_000,
        );
        if (expiredOverdue) {
          const candlesRes = await fetchMarketCandlesApi("1m", 120);
          if (active && candlesRes.candles.length > 0) {
            for (const pos of allPaperPositions) {
              if (pos.status !== "ACTIVE" || pos.expiresAtMs > observedAt) continue;
              const close = exactPaperExpiryClose(candlesRes.candles, pos.expiresAtMs);
              if (close !== undefined) {
                dispatchPaper({
                  type: "settle",
                  price: close,
                  fetchedAtMs: pos.expiresAtMs,
                  nowMs: observedAt,
                  historicalSettlement: true,
                  positionId: pos.id,
                });
              }
            }
          }
        }
        const response = await fetch("/api/rates?refresh=true", {
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) return;
        const data = (await response.json()) as {
          tick?: {
            bchUsdPrice?: number;
            spotSource?: string;
            spotFetchedAtMs?: number;
          };
        };
        const spot = {
          price: data.tick?.bchUsdPrice,
          source: data.tick?.spotSource,
          fetchedAtMs: data.tick?.spotFetchedAtMs,
        };
        const nowCheck = Date.now();
        if (active && hasFreshSpotObservation(spot, nowCheck))
          dispatchPaper({
            type: "settle",
            price: spot.price,
            fetchedAtMs: spot.fetchedAtMs,
            nowMs: nowCheck,
          });
      } catch {
        /* Keep the position pending when a fresh price is unavailable. */
      } finally {
        scheduleNext(2000);
      }
    };
    scheduleNext();
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [allPaperPositions]);
  useEffect(() => {
    if (!liveNoticeScope || !liveHistory.length) return;
    const receipts = transactionHistory.current.filter(row => row.address === profile.receiveAddress && row.network === profile.network);
    const result = observeConfirmations(activeProfileId, liveNoticeScope, pendingConfirmations.current.get(liveNoticeScope), liveHistory, receipts, Date.now());
    pendingConfirmations.current.set(liveNoticeScope, result.pending);
    addNotices(result.notices);
    const statuses = new Map(liveHistory.map(row => [row.txid, row.confirmed]));
    setTransactions(previous => {
      if (!previous.some(row => row.initiatorProfileId === activeProfileId && row.network === profile.network && statuses.has(row.txid) && row.confirmed !== statuses.get(row.txid))) return previous;
      return previous.map(row => row.initiatorProfileId === activeProfileId && row.network === profile.network && statuses.has(row.txid)
        ? { ...row, confirmed: statuses.get(row.txid) } : row);
    });
  }, [liveNoticeScope, activeProfileId, addNotices, liveHistory, profile.receiveAddress, profile.network]);
  useEffect(() => {
    if (!liveNoticeScope) return;
    const sessions = appSessions();
    return sessions.subscribe(() => addNotices(sessions.list(appScope).map(connection => ({
      id: `dapp:${connection.id}`, scope: liveNoticeScope, kind: 'connection',
      title: 'Application connected', detail: `${connection.name} · Address access`, timeMs: connection.startedAtMs,
    }))));
  }, [appScope, liveNoticeScope, addNotices]);
  const reportedResolutions = useRef(new Set<string>());
  useEffect(() => {
    if (!demo || marketFeed !== 'ready') return;
    const resolved = paperResolutionNotices(paperScope, paperAccount.positions, markets, Date.now()).filter(notice => {
      if (reportedResolutions.current.has(notice.id)) return false;
      reportedResolutions.current.add(notice.id);
      return true;
    });
    addNotices(resolved);
  }, [demo, paperScope, paperAccount.positions, markets, marketFeed, addNotices]);
  useEffect(() => {
    const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (icon) {
      icon.href = route === "/market" ? "/logo-market.png" : "/logo-wallet.png";
    }
  }, [route]);
  const updatePath = useCallback((path: string) => {
    if (window.location.pathname !== path) window.history.pushState({}, '', path);
    setPathname(path);
  }, []);
  const navigate = useCallback((next: Workspace) => {
    setHeaderPanel(undefined);
    setQuickAction(null);
    updatePath(WORKSPACES.find(workspace => workspace.route === next)!.path);
    window.scrollTo(0, 0);
  }, [updatePath]);
  const navigateArcade = useCallback((view: ArcadeView) => {
    setHeaderPanel(undefined);
    setQuickAction(null);
    updatePath(ARCADE_PATHS[view]);
    window.scrollTo(0, 0);
  }, [updatePath]);
  const arcadeToMarkets = useCallback(() => navigate('/market'), [navigate]);
  const openSend = () => setQuickAction('send');
  const refreshBalance = useCallback(async (showError = false) => {
    const id = profileManager.getActiveId();
    const before = wizardWalletSingleton.getAddresses();
    if (!before.isConnected || before.connectionType === 'SANDBOX_DEMO' || before.utxoSource === 'sandbox') return;
    const syncKey = `${id}:${before.network}`;
    const stillSelected = () => profileManager.getActiveId() === id && wizardWalletSingleton.getAddresses().network === before.network;
    setSyncingProfile(syncKey);
    try {
      const updated = await wizardWalletSingleton.refreshOnChainBalance(showError);
      if (stillSelected() && wizardWalletSingleton.getAddresses() === updated) {
        setProfile(updated);
      }
    } catch {
      if (stillSelected()) {
        setProfile(wizardWalletSingleton.getAddresses());
        if (showError) notify('Could not refresh the on-chain balance.');
      }
    } finally {
      setSyncingProfile(previous => previous === syncKey ? undefined : previous);
    }
  }, [notify]);
  const signingRequested = (payment: PreparedPayment) => {
    if (!liveNoticeScope || payment.profileId !== activeProfileId || payment.network !== profile.network || payment.receiveAddress !== profile.receiveAddress) return;
    addNotices([{
      id: `signing:${crypto.randomUUID()}`, scope: liveNoticeScope,
      kind: 'signing', title: 'Signature requested', detail: 'You requested approval for a BCH payment.', timeMs: Date.now(),
    }]);
  };
  const recordTransaction = (
    label: string,
    receipt: SignedTransactionReceipt,
    payment: PreparedPayment,
  ) => {
    if (!receipt.broadcasted) return;
    const scope = payment.profileId === activeProfileId && payment.network === profile.network && payment.receiveAddress === profile.receiveAddress ? liveNoticeScope : undefined;
    setTransactions((previous) => mergeWalletTransactions([
      {
        txid: receipt.txid,
        address: payment.receiveAddress,
        network: payment.network,
        label,
        timestamp: receipt.signedAtMs,
        confirmed: false,
        initiatorProfileId: scope ? activeProfileId : undefined,
        ...transactionAmounts(payment),
        priceUsd: payment.receiptPriceUsd ?? null,
      },
    ], previous));
    if (scope) {
      const pending = pendingConfirmations.current.get(scope) ?? new Set();
      pending.add(receipt.txid);
      pendingConfirmations.current.set(scope, pending);
      addNotices([{
        id: `transfer:${scope}:${receipt.txid}`, scope, kind: 'transfer', title: 'Transaction broadcast',
        detail: label, timeMs: receipt.signedAtMs,
      }]);
    }
    const current = wizardWalletSingleton.getAddresses();
    if (profileManager.getActiveId() === activeProfileId && current.receiveAddress === payment.receiveAddress && current.network === payment.network) {
      void wizardWalletSingleton.refreshOnChainBalance(true).catch(() => {});
    }
  };
  useEffect(()=>{try { saveTransactionHistory(transactions); } catch { notify("Transaction history could not be saved in this browser."); }},[transactions,notify]);
  const openMarket = (slug: string | null) => {
    const path = slug ? `/market/${slug}` : "/market";
    setQuickAction(null);
    updatePath(path);
    if (route !== '/market' || !slug || !selectedSlug) window.scrollTo(0, 0);
  };
  const open = (tab?: typeof modalTab, unlockId?: string) => {
    setUpgradeProfileId(undefined);
    setUnlockProfileId(unlockId);
    setModalTab(tab ?? (profileManager.list().some(p=>p.kind!=="sandbox") || profileManager.lockedCount()>0 || profileManager.getSavedWizardProfiles().length ? "CONNECTED" : "WIZARD_CONNECT"));
    setModal(true);
  };
  const openExisting = () => open('CONNECTED');
  const enableSigning = () => {
    if (profileManager.getActiveProfile().kind !== 'watch') return;
    setModalTab('CONNECTED');
    setUnlockProfileId(undefined);
    setUpgradeProfileId(profileManager.getActiveId());
    setModal(true);
  };
  const onWalletUpdated = useCallback(
    (next: ReturnType<typeof wizardWalletSingleton.getAddresses>) => {
      if (next !== wizardWalletSingleton.getAddresses()) return;
      profileManager.updateCurrent(next);
      const selectedId = profileManager.getActiveId();
      if (next.connectionType === 'SANDBOX_DEMO' || next.utxoSource === 'sandbox') {
        setMode('SANDBOX_MODE');
        if (selectedId !== 'sandbox') setPaperScope(selectedId);
        setProfile(selectedId === 'sandbox' ? next : profileManager.switchTo('sandbox'));
        return;
      }
      lastLiveProfile.current = selectedId;
      setPaperScope(selectedId);
      setProfile(next);
      setMode('MAINNET_MODE');
    },
    [],
  );
  useEffect(() => {
    const initial = wizardWalletSingleton.getAddresses();
    let active = true;
    let stop: (() => void) | undefined;
    const shouldActivate = () => active && wizardWalletSingleton.getAddresses() === initial;
    void profileManager.refreshWizardProfiles().then(() => {
      const preferred = profileManager.getPreferredWizardProfile();
      if (!preferred || !shouldActivate() || initial.isConnected) return;
      stop = startWizardPairing({
        profileId: preferred.id,
        shouldActivate: () => shouldActivate() && profileManager.getPreferredWizardProfile()?.id === preferred.id,
        onRestored: onWalletUpdated,
        onApproved: onWalletUpdated,
        onEnded: setProfile,
        onPairingCode: () => {},
        onStatus: () => {},
        onPersistenceError: () => {},
      });
    }).catch(() => {});
    return () => { active = false; stop?.(); };
  }, [onWalletUpdated]);
  const switchProfile = (id: string) => {
    try {
      onWalletUpdated(profileManager.switchTo(id));
      void refreshBalance();
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not switch profiles.');
    }
  };
  const switchSandbox = () => {
    if (!demo) onWalletUpdated(profileManager.switchTo('sandbox'));
  };
  const toggle = (next: ExecutionMode) => {
    if (next === 'SANDBOX_MODE') { switchSandbox(); return; }
    const resume = profileManager.list().find(item => item.id === lastLiveProfile.current && !item.paperOnly);
    if (resume) { switchProfile(resume.id); return; }
    setMode('MAINNET_MODE');
    setPaperScope('sandbox');
    setProfile(profileManager.switchTo('sandbox'));
  };
  const onWalletManaged = (next: ReturnType<typeof wizardWalletSingleton.getAddresses>) => {
    if (next.connectionType !== 'SANDBOX_DEMO') { onWalletUpdated(next); return; }
    setProfile(next);
    if (!demo) {
      lastLiveProfile.current = undefined;
      setPaperScope('sandbox');
    }
  };
  const balanceAvailable =
    demo ||
    (profile.isConnected &&
      profile.utxoSource !== "syncing" &&
      profile.utxoSource !== "unavailable" &&
      profile.utxoSource !== "sandbox");
  const displayBalance = demo ? paperAccount.balanceSats : profile.balanceSats;
  const liveFlash = marketFeed === 'ready' && priceSource === 'live' ? findLiveEpoch(markets, bchSeries('5m'), Date.now()) : undefined;
  const usdBalance = `$${((Number(displayBalance) / 1e8) * price).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const walletStatus = !liveConnected ? 'unconnected' : profile.connectionType === 'WATCH_ONLY' ? 'watch-only' :
    profile.connectionType === 'WIZARD_CONNECT' && !profile.externalSigningReady ? 'offline' : 'connected';
  const wallet = (
    <div className="wallet-panel">
      <div className="wallet-card" data-wallet-status={demo ? 'paper' : walletStatus}>
        <div className="wallet-card-heading">
          <span>
            <img
              src="/logo-wallet.png"
              alt="Cashingularity Wallet"
              className="wallet-brand-icon"
            />{" "}
            <strong>{demo ? 'Paper Trading Account' : profile.isConnected ? (profiles.find(item => item.active)?.name || 'Active Wallet') : 'Your wallet'}</strong>
          </span>
          <span className="wallet-status">
            {demo ? 'PAPER' : {
              'watch-only': 'WATCH-ONLY',
              offline: 'AWAITING WALLET',
              connected: 'ON-CHAIN',
              unconnected: 'NOT CONNECTED',
            }[walletStatus]}
          </span>

        </div>
        {!demo && !profile.isConnected && <button className="btn btn-primary wallet-connect" onClick={() => open('WIZARD_CONNECT')}>Connect Wallet</button>}
        {balanceAvailable && priceSource === "live" && (
          <>
            <p className="wallet-label">Total balance</p>
            <div className="wallet-balance">{usdBalance}</div>
          </>
        )}
        <p className="wallet-sub">
          {demo
            ? `${satsToBchString(displayBalance, 4)} BCH virtual strategy balance${priceSource === "live" ? " on live market data" : " · price data unavailable"}`
            : profile.isConnected
              ? profile.utxoSource === "syncing"
                ? "Refreshing on-chain balance…"
                : balanceAvailable
                  ? `${satsToBchString(profile.balanceSats, 8)} BCH · ${profile.utxos.length} UTXO(s)`
                  : "Balance unavailable"
              : "Connect wallet to view balance"}
        </p>
        {!demo && profile.isConnected && (
          <button
            className="wallet-address"
            onClick={() =>
              void navigator.clipboard.writeText(profile.receiveTokenAddress)
            }
          >
            <span>
              {profile.receiveTokenAddress.slice(0, 19)}…
              {profile.receiveTokenAddress.slice(-6)}
            </span>
            Copy
          </button>
        )}
        <div className="wallet-actions">
          <button onClick={openSend}>
            <ArrowUpRight />
            Send
          </button>
          <button onClick={() => setQuickAction("receive")}>
            <ArrowDownLeft />
            Receive
          </button>
          <button onClick={() => setQuickAction("batch")}>
            <Layers />
            Batch
          </button>
        </div>
      </div>
      <WalletPortfolio profile={profile} balanceSats={displayBalance} balanceAvailable={balanceAvailable}
        paper={demo} price={price} priceSource={priceSource} />
    </div>
  );
  const lockSession = () => {
    pauseWizardSessions();
    lastLiveProfile.current = undefined;
    setProfile(profileManager.logout());
    setPaperScope('sandbox');
    setMode('MAINNET_MODE');
    setQuickAction(null);
    notify('Wallet session locked.');
  };
  return (
    <ThemeContext.Provider value={theme}><div className="app-shell">
      <BlazeBanner
        mode={mode}
        network={liveConnected ? profile.network : 'mainnet'}
        walletStatus={walletStatus}
        onToggleMode={toggle}
        bchUsdPrice={price}
        priceSource={priceSource}
        activeRoute={route}
        onNavigate={navigate}
        walletSelector={<WalletProfiles open={headerPanel === 'profile'} onOpenChange={open => setHeaderPanel(current => open ? 'profile' : current === 'profile' ? undefined : current)}
          paper={demo} profiles={profiles} locked={lockedProfiles} appearance={appearance}
          savedPairings={savedPairings}
          onAppearance={setAppearance} onNavigate={navigate} onActivate={switchProfile}
          onCreate={() => open('BUILTIN_HD')} onImport={() => open('IMPORT')} onManage={id => open('CONNECTED', id)}
          onReconnect={id => open('WIZARD_CONNECT', id)} onSandbox={switchSandbox} />}
        notifications={<NotificationsMenu open={headerPanel === 'notifications'}
          onOpenChange={open => setHeaderPanel(current => open ? 'notifications' : current === 'notifications' ? undefined : current)}
          notices={visibleNotices} onRead={() => setNotices(previous => previous.map(item => visibleNoticeIds.has(item.id) ? { ...item, read: true } : item))} />}
      />
      <div className={`workspace-layout ${route === '/wallet' ? 'wallet-home-layout' : route === '/settings' ? 'settings-layout' : route === '/arcade' ? 'arcade-layout' : selectedSlug ? 'market-detail-layout' : ''}`}>
        <main className="center-workspace">
          {route === '/arcade' && <React.Suspense fallback={<p role="status">Loading Arcade…</p>}>
            <Arcade view={parseArcadePath(pathname) ?? 'home'} onNavigate={navigateArcade} market={arcadeMarket} onMarkets={arcadeToMarkets} />
          </React.Suspense>}
          {route === "/market" && !selectedSlug && (
            <MarketExplorer markets={markets} feed={marketFeed} paper={demo} pricing={marketPricing} onSelectMarket={market => openMarket(liveMarketSlug(market))} />
          )}
          {route === "/market" && selectedSlug && (
            <DynamicMarketCanvas
              theme={theme}
              walletProfile={profile}
              onSwitchSandbox={switchSandbox}
              markets={markets}
              selectedSlug={selectedSlug}
              marketFeed={marketFeed}
              onNavigateMarket={openMarket}
              bchUsdPrice={price}
              priceSamples={priceSamples}
              spotFeed={spotFeed}
              spotObservedAt={spotObservedAt}
              priceSource={priceSource}
              pricing={marketPricing}
              paperScope={paperScope}
              paperBalance={paperAccount.balanceSats}
              paperPositions={paperAccount.positions}
              onPaperStake={position => {
                applyPaperAction({ type: 'place', position });
                void publishPaperBuy(position);
              }}
              onPaperCashOut={applyPaperAction}
              ewmaSigma={sigma}
              volatilityCone={cone}
              mode={mode}
              analysisMode={analysisMode}
              onChangeAnalysisMode={setAnalysisMode}
              onRequestConnectWallet={() => open()}
              onRequestEnableSigning={enableSigning}
            />
          )}
          {route === '/wallet' && chipnetProof && <React.Suspense fallback={<p>Loading Chipnet proof…</p>}>
            <ChipnetProofPanel {...chipnetProof} profile={profile} paper={demo}/>
          </React.Suspense>}
          {route === '/wallet' && (
            <WalletDashboard profile={profile} balanceSats={displayBalance} balanceAvailable={balanceAvailable} paper={demo}
              price={price} priceSource={priceSource} priceSamples={priceSamples} transactions={walletHistory}
              paperPositions={paperAccount.positions}
              onSend={openSend} onReceive={() => setQuickAction('receive')} onBatch={() => setQuickAction('batch')}
              onApps={() => setQuickAction('apps')} onCreateProfile={() => open('BUILTIN_HD')} onExistingProfile={openExisting}
              onConnectExternal={() => open('WIZARD_CONNECT')}
              onExploreSandbox={switchSandbox} onEnableSigning={enableSigning}
              refreshing={syncingProfile === `${profileManager.getActiveId()}:${profile.network}`}
              onRefresh={() => { void refreshBalance(true); }}
              liveFlash={liveFlash} onBrowseMarkets={() => navigate('/market')} onOpenFlash={() => openMarket(LIVE_SERIES_SLUGS['5m'])}
              onSetPaperBalance={balanceSats => applyPaperAction({ type: 'setBalance', balanceSats })} />
          )}
          {route === '/settings' && <SettingsPage profile={profile} scope={appScope} mode={mode} onToggleMode={toggle} onProfileChange={onWalletManaged}
            onLock={lockSession} onNotify={notify} onConnect={openExisting} onEnableSigning={enableSigning} />}

        </main>
        {route === '/market' && !selectedSlug && <aside className="rabby-wallet-sidebar">{wallet}</aside>}
      </div>
      <nav className="mobile-bottom-nav" aria-label="Mobile navigation">
        {WORKSPACES.map((item) => {
          const Icon = workspaceIcons[item.route];
          return (
            <button
              key={item.route}
              onClick={() => navigate(item.route)}
              className={`mobile-nav-item ${route === item.route ? "active" : ""}`}
              aria-current={route === item.route ? 'page' : undefined}
            >
              <Icon size={20} />
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>
      <ActionPopup open={quickAction === 'send'} title="Send BCH" onClose={() => setQuickAction(null)}>
        <SendBch onSwitchPaper={switchSandbox} profile={profile} paperBalance={paperAccount.balanceSats}
          onPaperTransfer={totalSats => applyPaperAction({ type: 'transfer', totalSats })} active={quickAction === 'send'}
          mode={mode} analysisMode={analysisMode} onChangeAnalysisMode={setAnalysisMode}
          onRequestConnectWallet={() => open()} onRequestEnableSigning={enableSigning} onOpenBatch={() => setQuickAction('batch')}
          quoteLock={quote} onSigningRequested={signingRequested}
          onTransaction={(receipt, payment) => recordTransaction(payment.assetTransfer ? `${payment.assetTransfer.symbol} transfer · ${payment.assetTransfer.amount}` : 'BCH transfer', receipt, payment)} />
      </ActionPopup>
      <ActionPopup open={quickAction === 'batch'} title="Batch Pay" wide onClose={() => setQuickAction(null)}>
        <PayrollBatchSender active={quickAction === 'batch'} profile={profile} mode={mode} quoteLock={quote} analysisMode={analysisMode}
          onChangeAnalysisMode={setAnalysisMode} onRequestConnectWallet={openExisting} onRequestEnableSigning={enableSigning}
          onSigningRequested={signingRequested} onTransaction={(receipt, payment) => recordTransaction('Batch payment', receipt, payment)} />
      </ActionPopup>
      <ActionPopup open={quickAction === 'receive'} title="Receive BCH" onClose={() => setQuickAction(null)}><div className="receive-popup">{profile.isConnected && !demo ? <>
        <p className="portfolio-note">Bitcoin Cash · {profile.network}</p>
        <div className="receive-format"><button className="btn" aria-pressed={receiveFormat === 'token'} onClick={() => setReceiveFormat('token')}>Token-aware</button><button className="btn" aria-pressed={receiveFormat === 'standard'} onClick={() => setReceiveFormat('standard')}>Standard CashAddr</button></div>
        <div className="qr-box"><QRCodeSVG value={receiveFormat === 'token' ? profile.receiveTokenAddress : profile.receiveAddress} size={180}/></div>
        <label>{receiveFormat === 'token' ? 'Token-aware address' : 'Standard CashAddr'}<code>{receiveFormat === 'token' ? profile.receiveTokenAddress : profile.receiveAddress}</code></label>
        <button className="btn" onClick={() => void navigator.clipboard.writeText(receiveFormat === 'token' ? profile.receiveTokenAddress : profile.receiveAddress).then(() => notify('Address copied.')).catch(() => notify('Copy unavailable.'))}>Copy address</button>
      </> : <><p>Connect a live wallet to receive on-chain BCH.</p><button className="btn btn-primary" onClick={() => open()}>Connect wallet</button></>}</div></ActionPopup>
      <ActionPopup open={quickAction === 'apps'} title="Approvals & Connected Apps" wide onClose={() => setQuickAction(null)}><ConnectedApps scope={appScope} address={profile.isConnected && !demo ? profile.receiveTokenAddress : null}/></ActionPopup>
      <SessionWalletModal
        isOpen={modal}
        initialTab={modalTab}
        initialUpgradeProfileId={upgradeProfileId}
        initialUnlockProfileId={unlockProfileId}
        walletProfile={profile}
        paper={demo}
        onClose={() => setModal(false)}
        onWalletUpdated={onWalletUpdated}
        onWalletSessionEnded={setProfile}
        onWalletManaged={onWalletManaged}
        onSandbox={switchSandbox}
        onNotify={notify}
      />
      <DappSessionHost scope={appScope} profile={profile}/>
      <AccountAuthorization/>
      {toast && (
        <div className="wallet-toast" role="status">
          {toast}
        </div>
      )}
    </div></ThemeContext.Provider>
  );
};
