/**
 * @cashingularity/shared - Multi-Currency Batch Payroll Parser, Locale Normalizer & CashAddr Validator
 * BCH BLAZE 2026
 */

import {
  binToHex,
  CashAddressNetworkPrefix,
  CashAddressType,
  decodeCashAddress,
  encodeCashAddress,
  hexToBin,
  sha256,
} from '@bitauth/libauth';
import { bchToSats, fiatToSats, isAboveDustLimit } from './math.js';
import {
  BchNetwork,
  DUST_LIMIT_SATS,
  FxQuoteLock,
  PayrollBatchSummary,
  PayrollRow,
  PayrollValidationErrorCode,
  SupportedCurrency,
} from './types.js';

const CURRENCY_CODES: readonly SupportedCurrency[] = [
  'PUSD',
  'USDT',
  'USD',
  'EUR',
  'KZT',
  'RUB',
  'GBP',
  'BCH',
] as const;

const SYMBOL_TO_CURRENCY: Record<string, SupportedCurrency> = {
  $: 'USD',
  '€': 'EUR',
  '₽': 'RUB',
  '₸': 'KZT',
  '£': 'GBP',
};

/**
 * Default FX rates (how many BCH per 1 unit of currency) assuming 1 BCH = $500.00 USD
 */
export const DEFAULT_RATES_TO_BCH: Record<SupportedCurrency, number> = {
  BCH: 1.0,
  USD: 0.002,      // $500 / BCH
  PUSD: 0.002,     // USD reference unit; payouts settle in BCH
  USDT: 0.002,     // 1 USDT = $1.00
  EUR: 0.00216,    // 1 EUR = $1.08
  GBP: 0.00254,    // 1 GBP = $1.27
  KZT: 0.000004,   // 1 USD = 500 KZT
  RUB: 0.0000204,  // 1 USD = 98 RUB
};

/**
 * Creates a 60-second FX quote lock for deterministic batch payroll conversion.
 */
export function createDefaultFxQuoteLock(
  overrides?: Partial<Record<SupportedCurrency, number>>,
  nowMs: number = Date.now(),
  meta?: {
    fxSource?: string;
    fxFetchedAtMs?: number;
    spotSource?: string;
    spotFetchedAtMs?: number;
  }
): FxQuoteLock {
  const ratesToBch: Record<SupportedCurrency, number> = {
    ...DEFAULT_RATES_TO_BCH,
    ...(overrides ?? {}),
    PUSD: overrides?.PUSD ?? overrides?.USD ?? DEFAULT_RATES_TO_BCH.PUSD,
  };
  const bchUsdPrice = ratesToBch.USD > 0 ? Number((1 / ratesToBch.USD).toFixed(2)) : 500;
  return {
    quoteId: `fx-quote-${nowMs}`,
    ratesToBch,
    bchUsdPrice,
    lockedAtMs: nowMs,
    expiresAtMs: nowMs + 60_000,
    fxSource: meta?.fxSource ?? 'fallback',
    fxFetchedAtMs: meta?.fxFetchedAtMs ?? nowMs,
    spotSource: meta?.spotSource ?? 'fallback',
    spotFetchedAtMs: meta?.spotFetchedAtMs ?? nowMs,
  };
}

export interface CashAddrValidationResult {
  valid: boolean;
  standardAddress?: string;
  tokenAwareAddress?: string;
  network?: BchNetwork;
  error?: string;
}

/**
 * Validates a Bitcoin Cash address checksum using @bitauth/libauth decodeCashAddress
 * and derives both standard (q.../p...) and token-aware (z.../r...) CashAddr representations.
 */
