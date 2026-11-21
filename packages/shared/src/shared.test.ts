import { describe, expect, it } from 'vitest';
import {
  bchToSats,
  fiatToSats,
  calculateExactParimutuelPayout,
  calculateParimutuelMultiplier,
  computeEwmaSigma,
  decodeNftReceiptCommitment,
  deriveHdCoordinate,
  DUST_LIMIT_SATS,
  encodeNftReceiptCommitment,
  generateEwmaVolatilityCone,
  generateParimutuelMultiplierCurve,
  isAboveDustLimit,
  satsToBchString,
} from './index.js';
import {
  createDefaultFxQuoteLock,
  PAYROLL_CURRENCY_NAMES,
  createPayrollDraft,
  editPayrollDraft,
  parsePayrollDraft,
  serializePayrollDraft,
  parseLocaleNumber,
  parsePayrollText,
  parsePayrollLine,
  recalculatePayrollRow,
  validateAndConvertCashAddr,
} from './payrollParser.js';

// Known valid Mainnet & Chipnet CashAddr fixtures
const VALID_MAINNET_Q = 'bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a';
const VALID_MAINNET_BARE = 'qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a';
const INVALID_CHECKSUM_ADDR = 'bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6b';

describe('@cashingularity/shared - Strict BigInt Math & Parimutuel Engine', () => {
  it('enforces 546n satoshi dust threshold and exact BigInt BCH conversion', () => {
    expect(DUST_LIMIT_SATS).toBe(546n);
    expect(isAboveDustLimit(545n)).toBe(false);
    expect(isAboveDustLimit(546n)).toBe(true);
    expect(isAboveDustLimit(100_000_000n)).toBe(true);

    expect(bchToSats('1')).toBe(100_000_000n);
    expect(bchToSats('0.00000546')).toBe(546n);
    expect(bchToSats(1.25)).toBe(125_000_000n);
    expect(satsToBchString(125_000_000n)).toBe('1.25');
    expect(satsToBchString(546n)).toBe('0.00000546');
  });

  it('rejects unsafe fiat conversion and preserves oversized invalid payroll rows without throwing', () => {
    expect(() => fiatToSats(1e300, 1e10)).toThrow(/safe satoshi precision/);
    for (const currency of ['BCH', 'USD']) {
      const batch = parsePayrollText(`${VALID_MAINNET_Q} | ${'9'.repeat(250)} ${currency}`);
      expect(batch.rows).toHaveLength(1);
      expect(batch.rows[0].isValid).toBe(false);
      expect(batch.rows[0].errors).toContain('NAN_AMOUNT');
      expect(batch.totalSats).toBe(0n);
    }
  });

  it('never wraps receipt integers or silently accepts malformed commitment bytes', () => {
    const valid = { marketId: 1, bucketId: 0, stakeSats: 546n };
    expect(() => encodeNftReceiptCommitment({ ...valid, marketId: 0x100000000 })).toThrow(/uint32/);
    expect(() => encodeNftReceiptCommitment({ ...valid, bucketId: 256 })).toThrow(/uint8/);
    expect(() => encodeNftReceiptCommitment({ ...valid, stakeSats: -1n })).toThrow(/uint64/);
    expect(() => decodeNftReceiptCommitment('gg'.repeat(13))).toThrow(/hex/);
    expect(() => decodeNftReceiptCommitment(new Uint8Array(14))).toThrow(/length/);
    const encoded = encodeNftReceiptCommitment({ ...valid, entryPriceCents: 20000, flagsHex: '000000' });
    expect(decodeNftReceiptCommitment(encoded).flagsHex).toBe('000000');
  });

  it('never recognizes currency codes in labels as a payment unit and preserves typed unknown units', () => {
    const line = `${VALID_MAINNET_Q} | 25 XYZ | USD accounting team`;
    const row = parsePayrollLine(line, 0, createDefaultFxQuoteLock());
    expect(row.isValid).toBe(false); expect(row.errors).toContain('MISSING_CURRENCY');
    expect(parsePayrollDraft(line)[0].currencyInput).toBe('XYZ');
    expect(parsePayrollDraft('')).toEqual([]);
    const draft = editPayrollDraft(createPayrollDraft(1), 0, { recipientAddress: VALID_MAINNET_Q, rawAmountText: '50', currency: 'PUSD', currencyInput: 'pusd' });
    expect(parsePayrollDraft(serializePayrollDraft(draft))[0].currency).toBe('PUSD');
  });
  it('confirms PUSD case-insensitively and converts its USD reference amount into BCH', () => {
    const quote = createDefaultFxQuoteLock({ USD: 0.004 });
    const parsed = parsePayrollText(`${VALID_MAINNET_Q} | 25 pusd`, quote);
    expect(parsed.allValid).toBe(true);
    expect(parsed.rows[0].currency).toBe('PUSD');
    expect(parsed.rows[0].calculatedSats).toBe(10000000n);
    expect(PAYROLL_CURRENCY_NAMES.PUSD).toBe('Parity USD — CashTokens (PUSD)');
    expect(parsePayrollText(`${VALID_MAINNET_Q}?amount=25&currency=BOGUS`, quote).rows[0].errors).toContain('MISSING_CURRENCY');
  });
  it('round-trips editable draft rows and raw paste without losing blank rows or locale amounts', () => {
    const rows = editPayrollDraft(createPayrollDraft(), 0, { recipientAddress: VALID_MAINNET_Q, rawAmountText: '1 250,50', currency: 'PUSD' });
    const restored = parsePayrollDraft(serializePayrollDraft(rows));
    expect(restored).toHaveLength(4);
    expect(restored[0]).toMatchObject({ recipientAddress: VALID_MAINNET_Q, rawAmountText: '1 250,50', currency: 'PUSD' });
    expect(restored[1].recipientAddress).toBe('');
    expect(restored[1].rawAmountText).toBe('');
  });

  it('derives standard BIP44 HD paths for receive (0), change (1), and defi (2)', () => {
    const receive0 = deriveHdCoordinate('receive', 0);
    const change3 = deriveHdCoordinate('change', 3);
    const defi1 = deriveHdCoordinate('defi', 1);

    expect(receive0.fullPath).toBe("m/44'/145'/0'/0/0");
    expect(change3.fullPath).toBe("m/44'/145'/0'/1/3");
    expect(defi1.fullPath).toBe("m/44'/145'/0'/2/1");
  });

  it('computes dynamic parimutuel payout multiplier M_i(t, delta_s) in < 4ms', () => {
    const result = calculateParimutuelMultiplier({
      totalPoolSats: 1_000_000n,
      bucketPoolSats: 400_000n,
      deltaStakeSats: 100_000n,
      feeBps: 100n, // 1%
      outputDustCount: 1n,
    });

    // Winning principal is 500,000 sats. The 600,000-sat losing pool pays the 6,000-sat fee and dust.
    expect(result.totalPoolAfterSats).toBe(1_100_000n);
    expect(result.bucketPoolAfterSats).toBe(500_000n);
    expect(result.protocolFeeSats).toBe(6_000n);
    expect(result.dustReserveSats).toBe(546n);
    expect(result.netDistributableSats).toBe(1_093_454n);
    expect(result.multiplier).toBeCloseTo(2.186908, 5);
    expect(result.estimatedPayoutSats).toBe(218_690n);
    expect(result.calculationTimeMs).toBeLessThan(4);

    const curveStart = performance.now();
    const curve = generateParimutuelMultiplierCurve({
      totalPoolSats: 5_000_000n,
      bucketPoolSats: 2_000_000n,
      minStakeSats: 1_000n,
      maxStakeSats: 1_000_000n,
      steps: 25,
    });
    const curveElapsed = performance.now() - curveStart;
    expect(curve).toHaveLength(25);
    expect(curveElapsed).toBeLessThan(4);
    expect(curve[0].multiplier).toBeGreaterThan(curve[24].multiplier);

    const exactPayout = calculateExactParimutuelPayout(100_000n, 1_000_000n, 500_000n, 100n);
    expect(exactPayout).toBe(199_000n);
  });

  it('preserves winners’ principal for large stakes and caps reserves at what the losing pool supplies', () => {
    const stake = 100_000_000n;
    const large = calculateParimutuelMultiplier({
      totalPoolSats: 1_000_000n, bucketPoolSats: 550_000n, deltaStakeSats: stake, feeBps: 100n,
    });
    expect(large.protocolFeeSats).toBe(4_500n);
    expect(large.multiplier).toBeGreaterThan(1);
    expect(large.netProfitSats).toBeGreaterThan(0n);
    expect(large.estimatedPayoutSats).toBe(stake + large.netProfitSats);

    const tinyLosingPool = calculateParimutuelMultiplier({
      totalPoolSats: 1_001n, bucketPoolSats: 1_000n, deltaStakeSats: stake, feeBps: 100n,
    });
    expect(tinyLosingPool.dustReserveSats).toBe(1n);
    expect(tinyLosingPool.estimatedPayoutSats).toBe(stake);

    const oneSided = calculateParimutuelMultiplier({
      totalPoolSats: 546n, bucketPoolSats: 546n, deltaStakeSats: stake, feeBps: 500n,
    });
    expect(oneSided).toMatchObject({ protocolFeeSats: 0n, dustReserveSats: 0n, multiplier: 1, netProfitSats: 0n });
    expect(calculateExactParimutuelPayout(stake, stake, stake, 500n)).toBe(stake);
  });

  it('computes EWMA volatility (lambda = 0.94) and generates 1-sigma and 2-sigma cone bands', () => {
    const prices = [495.0, 496.2, 495.8, 498.1, 500.0, 499.3, 501.5];
    const sigma = computeEwmaSigma(prices, 0.94);
    expect(sigma).toBeGreaterThan(0);

    const cone = generateEwmaVolatilityCone({
      currentPrice: 500.0,
      muAiDrift: 0.0002,
      sigma,
      remainingSeconds: 300,
      steps: 10,
      nowMs: 1_700_000_000_000,
    });

    expect(cone).toHaveLength(11);
    expect(cone[0].meanPrice).toBe(500.0);
    expect(cone[0].upper1Sigma).toBe(500.0);

    const last = cone[10];
    expect(last.upper2Sigma).toBeGreaterThan(last.upper1Sigma);
    expect(last.upper1Sigma).toBeGreaterThan(last.meanPrice);
    expect(last.meanPrice).toBeGreaterThan(last.lower1Sigma);
    expect(last.lower1Sigma).toBeGreaterThan(last.lower2Sigma);
  });

  it('encodes and decodes 13-byte and 20-byte CashTokens NFT receipt commitments', () => {
    const compactBytes = encodeNftReceiptCommitment({
      marketId: 42,
      bucketId: 1,
      stakeSats: 250_000n,
    });
    expect(compactBytes.byteLength).toBe(13);

    const decodedCompact = decodeNftReceiptCommitment(compactBytes);
    expect(decodedCompact.marketId).toBe(42);
    expect(decodedCompact.bucketId).toBe(1);
    expect(decodedCompact.stakeSats).toBe(250_000n);

    const extendedBytes = encodeNftReceiptCommitment({
      marketId: 108,
      bucketId: 0,
      stakeSats: 1_000_000n,
      entryPriceCents: 50_245,
      flagsHex: '010064',
    });
    expect(extendedBytes.byteLength).toBe(20);

    const decodedExtended = decodeNftReceiptCommitment(extendedBytes);
    expect(decodedExtended.marketId).toBe(108);
    expect(decodedExtended.bucketId).toBe(0);
    expect(decodedExtended.stakeSats).toBe(1_000_000n);
    expect(decodedExtended.entryPriceCents).toBe(50_245);
    expect(decodedExtended.flagsHex).toBe('010064');
  });
});

