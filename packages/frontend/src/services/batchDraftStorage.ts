import { createPayrollDraft, PAYROLL_CURRENCIES, type PayrollDraftRow } from '@cashingularity/shared';
export interface BatchDraft { rawText: string; rows: PayrollDraftRow[] }
export interface SavedBatch { id: string; name: string; draft: BatchDraft }
const DRAFT_KEY = 'cashingularity.batch.draft.v1';
const LIST_KEY = 'cashingularity.batch.lists.v1';
function validDraft(value: unknown): value is BatchDraft {
  const draft = value as BatchDraft | null;
  return !!draft && typeof draft.rawText === 'string' && draft.rawText.length <= 100000 && Array.isArray(draft.rows) && draft.rows.length <= 100 && draft.rows.every(row => !!row && typeof row.recipientAddress === 'string' && typeof row.rawAmountText === 'string' && (row.currency === null || PAYROLL_CURRENCIES.includes(row.currency)) && (row.currencyInput === undefined || typeof row.currencyInput === 'string') && (row.label === undefined || typeof row.label === 'string') && (row.sourceLine === undefined || typeof row.sourceLine === 'string'));
}
export function readBatchDraft(): BatchDraft {
  try { const data: unknown = JSON.parse(sessionStorage.getItem(DRAFT_KEY) ?? 'null'); if (validDraft(data)) return data; } catch {}
  return { rawText: '', rows: createPayrollDraft() };
}
export function saveBatchDraft(draft: BatchDraft): void {
  if (!validDraft(draft)) throw new Error('A batch can contain at most 100 recipient rows.');
  sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
}
export function readSavedBatches(): SavedBatch[] {
  try {
    const data = JSON.parse(localStorage.getItem(LIST_KEY) ?? '[]');
    return Array.isArray(data) ? data.filter((row): row is SavedBatch => !!row && typeof row.id === 'string' && typeof row.name === 'string' && row.name.length <= 80 && validDraft(row.draft)).slice(0, 20) : [];
  } catch { return []; }
}
export function saveNamedBatch(name: string, draft: BatchDraft): SavedBatch[] {
  if (!name.trim()) throw new Error('Name this transfer list first.');
  if (!validDraft(draft)) throw new Error('Invalid recipient list.');
  const rows = readSavedBatches();
  const item = { id: crypto.randomUUID(), name: name.trim().slice(0, 80), draft };
  const next = [item, ...rows.filter(row => row.name !== item.name)].slice(0, 20);
  localStorage.setItem(LIST_KEY, JSON.stringify(next));
  return next;
}