export function validateAndConvertCashAddr(rawAddress: string): CashAddrValidationResult {
  const trimmed = rawAddress.trim();
  if (!trimmed) {
    return { valid: false, error: 'Empty CashAddr' };
  }

  // Normalize missing prefix if a bare 42-char CashAddr payload is provided
  let candidate = trimmed;
  if (!candidate.includes(':')) {
    const lower = candidate.toLowerCase();
    if (/^[qpzr][ac-hj-np-z02-9]{41}$/.test(lower)) {
      candidate = `bitcoincash:${lower}`;
    }
  } else {
    const [prefix, payload] = candidate.split(':');
    if (prefix && payload) {
      candidate = `${prefix.toLowerCase()}:${payload.toLowerCase()}`;
    }
  }

  const decoded = decodeCashAddress(candidate);
  if (typeof decoded === 'string') {
    return {
      valid: false,
      error: decoded,
    };
  }

  const prefix = decoded.prefix as CashAddressNetworkPrefix;
  const network: BchNetwork = prefix === 'bchtest' ? 'chipnet' : 'mainnet';

  const isP2sh =
    decoded.type === CashAddressType.p2sh || decoded.type === CashAddressType.p2shWithTokens;

  const standardType = isP2sh ? CashAddressType.p2sh : CashAddressType.p2pkh;
  const tokenType = isP2sh ? CashAddressType.p2shWithTokens : CashAddressType.p2pkhWithTokens;

  const stdEncoded = encodeCashAddress({
    prefix,
    type: standardType,
    payload: decoded.payload,
  });
  const tokenEncoded = encodeCashAddress({
    prefix,
    type: tokenType,
    payload: decoded.payload,
  });

  const standardAddress = typeof stdEncoded === 'string' ? stdEncoded : stdEncoded.address;
  const tokenAwareAddress = typeof tokenEncoded === 'string' ? tokenEncoded : tokenEncoded.address;

  return {
    valid: true,
    standardAddress,
    tokenAwareAddress,
    network,
  };
}

/**
 * Derives valid Chipnet (`bchtest:q...` and `bchtest:z...`) addresses from any valid CashAddr payload
 * using `@bitauth/libauth` `encodeCashAddress`.
 */
export function deriveChipnetAddresses(rawAddress = 'bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a'): {
  standardAddress: string;
  tokenAwareAddress: string;
} {
  const decoded = decodeCashAddress(rawAddress);
  const payload =
    typeof decoded === 'string'
      ? new Uint8Array(20).fill(0x11)
      : decoded.payload;

  const stdEncoded = encodeCashAddress({
    prefix: CashAddressNetworkPrefix.testnet,
    type: CashAddressType.p2pkh,
    payload,
  });
  const tokenEncoded = encodeCashAddress({
    prefix: CashAddressNetworkPrefix.testnet,
    type: CashAddressType.p2pkhWithTokens,
    payload,
  });

  return {
    standardAddress: typeof stdEncoded === 'string' ? stdEncoded : stdEncoded.address,
    tokenAwareAddress: typeof tokenEncoded === 'string' ? tokenEncoded : tokenEncoded.address,
  };
}

/**
 * Derives a valid 32-byte P2SH32 covenant CashAddress (`bitcoincash:p...` / `bchtest:p...`),
 * token-aware address (`bitcoincash:r...` / `bchtest:r...`), and `OP_HASH256 <32-byte-hash> OP_EQUAL`
 * locking bytecode (`aa20...87`) strictly from `hash256(redeemScript)` (`sha256(sha256(redeemScriptBytes))`).
 */
