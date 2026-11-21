import { describe, expect, it } from 'vitest';
import { parseDelimited, spreadsheetRowsToDraft } from './spreadsheetImport.js';
import { editPayrollDraft, normalizePayrollCurrency, parsePayrollDraft, serializePayrollDraft } from '@cashingularity/shared';
describe('spreadsheet and editable payroll rows', () => {
  it('imports quoted CSV/TSV and recognizes typed currency without treating unknown text as BCH', () => {
    const rows = spreadsheetRowsToDraft(parseDelimited('Address,Amount,Currency,Label\r\nbitcoincash:recipient,"1,250.50",pusd,"Team, A"'));
    expect(rows[0]).toMatchObject({ rawAmountText: '1,250.50', currency: 'PUSD', currencyInput: 'pusd', label: 'Team, A' });
    expect(spreadsheetRowsToDraft(parseDelimited('address\tamount\tcurrency\naddr\t25\tEUR', '\t'))[0].currency).toBe('EUR');
    expect(normalizePayrollCurrency('  usd ')).toBe('USD'); expect(normalizePayrollCurrency('Tron')).toBeNull();
    expect(parseDelimited('addr;25;USD;"A,B,C,D,E"')[0]).toEqual(['addr','25','USD','A,B,C,D,E']);
    expect(() => parseDelimited('"unclosed')).toThrow(/Unclosed/);
  });
  it('keeps deletion/clear-all at zero rows and synchronizes unknown currency text', () => {
    expect(parsePayrollDraft('')).toEqual([]);
    const initial = spreadsheetRowsToDraft([['address','amount','currency'],['recipient','25','USD']]);
    const changed = editPayrollDraft(initial, 0, { currencyInput: 'XYZ', currency: null });
    expect(serializePayrollDraft(changed)).toContain('XYZ');
    expect(parsePayrollDraft(serializePayrollDraft(changed))[0].currency).toBeNull();
    expect(serializePayrollDraft(changed.filter(() => false))).toBe('');
  });
});