describe('@cashingularity/shared - Multi-Currency Batch Payroll Parser & CashAddr Checksums', () => {
  it('validates CashAddr checksums and converts to token-aware z... addresses via @bitauth/libauth', () => {
    const valid = validateAndConvertCashAddr(VALID_MAINNET_Q);
    expect(valid.valid).toBe(true);
    expect(valid.network).toBe('mainnet');
    expect(valid.standardAddress).toBe(VALID_MAINNET_Q);
    expect(valid.tokenAwareAddress?.startsWith('bitcoincash:z')).toBe(true);

    // Also test Chipnet token-aware conversion by encoding same payload on bchtest
    const bareValid = validateAndConvertCashAddr(VALID_MAINNET_BARE);
    expect(bareValid.valid).toBe(true);
    expect(bareValid.tokenAwareAddress).toBe(valid.tokenAwareAddress);

    const invalid = validateAndConvertCashAddr(INVALID_CHECKSUM_ADDR);
    expect(invalid.valid).toBe(false);
    expect(invalid.error).toBeDefined();
  });

  it('normalizes US, EU, and CIS locale numbers accurately', () => {
    expect(parseLocaleNumber('1,250.50')).toBe(1250.5);
    expect(parseLocaleNumber('1 250,50')).toBe(1250.5);
    expect(parseLocaleNumber('1.250,50')).toBe(1250.5);
    expect(parseLocaleNumber('125,50')).toBe(125.5);
    expect(parseLocaleNumber('0.0005')).toBe(0.0005);
    expect(parseLocaleNumber('-45.20')).toBe(-45.2);
  });

  it('parses multi-line payroll with mixed currencies, symbols, locales, delimiters, and BIP21 URIs', () => {
    const quoteLock = createDefaultFxQuoteLock();
    const tokenZ = validateAndConvertCashAddr(VALID_MAINNET_Q).tokenAwareAddress!;

    const batchInput = [
      `${VALID_MAINNET_Q} - $1,250.50 - Alice Dev`,
      `${tokenZ}; 1 250,50 EUR; Bob Designer`,
      `${VALID_MAINNET_Q} : 250000 ₸ : Almaty Node`,
      `${VALID_MAINNET_Q} | ₽ 15,000.00 | Moscow Ops`,
      `${VALID_MAINNET_Q}\t£500.25\tLondon QA`,
      `${VALID_MAINNET_Q} - 250 USDT`,
      `${VALID_MAINNET_Q}?amount=0.125&label=BIP21_Payout`,
    ].join('\n');

    const summary = parsePayrollText(batchInput, quoteLock);
    expect(summary.rows).toHaveLength(7);
    expect(summary.validCount).toBe(7);
    expect(summary.invalidCount).toBe(0);
    expect(summary.allValid).toBe(true);

    expect(summary.rows[0].currency).toBe('USD');
    expect(summary.rows[0].parsedAmount).toBe(1250.5);
    expect(summary.rows[0].calculatedSats).toBe(250_100_000n); // $1250.50 at $500/BCH = 2.501 BCH

    expect(summary.rows[1].currency).toBe('EUR');
    expect(summary.rows[1].parsedAmount).toBe(1250.5);

    expect(summary.rows[2].currency).toBe('KZT');
    expect(summary.rows[2].parsedAmount).toBe(250000);

    expect(summary.rows[3].currency).toBe('RUB');
    expect(summary.rows[3].parsedAmount).toBe(15000);

    expect(summary.rows[4].currency).toBe('GBP');
    expect(summary.rows[4].parsedAmount).toBe(500.25);

    expect(summary.rows[5].currency).toBe('USDT');
    expect(summary.rows[5].parsedAmount).toBe(250);

    expect(summary.rows[6].isBip21).toBe(true);
    expect(summary.rows[6].currency).toBe('BCH');
    expect(summary.rows[6].calculatedSats).toBe(12_500_000n);
    expect(summary.rows[6].label).toBe('BIP21_Payout');
  });

  it('never silently skips invalid rows and flags all 5 validation error codes', () => {
    const quoteLock = createDefaultFxQuoteLock();
    const invalidInput = [
      `${INVALID_CHECKSUM_ADDR} - 100 USD`,
      `${VALID_MAINNET_Q} - -50 EUR`,
      `${VALID_MAINNET_Q} - 100`,
      `${VALID_MAINNET_Q} - abc USD`,
      `${VALID_MAINNET_Q} - 0.00000100 BCH`,
    ].join('\n');

    const summary = parsePayrollText(invalidInput, quoteLock);
    expect(summary.rows).toHaveLength(5);
    expect(summary.validCount).toBe(0);
    expect(summary.invalidCount).toBe(5);
    expect(summary.allValid).toBe(false);

    expect(summary.rows[0].errors).toContain('INVALID_CHECKSUM');
    expect(summary.rows[1].errors).toContain('NEGATIVE_OR_ZERO');
    expect(summary.rows[2].errors).toContain('MISSING_CURRENCY');
    expect(summary.rows[3].errors).toContain('NAN_AMOUNT');
    expect(summary.rows[4].errors).toContain('BELOW_DUST_LIMIT');

    // Interactive block edit fixes row 4 from 100 sats to 0.01 BCH (1,000,000n sats)
    const fixedRow = recalculatePayrollRow(
      summary.rows[4],
      { rawAmountText: '0.01', currency: 'BCH' },
      quoteLock
    );
    expect(fixedRow.isValid).toBe(true);
    expect(fixedRow.calculatedSats).toBe(1_000_000n);
  });

  it('rejects oversized payroll payloads exceeding row or byte caps', () => {
    const quoteLock = createDefaultFxQuoteLock();
    const tooManyRows = Array.from({ length: 501 }, () => `${VALID_MAINNET_Q} - 1 USD`).join('\n');
    expect(() => parsePayrollText(tooManyRows, quoteLock)).toThrow(/500 recipient limit/);
    const oversizedText = 'a'.repeat(262_145);
    expect(() => parsePayrollText(oversizedText, quoteLock)).toThrow(/256 KiB/);
  });
});