export function deriveP2sh32FromRedeemScript(
  redeemScriptHex: string,
  network: BchNetwork = 'mainnet'
): {
  standardAddress: string;
  tokenAwareAddress: string;
  lockingBytecodeHex: string;
  scriptHashHex: string;
  scriptHash32Hex: string;
  redeemScriptHex: string;
  network: BchNetwork;
} {
  const cleanHex = redeemScriptHex.trim().toLowerCase();
  if (!cleanHex || cleanHex.length % 2 !== 0 || !/^[0-9a-f]+$/.test(cleanHex)) {
    throw new Error('Invalid redeemScriptHex: expected non-empty even-length hexadecimal bytecode.');
  }

  const redeemBytes = hexToBin(cleanHex);
  const hash256Payload = sha256.hash(sha256.hash(redeemBytes));
  const prefix =
    network === 'chipnet'
      ? CashAddressNetworkPrefix.testnet
      : CashAddressNetworkPrefix.mainnet;

  const stdEncoded = encodeCashAddress({
    prefix,
    type: CashAddressType.p2sh,
    payload: hash256Payload,
  });
  const tokenEncoded = encodeCashAddress({
    prefix,
    type: CashAddressType.p2shWithTokens,
    payload: hash256Payload,
  });

  const scriptHash32Hex = binToHex(hash256Payload);
  return {
    standardAddress: typeof stdEncoded === 'string' ? stdEncoded : stdEncoded.address,
    tokenAwareAddress: typeof tokenEncoded === 'string' ? tokenEncoded : tokenEncoded.address,
    lockingBytecodeHex: `aa20${scriptHash32Hex}87`,
    scriptHashHex: scriptHash32Hex,
    scriptHash32Hex,
    redeemScriptHex: cleanHex,
    network,
  };
}

/**
 * Compiles a tagged P2PKH CashVM redeemScript for a contract identifier and optional recovery PKH,
 * then derives its exact `P2SH32` address via `hash256(redeemScript)` (never raw label hashing).
 */
export function deriveP2sh32CashAddr(
  seedOrIdentifier: string,
  network: BchNetwork = 'mainnet',
  signerPkhHex = '086a977c7dad32a56996af2ce90a727238d48998'
): {
  standardAddress: string;
  tokenAwareAddress: string;
  lockingBytecodeHex: string;
  scriptHashHex: string;
  scriptHash32Hex: string;
  redeemScriptHex: string;
  network: BchNetwork;
} {
  const cleanPkh = signerPkhHex.trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(cleanPkh)) {
    throw new Error('Invalid signerPkhHex: expected 20-byte (40-char hex) pubkey hash.');
  }
  const tagDigest = sha256.hash(
    new TextEncoder().encode(`cashingularity-p2sh32-v1:${seedOrIdentifier}`)
  );
  // <32B tagDigest> OP_DROP OP_DUP OP_HASH160 <20B signerPkh> OP_EQUALVERIFY OP_CHECKSIG
  const redeemScriptHex = `20${binToHex(tagDigest)}7576a914${cleanPkh}88ac`;
  return deriveP2sh32FromRedeemScript(redeemScriptHex, network);
}

/**
 * Parses localized numeric strings into a JavaScript number:
 * - US/UK: "1,250.50" -> 1250.5
 * - EU/CIS space thousands + comma decimal: "1 250,50" -> 1250.5
 * - EU dot thousands + comma decimal: "1.250,50" -> 1250.5
 * - Simple comma decimal: "125,50" or "0,005" -> 125.5 / 0.005
 * - Negative numbers: "-50.25" -> -50.25
 */
