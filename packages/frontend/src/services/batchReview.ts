import { normalizePayrollCurrency, parsePayrollLine, serializePayrollDraft, type FxQuoteLock, type PayrollDraftRow, type PayrollRow } from '@cashingularity/shared';
export const EMPTY_BATCH_MESSAGE = 'Add at least one recipient (via + Add Row, spreadsheet upload, or Raw Text) before reviewing.';
export const INVALID_BATCH_MESSAGE = 'Fix the highlighted recipient row errors before reviewing.';
export const DISCONNECTED_BATCH_MESSAGE = 'Connect or select a wallet before reviewing an on-chain batch transfer.';
export function hasRecipientContent(row: PayrollDraftRow): boolean {
  return !!(row.recipientAddress.trim() || row.rawAmountText.trim() || row.currencyInput?.trim() || row.label?.trim());
}
export function parseRecipientRow(row: PayrollDraftRow, index: number, quote: FxQuoteLock): PayrollRow {
  const parsed = parsePayrollLine(serializePayrollDraft([row]), index, quote);
  // A recognizable word inside an unconfirmed free-text currency is not confirmation.
  if (!row.currency || parsed.currency !== row.currency || row.currencyInput !== undefined && normalizePayrollCurrency(row.currencyInput) !== row.currency) {
    return { ...parsed, currency:null, calculatedSats:0n, isValid:false,
      errors:[...new Set([...parsed.errors, 'MISSING_CURRENCY' as const])],
      errorMessages:[...new Set([...parsed.errorMessages, 'Enter and confirm one supported currency code.'])] };
  }
  return parsed;
}
export function batchReviewError(draft: PayrollDraftRow[], parsed: PayrollRow[], live: boolean, connected: boolean): string | undefined {
  const entered = draft.map((row,index) => ({row,index})).filter(({row}) => hasRecipientContent(row));
  if (!entered.length) return EMPTY_BATCH_MESSAGE;
  if (entered.some(({index}) => !parsed[index]?.isValid)) return INVALID_BATCH_MESSAGE;
  if (live && !connected) return DISCONNECTED_BATCH_MESSAGE;
  return undefined;
}
