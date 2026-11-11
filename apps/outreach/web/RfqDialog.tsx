import React, { useEffect, useRef, useState } from 'react';
import type { Rfq } from '../shared/types';

type Draft = { [K in keyof Rfq]: string };
const emptyDraft: Draft = { description: '', standard: '', size: '', grade: '', finish: '', quantity: '', currency: '', incoterm: '', destination: '', targetUnitPrice: '', maxUnitPrice: '', requiredBy: '' };
const demoDraft: Draft = { description: 'Socket head cap screws', standard: 'ISO 4762', size: 'M8x30', grade: '12.9', finish: 'Black oxide', quantity: '50000', currency: 'USD', incoterm: 'CIF', destination: 'Oakland', targetUnitPrice: '0.065', maxUnitPrice: '0.082', requiredBy: '' };

function parseDraft(input: Record<string, unknown>): Rfq {
  if (typeof input.description !== 'string' || !input.description.trim()) throw new Error('Please enter a product description.');
  const output = { description: input.description.trim() } as Rfq;
  for (const key of ['standard', 'size', 'grade', 'finish', 'currency', 'incoterm', 'destination'] as const) {
    const value = input[key];
    if (value == null || value === '') output[key] = null;
    else if (typeof value !== 'string') throw new Error(`Use text for ${key}, or leave it blank.`);
    else output[key] = value.trim() || null;
  }
  if (output.currency) {
    output.currency = output.currency.toUpperCase();
    if (!/^[A-Z]{3}$/.test(output.currency)) throw new Error('Use a three-letter currency code, such as USD or EUR, or leave it blank.');
  }
  for (const key of ['quantity', 'targetUnitPrice', 'maxUnitPrice'] as const) {
    const supplied = input[key];
    if (supplied == null || (typeof supplied === 'string' && !supplied.trim())) { output[key] = null; continue; }
    if (typeof supplied !== 'number' && typeof supplied !== 'string') throw new Error(`Enter a number for ${key}, or leave it blank.`);
    const value = Number(supplied);
    if (!Number.isFinite(value) || value <= 0) throw new Error(`Enter a positive ${key === 'quantity' ? 'quantity' : key === 'targetUnitPrice' ? 'target unit price' : 'maximum unit price'}.`);
    output[key] = value;
  }
  if (output.quantity != null && !Number.isSafeInteger(output.quantity)) throw new Error('Quantity must be a positive whole number.');
  if (output.targetUnitPrice != null && output.maxUnitPrice != null && output.targetUnitPrice > output.maxUnitPrice) throw new Error('The target unit price cannot be higher than the maximum unit price.');
  output.incoterm = output.incoterm?.toUpperCase() || null;
  const requiredBy = input.requiredBy;
  if (requiredBy != null && requiredBy !== '' && (typeof requiredBy !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(requiredBy))) throw new Error('Use a delivery date in YYYY-MM-DD format, or leave it blank.');
  output.requiredBy = typeof requiredBy === 'string' && requiredBy ? requiredBy : null;
  if (output.requiredBy) {
    const date = new Date(`${output.requiredBy}T00:00:00Z`);
    if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== output.requiredBy) throw new Error('Enter a valid calendar date for delivery.');
  }
  return output;
}