export function parseLocaleNumber(raw: string): number {
  const cleaned = raw
    .replace(/[\u00A0\u202F\s]/g, '') // Strip spaces & non-breaking spaces used as thousands separators
    .trim();

  if (!cleaned) {
    return NaN;
  }

  const signMatch = cleaned.match(/^([+-])?(.*)$/);
  if (!signMatch) {
    return NaN;
  }
  const sign = signMatch[1] === '-' ? -1 : 1;
  let body = signMatch[2];

  if (!body || !/\d/.test(body)) {
    return NaN;
  }

  const lastComma = body.lastIndexOf(',');
  const lastDot = body.lastIndexOf('.');

  if (lastComma !== -1 && lastDot !== -1) {
    if (lastComma > lastDot) {
      // Format like 1.250,50 -> dots are thousands, last comma is decimal
      body = body.replace(/\./g, '').replace(',', '.');
    } else {
      // Format like 1,250.50 -> commas are thousands, last dot is decimal
      body = body.replace(/,/g, '');
    }
  } else if (lastComma !== -1) {
    const commaCount = (body.match(/,/g) || []).length;
    if (commaCount > 1) {
      // Format like 1,250,000 -> all commas are thousands separators
      body = body.replace(/,/g, '');
    } else {
      // Single comma: check if original string had spaces ("1 250,50") or if comma is decimal
      const hadSpaceGrouping = /[\d][\u00A0\u202F\s][\d]/.test(raw.trim());
      const parts = body.split(',');
      const afterComma = parts[1] ?? '';
      // If there was space grouping, or if digits after comma != 3, or if before comma is "0", treat comma as decimal
      if (hadSpaceGrouping || afterComma.length !== 3 || parts[0] === '0') {
        body = `${parts[0]}.${afterComma}`;
      } else {
        // Ambiguous "1,250" -> standard thousands separator if beforeComma is 1..3 digits and not 0
        body = `${parts[0]}${afterComma}`;
      }
    }
  } else if (lastDot !== -1) {
    const dotCount = (body.match(/\./g) || []).length;
    if (dotCount > 1) {
      // Multiple dots like 1.250.000 -> thousands separators
      body = body.replace(/\./g, '');
    }
  }

  if (!/^\d+(\.\d+)?$/.test(body)) {
    return NaN;
  }

  const parsed = Number(body);
  return Number.isFinite(parsed) ? sign * parsed : NaN;
}

/**
 * Extracts currency code or symbol from a text segment.
 */
export function detectCurrency(text: string): {
  currency: SupportedCurrency | null;
  remainingText: string;
} {
  let working = text.trim();

  // 1. Check currency symbols first ($, €, ₽, ₸, £)
  for (const [symbol, curr] of Object.entries(SYMBOL_TO_CURRENCY)) {
    if (working.includes(symbol)) {
      working = working.replace(symbol, ' ').trim();
      return { currency: curr, remainingText: working };
    }
  }

  // 2. Check explicit currency codes (case-insensitive word boundary)
  for (const code of CURRENCY_CODES) {
    const regex = new RegExp(`(?:^|[^a-zA-Z0-9])(${code})(?=$|[^a-zA-Z0-9])`, 'i');
    const match = working.match(regex);
    if (match) {
      const idx = match.index ?? 0;
      const matchedToken = match[1];
      const tokenStart = working.toUpperCase().indexOf(matchedToken.toUpperCase(), idx);
      if (tokenStart !== -1) {
        working = (
          working.slice(0, tokenStart) +
          ' ' +
          working.slice(tokenStart + matchedToken.length)
        ).trim();
      }
      return { currency: code, remainingText: working };
    }
  }

  return { currency: null, remainingText: working };
}

/**
 * Parses a single line of payroll input (supports BIP21 URIs, delimiters, mixed locales, and currency symbols/codes).
 */
