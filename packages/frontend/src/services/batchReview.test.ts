import { describe, expect, it } from 'vitest';
import { createDefaultFxQuoteLock, createPayrollDraft, type PayrollDraftRow } from '@cashingularity/shared';
import { batchReviewError, DISCONNECTED_BATCH_MESSAGE, EMPTY_BATCH_MESSAGE, INVALID_BATCH_MESSAGE, parseRecipientRow } from './batchReview.js';
const address='bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a';
const quote=createDefaultFxQuoteLock();
const valid: PayrollDraftRow={recipientAddress:address,rawAmountText:'0.01',currency:'BCH'};
const review=(rows:PayrollDraftRow[],live=true,connected=true)=>batchReviewError(rows,rows.map((row,index)=>parseRecipientRow(row,index,quote)),live,connected);
describe('batch review validation before opening a signing drawer',()=>{
  it('reports empty, invalid and disconnected batches distinctly while ignoring untouched placeholder rows',()=>{
    expect(review([])).toBe(EMPTY_BATCH_MESSAGE); expect(review(createPayrollDraft())).toBe(EMPTY_BATCH_MESSAGE);
    expect(review([{...valid,recipientAddress:''}])).toBe(INVALID_BATCH_MESSAGE);
    expect(review([{...valid,rawAmountText:'0'}])).toBe(INVALID_BATCH_MESSAGE);
    expect(review([{...valid,rawAmountText:'not-a-number'}])).toBe(INVALID_BATCH_MESSAGE);
    expect(review([valid],true,false)).toBe(DISCONNECTED_BATCH_MESSAGE);
    expect(review([valid,...createPayrollDraft()],true,true)).toBeUndefined();
    expect(review([valid],false,false)).toBeUndefined();
  });
  it('never converts a recognizable word inside unconfirmed currency text into a payable row',()=>{
    const unconfirmed: PayrollDraftRow={...valid,rawAmountText:'25',currency:null,currencyInput:'USD or BCH'};
    const row=parseRecipientRow(unconfirmed,0,quote);
    expect(row.isValid).toBe(false);expect(row.calculatedSats).toBe(0n);expect(row.errors).toContain('MISSING_CURRENCY');
    expect(review([unconfirmed])).toBe(INVALID_BATCH_MESSAGE);
    expect(parseRecipientRow({...unconfirmed,currency:'PUSD',currencyInput:'pusd'},0,quote).isValid).toBe(true);
  });
});
