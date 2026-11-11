import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { CaseState, Rfq } from '../shared/types';
import type { RfqLine, UploadImportResult, UploadRecord } from '../shared/rfq-upload';
import './UploadRfq.css';

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const fieldLabels: Record<keyof Rfq, string> = {
  description: 'Description', standard: 'Specification', size: 'Dimensions', grade: 'Material / grade', finish: 'Finish',
  quantity: 'Quantity', currency: 'Currency', incoterm: 'Shipping term', destination: 'Destination',
  targetUnitPrice: 'Target / unit', maxUnitPrice: 'Maximum / unit', requiredBy: 'Required delivery',
};
const reviewFields = Object.keys(fieldLabels).filter(key => key !== 'description') as (keyof Rfq)[];
const stamp = (date: string) => new Date(date).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const display = (value: unknown) => value == null || value === '' ? 'Not provided' : typeof value === 'number' ? value.toLocaleString(undefined, { maximumFractionDigits: 6 }) : String(value);
async function responseJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(typeof body.error === 'string' ? body.error : body.error?.message || body.message || `Request failed (${response.status})`), { status: response.status });
  return body as T;
}
function UploadIcon() { return <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 16V3m-4 4 4-4 4 4M4 15v6h16v-6"/></svg>; }

export function UploadRfq({ keenable, onImported }: { keenable: boolean; onImported: (cases: CaseState[], started: boolean, errors: string[]) => void }) {
  const [uploadId, setUploadId] = useState<string | null>(() => localStorage.getItem('sourcecontrol.upload'));
  const [record, setRecord] = useState<UploadRecord | null>(null);
  const [pollVersion, setPollVersion] = useState(0);
  const [history, setHistory] = useState<UploadRecord[]>([]);
  const [selectedLines, setSelectedLines] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [importing, setImporting] = useState<'start' | 'save' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [historyError, setHistoryError] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [pendingFilename, setPendingFilename] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const autoStarted = useRef(new Set<string>());
  const initializedLines = useRef<string | null>(null);
  const requestId = useRef(uploadId);
  requestId.current = uploadId;

  const refreshHistory = useCallback(async () => {
    try { const result = await responseJson<{ uploads: UploadRecord[] }>(await fetch('/api/rfq-uploads')); setHistory(result.uploads); setHistoryError(false); }
    catch { setHistoryError(true); }
  }, []);
  useEffect(() => { void refreshHistory(); }, [refreshHistory]);
  useEffect(() => {
    if (!uploadId) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const poll = async () => {
      let again = true;
      try {
        const next = await responseJson<UploadRecord>(await fetch(`/api/rfq-uploads/${encodeURIComponent(uploadId)}`, { signal: controller.signal }));
        if (disposed || requestId.current !== uploadId) return;
        setRecord(next); setPollError(null); setPendingFilename(null);
        if (next.status === 'ready' && initializedLines.current !== next.id) {
          initializedLines.current = next.id;
          setSelectedLines(next.result?.lines.map(line => line.lineId) || []);
        }
        if (next.status === 'ready' && localStorage.getItem('sourcecontrol.autosource') === next.id && !autoStarted.current.has(next.id)) {
          autoStarted.current.add(next.id);
          try {
            const imported = await responseJson<UploadImportResult>(await fetch(`/api/rfq-uploads/${encodeURIComponent(next.id)}/import`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({lineIds:next.result!.lines.map(line=>line.lineId),start:true})}));
            localStorage.removeItem('sourcecontrol.autosource');
            onImported(imported.cases,true,imported.errors);
          } catch (error) { autoStarted.current.delete(next.id); setError(`Your RFQ is saved. ${(error as Error).message}`); }
        }
        again = next.status === 'extracting';
        if (!again) void refreshHistory();
      } catch (e) {
        if (disposed) return;
        setPollError((e as Error).message);
        if ((e as Error & { status?: number }).status === 404) {
          again = false; localStorage.removeItem('sourcecontrol.upload'); requestId.current = null; setUploadId(null); setRecord(null);
        }
      } finally { if (!disposed && again) timer = setTimeout(poll, 2000); }
    };
    void poll();
    return () => { disposed = true; controller.abort(); if (timer) clearTimeout(timer); };
  }, [uploadId, pollVersion, refreshHistory]);

  const chooseUpload = (value: UploadRecord) => {
    if (submitting || importing) return;
    requestId.current = value.id; setUploadId(value.id); setPollVersion(value => value + 1); setRecord(value); setError(null); setPollError(null); setPendingFilename(null);
    initializedLines.current = value.status === 'ready' ? value.id : null;
    setSelectedLines(value.result?.lines.map(line => line.lineId) || []);
    localStorage.setItem('sourcecontrol.upload', value.id);
  };
  const upload = async (file: File | undefined) => {
    if (!file || submitting || importing) return;
    setError(null);
    const extension = file.name.toLowerCase().split('.').at(-1);
    const mimeType = extension === 'pdf' ? 'application/pdf' : extension === 'txt' ? 'text/plain' : null;
    if (!mimeType) { setError('Choose a searchable PDF or a plain-text .txt file.'); return; }
    if (!file.size) { setError('This file is empty. Choose an RFQ with readable text.'); return; }
    if (file.size > MAX_FILE_BYTES) { setError('The upload limit is 10 MB. Choose a smaller RFQ document.'); return; }
    setSubmitting(true); setPendingFilename(file.name);
    try {
      const result = await responseJson<{ id: string; status: 'extracting' }>(await fetch('/api/rfq-uploads', { method: 'POST', headers: { 'Content-Type': mimeType, 'X-File-Name': encodeURIComponent(file.name) }, body: file }));
      requestId.current = result.id; setUploadId(result.id); setPollVersion(value => value + 1); setRecord(null); setPollError(null); initializedLines.current = null; setSelectedLines([]);
      localStorage.setItem('sourcecontrol.upload', result.id); localStorage.setItem('sourcecontrol.autosource', result.id); void refreshHistory();
    } catch (e) { setError((e as Error).message); setPendingFilename(null); }
    finally { setSubmitting(false); if (fileInput.current) fileInput.current.value = ''; }
  };
  const importSelected = async (start: boolean) => {
    if (!record || !selectedLines.length || importing) return;
    setImporting(start ? 'start' : 'save'); setError(null);
    try {
      const result = await responseJson<UploadImportResult>(await fetch(`/api/rfq-uploads/${encodeURIComponent(record.id)}/import`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lineIds: selectedLines, start }) }));
      if (!result.cases.length) { setError(result.errors.join(' ') || 'No sourcing cases were created.'); return; }
      onImported(result.cases, start, result.errors);
    } catch (e) { setError((e as Error).message); }
    finally { setImporting(null); }
  };
  const lines = record?.result?.lines || [];
  const allSelected = lines.length > 0 && lines.every(line => selectedLines.includes(line.lineId));
  const busy = submitting || importing !== null;
  const selectLine = (lineId: string, selected: boolean) => setSelectedLines(old => selected ? [...new Set([...old, lineId])] : old.filter(id => id !== lineId));

  return <section className="upload-rfq" aria-label="Upload and extract an RFQ">
    <div className={`upload-dropzone ${dragging ? 'dragging' : ''}`} onDragOver={event => { event.preventDefault(); if (!busy) setDragging(true); }} onDragLeave={event => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDragging(false); }} onDrop={event => { event.preventDefault(); setDragging(false); if (event.dataTransfer.files.length > 1) setError('Upload one RFQ document at a time. Every line item inside it will be extracted.'); else void upload(event.dataTransfer.files[0]); }}>
      <div className="upload-drop-copy"><UploadIcon/><div><h2>Upload it. We’ll source it.</h2><p>Upload a searchable PDF or text file. Agents extract the requirements and automatically start supplier research.</p><small>PDF or TXT · up to 10 MB · scanned PDFs require OCR</small></div></div>
      <input ref={fileInput} type="file" accept=".pdf,.txt,application/pdf,text/plain" className="sr-only" aria-label="Choose RFQ document" onChange={event => void upload(event.target.files?.[0])} disabled={busy}/>
      <button className="button button-primary" onClick={() => fileInput.current?.click()} disabled={busy}>{submitting ? <><span className="spinner"/>Uploading…</> : 'Upload & source'}</button>
    </div>
    {error && <div className="rfq-form-error upload-error" role="alert">{error}</div>}
    <div className="upload-workspace">
      <div className="upload-main">
        {uploadId && (!record || record.status === 'extracting') && <section className="upload-extracting" role="status"><span className="spinner"/><div><span className="eyebrow">{record ? 'EXTRACTING LINE ITEMS' : 'LOADING UPLOAD'}</span><h2>{record?.filename || pendingFilename || 'Restoring your RFQ'}</h2><p>{record ? 'The source is saved. A Codex worker is reading its pages and checking extracted values against the document.' : 'Reading the upload’s saved processing state.'}</p><small>You can leave this view and return. Processing continues while the backend runs.</small></div></section>}
        {pollError && <div className="rfq-form-error upload-error" role="alert">{pollError}{record?.status === 'extracting' && <p>Checking again while the backend reconnects.</p>}</div>}
        {record?.status === 'error' && <section className="upload-failure"><span className="eyebrow">EXTRACTION NEEDS ATTENTION</span><h2>{record.filename}</h2><p>{record.error || 'This document could not be extracted. Try a searchable PDF or plain-text file.'}</p><a href={`/api/rfq-uploads/${encodeURIComponent(record.id)}/document`} target="_blank" rel="noreferrer">Open original document ↗</a></section>}
        {record?.status === 'ready' && record.result && <>
          <section className="upload-document-heading"><div><span className="eyebrow">EXTRACTED RFQ · {lines.length} {lines.length === 1 ? 'LINE ITEM' : 'LINE ITEMS'}</span><h2>{(record.result.title || record.filename).replace(/FICTIONAL TEST RFQ[^—]*—?\s*no purchase commitment/i, 'Fastener RFQ')}</h2><p>{[record.result.reference, record.result.buyer].filter(Boolean).join(' · ') || 'No reference or buyer provided'}</p><small>{record.filename}{record.pages ? ` · ${record.pages} ${record.pages === 1 ? 'page' : 'pages'}` : ''} · uploaded {stamp(record.createdAt)}</small></div><a className="button button-secondary" href={`/api/rfq-uploads/${encodeURIComponent(record.id)}/document`} target="_blank" rel="noreferrer">Open source ↗</a></section>
          {record.result.quoteDueDate && <p className="upload-bid-date">Quote response deadline: <strong>{record.result.quoteDueDate}</strong>. This is separate from the required delivery date.</p>}
          {(record.result.requirements.length > 0 || record.result.warnings.length > 0) && <details className="upload-requirements"><summary>Document requirements & review notes <span>{record.result.requirements.length + record.result.warnings.length}</span></summary><ul>{record.result.requirements.map((text, index) => <li key={`requirement-${index}`}>{text}</li>)}{record.result.warnings.map((text, index) => <li key={`warning-${index}`}>{text}</li>)}</ul></details>}
          {lines.length > 0 ? <>
            <div className="upload-selection"><label><input type="checkbox" checked={allSelected} disabled={busy} onChange={event => setSelectedLines(event.target.checked ? lines.map(line => line.lineId) : [])}/>Select all line items</label><span>{selectedLines.length} of {lines.length} selected</span></div>
            <div className="upload-lines">{lines.map((line, index) => <LineReview key={line.lineId} line={line} selected={selectedLines.includes(line.lineId)} disabled={busy} onSelect={selected => selectLine(line.lineId, selected)} initiallyOpen={index === 0}/>)}</div>
            <div className="upload-import"><div><strong>One sourcing case for each selected line</strong><p>Unknown values stay unresolved. Research can begin with the available requirements; missing terms remain open for clarification.</p>{!keenable && <p className="upload-search-blocker">Connect Keenable to start research. You can save the selected cases now.</p>}</div><div className="upload-import-actions"><button className="button button-secondary" disabled={busy || !selectedLines.length} onClick={() => void importSelected(false)}>{importing === 'save' ? 'Saving cases…' : 'Save selected cases'}</button><button className="button button-primary" disabled={busy || !selectedLines.length} onClick={() => void importSelected(true)}>{importing === 'start' ? 'Creating sourcing cases…' : 'Start sourcing selected items'}</button></div></div>
          </> : <div className="upload-no-lines"><h3>No product lines found</h3><p>Open the source and check that it contains readable requirements. Upload a clearer copy or enter the RFQ manually.</p></div>}
          <details className="upload-fingerprint"><summary>Source fingerprint</summary><code>SHA-256 {record.sha256}</code><p>Identifies this saved document. Extracted values and source excerpts still require review.</p></details>
        </>}
        {!uploadId && <div className="upload-empty"><span className="eyebrow">FROM DOCUMENT TO SOURCING</span><ol><li><strong>Upload once</strong><p>Keep every product line in the original document.</p></li><li><strong>Review the extraction</strong><p>See source excerpts and questions for missing details.</p></li><li><strong>Source selected items</strong><p>Start a separate case for each line without retyping it.</p></li></ol></div>}
      </div>
      <aside className="upload-history" aria-label="Recent RFQ uploads"><div><h3>Recent uploads</h3><button className="text-button" disabled={busy} onClick={() => void refreshHistory()}>Refresh</button></div>{historyError && <p className="upload-history-note">Recent uploads are unavailable. Try refreshing.</p>}{history.length ? history.slice(0, 12).map(item => <button className={`upload-history-item ${item.id === uploadId ? 'selected' : ''}`} key={item.id} disabled={busy} onClick={() => chooseUpload(item)}><strong>{item.filename}</strong><span>{item.status === 'ready' ? `${item.result?.lines.length || 0} ${(item.result?.lines.length || 0) === 1 ? 'line item' : 'line items'}` : item.status === 'extracting' ? 'Extracting' : 'Needs attention'}</span><time dateTime={item.createdAt}>{stamp(item.createdAt)}</time></button>) : !historyError && <p className="upload-history-note">Uploaded RFQs will appear here. Your source and extraction are kept together.</p>}</aside>
    </div>
  </section>;
}