export function parsePayrollLine(
  rawLine: string,
  rowIndex: number,
  quoteLock: FxQuoteLock
): PayrollRow {
  const trimmed = rawLine.trim();
  const errors: PayrollValidationErrorCode[] = [];
  const errorMessages: string[] = [];

  // 1. Extract address or BIP21 URI from the start of the line
  // Match optional prefix (bitcoincash: or bchtest:) + address token + optional ?query
  const addressTokenMatch = trimmed.match(
    /^((?:(?:bitcoincash|bchtest):)?[^\s,;|—–\t-]+)(.*)$/i
  );

  let rawAddressPart = addressTokenMatch ? addressTokenMatch[1].trim() : trimmed;
  let remainderPart = addressTokenMatch ? addressTokenMatch[2].trim() : '';
  // Canonical draft lines may have an intentionally empty recipient.
  if (trimmed.startsWith('|')) { rawAddressPart = ''; remainderPart = trimmed.slice(1).trim(); }

  // Handle cases where ":" was used as a delimiter after a bare address (e.g. "qpm2...: 100 USD")
  if (
    rawAddressPart.includes(':') &&
    !/^(bitcoincash|bchtest):/i.test(rawAddressPart)
  ) {
    const firstColon = rawAddressPart.indexOf(':');
    remainderPart = `${rawAddressPart.slice(firstColon + 1)} ${remainderPart}`.trim();
    rawAddressPart = rawAddressPart.slice(0, firstColon).trim();
  }

  // Handle cases where ":" was used as a delimiter after a prefixed CashAddr (e.g. "bitcoincash:qpm2...:100 USD")
  if (/^(bitcoincash|bchtest):/i.test(rawAddressPart)) {
    const firstColon = rawAddressPart.indexOf(':');
    const secondColon = rawAddressPart.indexOf(':', firstColon + 1);
    if (secondColon !== -1) {
      remainderPart = `${rawAddressPart.slice(secondColon + 1)} ${remainderPart}`.trim();
      rawAddressPart = rawAddressPart.slice(0, secondColon).trim();
    }
  }

  let isBip21 = false;
  let recipientAddress = rawAddressPart;
  let rawAmountText = '';
  let parsedAmount = NaN;
  let currency: SupportedCurrency | null = null;
  let label: string | undefined;

  // Check if rawAddressPart is a BIP21 URI with query parameters (?amount=...)
  if (rawAddressPart.includes('?')) {
    isBip21 = true;
    const [addrOnly, queryString] = rawAddressPart.split('?', 2);
    recipientAddress = addrOnly;
    const params = new URLSearchParams(queryString);
    const amountParam = params.get('amount') ?? '';
    const currencyParam = (params.get('currency') ?? 'BCH').toUpperCase();
    const labelParam = params.get('label') ?? params.get('message');
    if (labelParam) {
      label = labelParam;
    }
    rawAmountText = amountParam;
    parsedAmount = parseLocaleNumber(amountParam);
    if (CURRENCY_CODES.includes(currencyParam as SupportedCurrency)) {
      currency = currencyParam as SupportedCurrency;
    } else {
      currency = null;
    }
  } else {
    // Strip leading delimiters (-, ;, :, |, \t, ,) while preserving negative sign before digits (e.g. -50)
    const cleanRemainder = remainderPart.replace(/^(?:[\s;:|,\t—–]+|-(?!\d))+/, '').trim();

    // Detect currency code or symbol
    // A pipe-delimited label is metadata, never a currency instruction.
    const labelStart = cleanRemainder.indexOf('|');
    const amountSection = labelStart < 0 ? cleanRemainder : cleanRemainder.slice(0, labelStart);
    const detected = detectCurrency(amountSection);
    if (labelStart >= 0) detected.remainingText += ` ${cleanRemainder.slice(labelStart)}`;
    currency = detected.currency;

    // Extract numeric expression (supporting optional +/-, digits, spaces between digits, commas, dots)
    const remAfterCurrency = detected.remainingText
      .replace(/^(?:[\s;:|,\t—–]+|-(?!\d))+/, '')
      .trim();

    const numMatch = remAfterCurrency.match(
      /^([+-]?\d(?:[\d\u00A0\u202F\s.,]*\d)?|[+-]?\d+(?:[.,]\d+)?)(.*)$/
    );

    if (numMatch) {
      rawAmountText = numMatch[1].trim();
      parsedAmount = parseLocaleNumber(rawAmountText);
      const trailingLabel = numMatch[2].replace(/^[\s\-;:|,\t—–]+/, '').trim();
      if (trailingLabel) {
        label = trailingLabel;
      }
    } else {
      rawAmountText = remAfterCurrency;
      parsedAmount = NaN;
    }
  }

  // 2. Validate CashAddr Checksum via @bitauth/libauth
  const addrValidation = validateAndConvertCashAddr(recipientAddress);
  if (!addrValidation.valid) {
    errors.push('INVALID_CHECKSUM');
    errorMessages.push(
      `Invalid BCH CashAddr checksum for "${recipientAddress}": ${addrValidation.error ?? 'verification failed'}`
    );
  }

  // 3. Validate Amount (NAN_AMOUNT vs NEGATIVE_OR_ZERO)
  if (!rawAmountText || Number.isNaN(parsedAmount)) {
    errors.push('NAN_AMOUNT');
    errorMessages.push(`Invalid or missing numeric amount ("${rawAmountText || 'empty'}")`);
  } else if (parsedAmount <= 0) {
    errors.push('NEGATIVE_OR_ZERO');
    errorMessages.push(`Amount must be strictly positive (got ${parsedAmount})`);
  }

  // 4. Validate Currency Presence
  if (!currency) {
    errors.push('MISSING_CURRENCY');
    errorMessages.push(
      'Missing currency code or symbol (supported: USD, EUR, KZT, RUB, GBP, USDT, PUSD, BCH or $, €, ₽, ₸, £)'
    );
  }

  // 5. Calculate satoshis in strict BigInt and check dust limit (546n sats)
  let exchangeRateBchPerUnit = 0;
  let calculatedSats = 0n;

  if (currency && !Number.isNaN(parsedAmount) && parsedAmount > 0) {
    exchangeRateBchPerUnit = quoteLock.ratesToBch[currency] ?? 0;
    try {
      calculatedSats = currency === 'BCH' ? bchToSats(parsedAmount) : fiatToSats(parsedAmount, exchangeRateBchPerUnit);
      if (calculatedSats > 2_100_000_000_000_000n) throw new Error('Amount exceeds the BCH supply.');
    } catch {
      calculatedSats = 0n;
      errors.push('NAN_AMOUNT');
      errorMessages.push('Amount cannot be represented safely in satoshis.');
    }

    if (!isAboveDustLimit(calculatedSats)) {
      errors.push('BELOW_DUST_LIMIT');
      errorMessages.push(
        `Calculated output (${calculatedSats.toString()} sats) is below BCH dust limit (${DUST_LIMIT_SATS.toString()} sats)`
      );
    }
  }

  return {
    rowIndex,
    rawLine,
    recipientAddress: addrValidation.standardAddress ?? recipientAddress,
    tokenAwareAddress: addrValidation.tokenAwareAddress,
    network: addrValidation.network,
    rawAmountText,
    parsedAmount,
    currency,
    exchangeRateBchPerUnit,
    calculatedSats,
    label,
    isBip21,
    isValid: errors.length === 0,
    errors,
    errorMessages,
  };
}

