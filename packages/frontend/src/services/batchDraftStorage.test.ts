import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultFxQuoteLock, editPayrollDraft, parsePayrollDraft, serializePayrollDraft } from '@cashingularity/shared';
import { readBatchDraft, readSavedBatches, saveBatchDraft, saveNamedBatch } from './batchDraftStorage.js';

const address = 'bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a';
beforeEach(() => {
  for (const name of ['localStorage', 'sessionStorage']) {
    const values = new Map<string, string>();
    vi.stubGlobal(name, { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) });
  }
});
afterEach(() => vi.unstubAllGlobals());
describe('synchronized batch drafts', () => {
  it('starts with four blank rows and preserves row edits across closing or reloading', () => {
    const initial = readBatchDraft();
    expect(initial.rows).toHaveLength(4);
    expect(initial.rawText).toBe('');
    const rows = editPayrollDraft(initial.rows, 0, { recipientAddress: address, rawAmountText: '125', currency: 'PUSD' });
    const rawText = serializePayrollDraft(rows);
    saveBatchDraft({ rows, rawText });
    expect(readBatchDraft()).toEqual({ rows, rawText });
    const fromPaste = parsePayrollDraft(rawText, createDefaultFxQuoteLock());
    expect(fromPaste).toHaveLength(4);
    expect(fromPaste[0]).toMatchObject({ recipientAddress: address, rawAmountText: '125', currency: 'PUSD' });
    expect(fromPaste[1]).toMatchObject({ recipientAddress: '', rawAmountText: '', currency: 'USD' });
  });
  it('loads raw-paste changes into rows and saves named lists without overwriting other lists', () => {
    const text = `${address} | 50 pusd\n${address} | 100 EUR`;
    const rows = parsePayrollDraft(text);
    const edited = editPayrollDraft(rows, 1, { rawAmountText: '250', currency: 'KZT' });
    const rawText = serializePayrollDraft(edited);
    expect(rawText).toContain('250 KZT');
    expect(parsePayrollDraft(rawText)[1].currency).toBe('KZT');
    saveNamedBatch('Team', { rows: edited, rawText });
    saveNamedBatch('Another list', { rows, rawText: text });
    expect(readSavedBatches()).toHaveLength(2);
    expect(readSavedBatches().find(row => row.name === 'Team')?.draft.rows[1].rawAmountText).toBe('250');
  });
});