function LineReview({ line, selected, disabled, onSelect, initiallyOpen }: { line: RfqLine; selected: boolean; disabled: boolean; onSelect: (selected: boolean) => void; initiallyOpen: boolean }) {
  const unknown = reviewFields.filter(field => line.rfq[field] == null || line.rfq[field] === '');
  return <article className={`upload-line ${selected ? 'selected' : ''}`}>
    <div className="upload-line-heading"><label><input type="checkbox" checked={selected} disabled={disabled} onChange={event => onSelect(event.target.checked)}/><span><small>LINE {line.lineId}</small><strong>{line.rfq.description}</strong></span></label><div><span>{line.rfq.quantity != null ? `${display(line.rfq.quantity)} ${line.unit || 'units not provided'}` : `Quantity not provided${line.unit ? ` · unit: ${line.unit}` : ''}`}</span><small>{unknown.length ? `${unknown.length} unresolved ${unknown.length === 1 ? 'field' : 'fields'}` : 'All fields extracted'}</small></div></div>
    <details className="upload-line-review" open={initiallyOpen}><summary>Requirements & source evidence <span>{line.evidence.length} excerpts</span></summary><dl>{reviewFields.map(field => <div key={field} className={line.rfq[field] == null ? 'unknown' : ''}><dt>{fieldLabels[field]}</dt><dd>{display(line.rfq[field])}</dd></div>)}</dl>{line.uncertainties.length > 0 && <div className="upload-line-questions"><h4>Needs confirmation</h4><ul>{line.uncertainties.map((text, index) => <li key={index}>{text}</li>)}</ul></div>}<div className="upload-evidence"><h4>Grounding in the source</h4>{line.evidence.length ? line.evidence.map((evidence, index) => <blockquote key={`${evidence.field}-${index}`}><div><strong>{fieldLabels[evidence.field] || evidence.field}</strong><span>Page {evidence.page}</span></div><p>“{evidence.quote}”</p></blockquote>) : <p>No supporting excerpts are available for this line. Review the original document before relying on its terms.</p>}</div></details>
  </article>;
}