/**
 * Interactive per-row block editor helper: updates a row's address, amount, or currency
 * and immediately re-runs checksum validation, BigInt conversion, and dust checks.
 */
export function recalculatePayrollRow(
  row: PayrollRow,
  updates: Partial<{
    recipientAddress: string;
    rawAmountText: string;
    currency: SupportedCurrency | null;
    label: string;
  }>,
  quoteLock: FxQuoteLock = createDefaultFxQuoteLock()
): PayrollRow {
  const nextAddress = updates.recipientAddress ?? row.recipientAddress;
  const nextAmountText = updates.rawAmountText ?? row.rawAmountText;
  const nextCurrency = updates.currency !== undefined ? updates.currency : row.currency;
  const nextLabel = updates.label !== undefined ? updates.label : row.label;

  const syntheticLine = `${nextAddress} | ${nextAmountText} ${nextCurrency ?? ''}${
    nextLabel ? ` | ${nextLabel}` : ''
  }`;
  return parsePayrollLine(syntheticLine, row.rowIndex, quoteLock);
}

/**
 * Parses a multi-line batch payroll string into validated rows and live BigInt totals.
 * Never silently skips invalid rows.
 */
export function parsePayrollText(
  multiLineText: string,
  quoteLock: FxQuoteLock = createDefaultFxQuoteLock()
): PayrollBatchSummary {
  if (typeof multiLineText !== 'string') {
    throw new Error('Payroll input must be a text string.');
  }
  if (multiLineText.length > 262_144) {
    throw new Error('Payroll input exceeds maximum allowed size (256 KiB).');
  }

  const rawLines = multiLineText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (rawLines.length > 500) {
    throw new Error('Payroll batch exceeds 500 recipient limit.');
  }

  const rows: PayrollRow[] = rawLines.map((line, idx) =>
    parsePayrollLine(line, idx, quoteLock)
  );

  let validCount = 0;
  let invalidCount = 0;
  let totalSats = 0n;

  for (const row of rows) {
    if (row.isValid) {
      validCount++;
      totalSats += row.calculatedSats;
    } else {
      invalidCount++;
    }
  }

  // Estimate miner fee at 1 sat/byte (~148B input + 34B per output + 10B header)
  const estimatedMinerFeeSats =
    validCount > 0 ? 192n + BigInt(validCount) * 34n : 0n;
  const grandTotalSats = totalSats + estimatedMinerFeeSats;

  return {
    rows,
    validCount,
    invalidCount,
    totalSats,
    estimatedMinerFeeSats,
    grandTotalSats,
    allValid: rows.length > 0 && invalidCount === 0,
    quoteLock,
  };
}

