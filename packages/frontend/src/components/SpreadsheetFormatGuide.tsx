import React, { useEffect, useId, useRef, useState } from 'react';
export const SpreadsheetFormatGuide: React.FC<{ active: boolean }> = ({ active }) => {
  const [open, setOpen] = useState(false), id = useId();
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (!active) setOpen(false); }, [active]);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', close); return () => document.removeEventListener('pointerdown', close);
  }, [open]);
  return <div className="spreadsheet-format-guide" ref={root} onKeyDown={event => { if (open && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus(); } }}>
    <button ref={trigger} className="format-guide-trigger" type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}>? Format Guide</button>
    {open && <section id={id} className="format-guide-popover" role="region" aria-label="Spreadsheet file format guide">
      <h3>Prepare your recipient spreadsheet</h3>
      <p>Use the first worksheet in .xlsx, or a .csv / .tsv file. Start with these column headers:</p>
      <dl><dt>Address · required</dt><dd>A complete, valid bitcoincash:q… or token-aware bitcoincash:z… CashAddr. Use bchtest: addresses for Chipnet.</dd><dt>Amount · required</dt><dd>A positive number. Enter values, without spreadsheet formulas.</dd><dt>Currency · required</dt><dd>BCH, USD, PUSD, USDT, EUR, GBP, KZT or RUB.</dd><dt>Label · optional</dt><dd>A recipient name or payment note.</dd></dl>
      <div className="format-guide-example"><table><caption>Example: one recipient per row</caption><thead><tr><th>Address</th><th>Amount</th><th>Currency</th><th>Label</th></tr></thead><tbody>
        <tr><td><code>bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a</code></td><td>0.01</td><td>BCH</td><td>Contractor A</td></tr>
        <tr><td><code>bitcoincash:zpm2qsznhks23z7629mms6s4cwef74vcwva509496m</code></td><td>250</td><td>USD</td><td>Invoice 42</td></tr>
      </tbody></table></div>
      <p>All transfers settle in BCH on the Bitcoin Cash network. Currency is the input unit; non-BCH amounts use a locked conversion quote.</p>
      <button className="btn" type="button" onClick={() => { setOpen(false); trigger.current?.focus(); }}>Close guide</button>
    </section>}
  </div>;
};
