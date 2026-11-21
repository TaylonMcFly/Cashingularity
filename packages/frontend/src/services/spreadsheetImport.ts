import { unzipSync } from 'fflate';
import { normalizePayrollCurrency, type PayrollDraftRow } from '@cashingularity/shared';
const MAX_SIZE = 5 * 1024 * 1024;
export function parseDelimited(text: string, delimiter?: string): string[][] {
  const source = text.replace(/^\uFEFF/, '');
  const counts = new Map([['\t', 0], [';', 0], [',', 0]]); let inQuotes = false;
  for (let i = 0; i < source.length; i++) { const char = source[i]; if (char === '"') { if (inQuotes && source[i + 1] === '"') i++; else inQuotes = !inQuotes; } else if (!inQuotes) { if (char === '\n' || char === '\r') break; if (counts.has(char)) counts.set(char, counts.get(char)! + 1); } }
  const sep = delimiter ?? [...counts].sort((a, b) => b[1] - a[1])[0][0];
  const rows: string[][] = []; let row: string[] = [], value = '', quoted = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (char === '"') { if (quoted && source[i + 1] === '"') { value += '"'; i++; } else quoted = !quoted; }
    else if (char === sep && !quoted) { row.push(value); value = ''; }
    else if ((char === '\n' || char === '\r') && !quoted) { if (char === '\r' && source[i + 1] === '\n') i++; row.push(value); if (row.some(cell => cell.trim())) rows.push(row); row = []; value = ''; }
    else value += char;
    if (rows.length > 101 || value.length > 10000) throw new Error('Import supports at most 100 recipients and bounded cell sizes.');
  }
  if (quoted) throw new Error('Unclosed quoted field in spreadsheet.');
  row.push(value); if (row.some(cell => cell.trim())) rows.push(row);
  return rows;
}
export function spreadsheetRowsToDraft(grid: string[][]): PayrollDraftRow[] {
  if (!grid.length) throw new Error('The spreadsheet is empty.');
  const normalized = grid[0].map(cell => cell.trim().toLowerCase().replace(/[\s_-]/g, ''));
  const aliases = { recipientAddress: ['address', 'recipient', 'recipientaddress', 'cashaddr', 'wallet'], rawAmountText: ['amount', 'value'], currency: ['currency', 'unit', 'asset'], label: ['label', 'name', 'note', 'description'] };
  const indices = Object.fromEntries(Object.entries(aliases).map(([key, names]) => [key, normalized.findIndex(cell => names.includes(cell))])) as Record<keyof typeof aliases, number>;
  const header = indices.recipientAddress >= 0 && indices.rawAmountText >= 0;
  const data = header ? grid.slice(1) : grid;
  if (data.length > 100) throw new Error('A transfer list can contain at most 100 recipients.');
  return data.filter(row => row.some(cell => cell.trim())).map(row => {
    const get = (name: keyof typeof aliases, fallback: number) => (row[header ? indices[name] : fallback] ?? '').trim();
    const currencyInput = get('currency', 2);
    return { recipientAddress: get('recipientAddress', 0), rawAmountText: get('rawAmountText', 1), currency: normalizePayrollCurrency(currencyInput), currencyInput, label: get('label', 3) || undefined };
  });
}
function xml(bytes: Uint8Array | undefined): Document {
  if (!bytes) throw new Error('Required XLSX workbook data is missing.');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error('XML entities are not supported.');
  const document = new DOMParser().parseFromString(text, 'application/xml');
  if (document.getElementsByTagName('parsererror').length) throw new Error('Invalid XLSX XML.');
  return document;
}
export function parseXlsx(bytes: Uint8Array): string[][] {
  if (bytes.length > MAX_SIZE) throw new Error('Spreadsheet must be smaller than 5 MB.');
  let expanded = 0;
  const files = unzipSync(bytes, { filter: file => {
    const selected = /^(xl\/workbook\.xml|xl\/_rels\/workbook\.xml.rels|xl\/sharedStrings\.xml|xl\/worksheets\/[^/]+\.xml)$/.test(file.name);
    if (selected) { expanded += file.originalSize; if (file.originalSize > 8 * 1024 * 1024 || expanded > 16 * 1024 * 1024) throw new Error('Expanded spreadsheet is too large.'); }
    return selected;
  } });
  const workbook = xml(files['xl/workbook.xml']), rels = xml(files['xl/_rels/workbook.xml.rels']);
  const sheet = workbook.getElementsByTagNameNS('*', 'sheet')[0];
  const id = sheet?.getAttribute('r:id') ?? sheet?.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id');
  const relationship = Array.from(rels.getElementsByTagNameNS('*', 'Relationship')).find(node => node.getAttribute('Id') === id);
  const target = relationship?.getAttribute('Target') ?? '';
  if (!target || target.includes('..') || relationship?.getAttribute('TargetMode') === 'External') throw new Error('Unsupported worksheet reference.');
  const sheetPath = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
  const shared = files['xl/sharedStrings.xml'] ? Array.from(xml(files['xl/sharedStrings.xml']).getElementsByTagNameNS('*', 'si')).map(node => Array.from(node.getElementsByTagNameNS('*', 't')).map(text => text.textContent ?? '').join('')) : [];
  const grid = Array.from(xml(files[sheetPath]).getElementsByTagNameNS('*', 'row')).map(row => {
    const result: string[] = [];
    for (const cell of Array.from(row.getElementsByTagNameNS('*', 'c'))) {
      if (cell.getElementsByTagNameNS('*', 'f').length) throw new Error('Formula cells are unsupported. Export values before importing.');
      const letters = cell.getAttribute('r')?.match(/^[A-Z]+/)?.[0] ?? 'A';
      const column = [...letters].reduce((sum, char) => sum * 26 + char.charCodeAt(0) - 64, 0) - 1;
      if (column > 15) throw new Error('Use a compact spreadsheet with Address, Amount, Currency and Label columns.');
      const raw = cell.getElementsByTagNameNS('*', 'v')[0]?.textContent ?? '';
      const type = cell.getAttribute('t');
      result[column] = type === 's' ? shared[Number(raw)] ?? '' : type === 'inlineStr' ? Array.from(cell.getElementsByTagNameNS('*', 't')).map(node => node.textContent ?? '').join('') : raw;
    }
    return Array.from({ length: result.length }, (_, index) => result[index] ?? '');
  }).filter(row => row.some(value => value.trim()));
  if (grid.length > 101) throw new Error('A transfer list can contain at most 100 recipients.');
  return grid;
}
export async function importSpreadsheet(file: File): Promise<PayrollDraftRow[]> {
  if (file.size > MAX_SIZE) throw new Error('Spreadsheet must be smaller than 5 MB.');
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (/\.xlsx$/i.test(file.name)) return spreadsheetRowsToDraft(parseXlsx(bytes));
  if (!/\.(csv|tsv)$/i.test(file.name)) throw new Error('Choose an .xlsx, .csv or .tsv file.');
  return spreadsheetRowsToDraft(parseDelimited(new TextDecoder('utf-8', { fatal: true }).decode(bytes), /\.tsv$/i.test(file.name) ? '\t' : undefined));
}