/** Currency names describe the input unit; every payment output is native BCH. */
export const PAYROLL_CURRENCY_NAMES: Record<SupportedCurrency, string> = {
  USD: 'United States Dollar (USD)', USDT: 'Tether — Crypto / Tron (USDT)',
  PUSD: 'Parity USD — CashTokens (PUSD)', EUR: 'Euro (EUR)',
  KZT: 'Kazakhstani Tenge (KZT)', RUB: 'Russian Ruble (RUB)',
  GBP: 'British Pound (GBP)', BCH: 'Bitcoin Cash (BCH)',
};
export const PAYROLL_CURRENCIES = Object.keys(PAYROLL_CURRENCY_NAMES) as SupportedCurrency[];
export interface PayrollDraftRow {
  recipientAddress: string;
  rawAmountText: string;
  currency: SupportedCurrency | null;
  label?: string;
  sourceLine?: string;
  currencyInput?: string;
}
export function createPayrollDraft(count = 4): PayrollDraftRow[] {
  return Array.from({ length: Math.min(100, Math.max(0, count)) }, () => ({ recipientAddress: '', rawAmountText: '', currency: 'USD' }));
}
export function serializePayrollDraft(rows: PayrollDraftRow[]): string {
  return rows.map(row => row.sourceLine ?? `${row.recipientAddress.trim()} | ${row.rawAmountText.trim()} ${row.currencyInput ?? row.currency ?? ''}${row.label ? ` | ${row.label.replace(/[\r\n]/g, ' ')}` : ''}`).join('\n');
}
export function parsePayrollDraft(text: string, quote: FxQuoteLock = createDefaultFxQuoteLock()): PayrollDraftRow[] {
  if (!text.trim()) return [];
  return parsePayrollText(text, quote).rows.map(row => ({ recipientAddress: row.recipientAddress, rawAmountText: row.rawAmountText, currency: row.currency, currencyInput: row.currency ? undefined : row.rawLine.match(/\|\s*[+-]?\d[\d\s.,]*\s+([a-z]{2,12})\s*(?:\||$)/i)?.[1], label: row.label, sourceLine: row.rawLine }));
}
export function editPayrollDraft(rows: PayrollDraftRow[], index: number, updates: Partial<PayrollDraftRow>): PayrollDraftRow[] {
  return rows.map((row, i) => i === index ? { ...row, ...updates, sourceLine: undefined } : row);
}

/** Only exact, explicit units are recognized; unknown text is never treated as BCH. */
export function normalizePayrollCurrency(value: string): SupportedCurrency | null {
  const normalized = value.trim().toUpperCase();
  if (normalized in SYMBOL_TO_CURRENCY) return SYMBOL_TO_CURRENCY[normalized];
  return CURRENCY_CODES.includes(normalized as SupportedCurrency) ? normalized as SupportedCurrency : null;
}