export function RfqDialog({ onClose, onSave, busy, keenable, initialRfq, sourceTitle, sourceWarnings = [] }: { onClose: () => void; onSave: (rfq: Rfq, start: boolean) => Promise<void>; busy: boolean; keenable: boolean; initialRfq?: Partial<Rfq>; sourceTitle?: string; sourceWarnings?: string[] }) {
  const [draft, setDraft] = useState<Draft>(() => {
    const initial = { ...emptyDraft, ...(initialRfq ? { currency: '', incoterm: '' } : {}) };
    for (const [key, value] of Object.entries(initialRfq || {})) if (key in initial && value != null) initial[key as keyof Draft] = String(value);
    return initial;
  });
  const [reviewedSource, setReviewedSource] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [json, setJson] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [demoValues, setDemoValues] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const modal = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    if (sourceTitle) modal.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) { event.preventDefault(); onClose(); }
      if (event.key !== 'Tab' || !modal.current) return;
      const controls = [...modal.current.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex="0"], a[href]')].filter(element => element.getClientRects().length > 0);
      const first = controls[0], last = controls.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && (document.activeElement === first || document.activeElement === modal.current)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === modal.current)) { event.preventDefault(); first.focus(); }
    };
    const element = modal.current;
    element?.addEventListener('keydown', onKey);
    return () => { element?.removeEventListener('keydown', onKey); previous?.focus(); };
  }, [busy, sourceTitle]);
  const field = (key: keyof Draft) => ({ value: draft[key], onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => { setDraft(old => ({ ...old, [key]: event.target.value })); setError(null); } });
  const submit = async (start: boolean) => {
    setError(null);
    if (busy) return;
    
    if (start && !keenable) { setError('Connect Keenable before starting supplier research. You can save this RFQ as a draft now.'); return; }
    if (!advanced && !form.current?.reportValidity()) return;
    try {
      let input: Record<string, unknown>;
      if (advanced) {
        try { const parsed = JSON.parse(json); input = parsed?.rfq || parsed; } catch { throw new Error('The RFQ must be valid JSON. Check commas and quotation marks.'); }
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Paste an RFQ JSON object.');
      } else input = Object.values(draft).some(value => value.trim()) ? draft : demoDraft;
      if (!input.description || !String(input.description).trim()) input = {...input,description: ['standard','size','grade','finish'].map(key=>input[key]).filter(Boolean).join(' ') || demoDraft.description};
      await onSave(parseDraft(input), start);
    } catch (e) { setError((e as Error).message); }
  };
  const fillDemo = () => { setDraft(demoDraft); setJson(JSON.stringify(parseDraft(demoDraft), null, 2)); setDemoValues(true); setError(null); };
  return <div className="modal-backdrop" onClick={() => !busy && onClose()}><section ref={modal} tabIndex={-1} className="import-modal rfq-form-modal" role="dialog" aria-modal="true" aria-labelledby="rfq-form-title" onClick={e => e.stopPropagation()}>
    <div className="modal-heading"><div><span className="eyebrow">YOUR BUYING REQUIREMENTS</span><h2 id="rfq-form-title">{sourceTitle ? 'Review imported RFQ' : 'New sourcing request'}</h2></div><button className="icon-button" aria-label="Close RFQ form" onClick={onClose} disabled={busy}>✕</button></div>
    <p>All fields are optional. Submit an empty form to source the fastener example, or describe your own requirement.</p>
    {sourceTitle && <div className="rfq-source-review"><strong>{sourceTitle}</strong><p>Source facts are prefilled. Unknown terms stay blank. Research can begin now; unresolved requirements remain visible for later confirmation.</p>{sourceWarnings.length > 0 && <ul>{sourceWarnings.map(warning => <li key={warning}>{warning}</li>)}</ul>}</div>}
    <div className="rfq-form-tabs"><div role="tablist" aria-label="RFQ entry method"><button type="button" role="tab" aria-selected={!advanced} className={!advanced ? 'selected' : ''} onClick={() => { setAdvanced(false); setError(null); }}>Enter requirements</button><button type="button" role="tab" aria-selected={advanced} className={advanced ? 'selected' : ''} onClick={() => { setAdvanced(true); setError(null); }}>Advanced · import JSON</button></div>{!sourceTitle && <button type="button" className="text-button" onClick={fillDemo}>Use demo values</button>}</div>
    {error && <div className="rfq-form-error" role="alert">{error}</div>}
    {demoValues && <div className="rfq-demo-note">Demo values loaded. Edit any field before sourcing.</div>}
    <form ref={form} onSubmit={e => { e.preventDefault(); void submit(true); }}>
      {advanced ? <div className="rfq-json-entry"><label htmlFor="rfq-json">RFQ JSON</label><textarea id="rfq-json" autoFocus value={json} onChange={e => { setJson(e.target.value); setError(null); }} spellCheck={false} rows={16} placeholder={JSON.stringify(parseDraft(demoDraft), null, 2)}/><p>Accepts the same fields as the form. Use <code>null</code> for unknown values. Only description is required for research.</p></div> : <div className="rfq-fields">
        <label className="field-wide">Product description <textarea autoFocus={!sourceTitle} {...field('description')} maxLength={2000} rows={2} placeholder="What do you need manufactured or supplied?"/><small>Include the material, application, or important manufacturing requirements.</small></label>
        <label>Standard or specification<input {...field('standard')} maxLength={2000} placeholder="e.g. ISO 4762, ASTM A36"/></label>
        <label>Size or dimensions<input {...field('size')} maxLength={2000} placeholder="Include dimensions and units"/></label>
        <label>Material or strength grade<input {...field('grade')} maxLength={2000} placeholder="e.g. 12.9, 304 stainless steel"/></label>
        <label>Finish or surface treatment<input {...field('finish')} maxLength={2000} placeholder="e.g. Black oxide, uncoated"/></label>
        <label>Quantity · pieces<input {...field('quantity')} type="number" min="1" step="1" inputMode="numeric" placeholder="Number of pieces"/></label>
        <label>Currency<input {...field('currency')} maxLength={3} minLength={3} pattern="[a-zA-Z]{3}" placeholder="USD" autoCapitalize="characters"/></label>
        <label>Shipping term<input {...field('incoterm')} maxLength={2000} placeholder="e.g. CIF, FOB, EXW"/><small>Use the commercial term you want suppliers to quote against.</small></label>
        <label>Destination<input {...field('destination')} maxLength={2000} placeholder="Port, city, or delivery location"/></label>
        <label>Target price · per piece <span className="field-optional">optional</span><input {...field('targetUnitPrice')} type="number" min="0.000001" step="any" inputMode="decimal" placeholder="Preferred unit price"/></label>
        <label>Maximum price · per piece <span className="field-optional">optional</span><input {...field('maxUnitPrice')} type="number" min="0.000001" step="any" inputMode="decimal" placeholder="Your upper limit"/></label>
        <label className="field-wide">Required delivery date <span className="field-optional">optional</span><input {...field('requiredBy')} type="date"/><small>Leave blank if unknown. The case will retain this as an unresolved requirement.</small></label>
      </div>}
      {!keenable && <div className="rfq-search-blocker"><strong>Connect search to start sourcing</strong><p>Keenable is not connected yet. In the app workspace, run <code>npm run connect:keenable</code>, complete sign-in, then return here. You can save your RFQ now.</p><small>Keep API keys in the local environment, never in this form or chat.</small></div>}
      <div className="rfq-form-actions"><button type="button" className="button button-secondary" disabled={busy} onClick={() => void submit(false)}>{busy ? 'Saving…' : 'Save draft'}</button><button type="submit" className="button button-primary" disabled={busy}>{busy ? 'Saving…' : 'Save & start sourcing'}</button></div>
    </form>
  </section></div>;
}
