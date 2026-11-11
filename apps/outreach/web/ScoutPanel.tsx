import React, { useEffect, useState } from 'react';
import type { ScoutItem, ScoutOverview, ScoutReview } from '../shared/scout';
import './scout.css';

export function ScoutPanel({ onReview }: { onReview: (review: ScoutReview) => void }) {
  const [data, setData] = useState<ScoutOverview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(false);
  const load = async () => {
    setBusy(true); setError(null);
    try {
      const response = await fetch('/api/scout');
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Unable to read RFQ Scout.');
      setData(result);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  useEffect(() => { void load(); }, []);
  const items = (data?.items || []).filter(item => `${item.title} ${item.reference} ${item.buyer} ${item.summary}`.toLowerCase().includes(filter.toLowerCase()));
  const item = data?.items.find(item => item.id === selected) || null;
  const review = async (entry: ScoutItem) => {
    setLoading(true); setError(null);
    try {
      // Read the current revision again before binding it to the review form.
      const response = await fetch(`/api/scout/items/${encodeURIComponent(entry.id)}`);
      const latest = await response.json() as ScoutItem & {error?: string};
      if (!response.ok) throw new Error(latest.error || 'Unable to load this RFQ.');
      onReview({ rfq: latest.rfq, source: { id: latest.id, sha256: latest.source.sha256 }, title: latest.title, warnings: latest.warnings });
    } catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  };
  return <section className="scout-panel" aria-label="RFQ opportunities">
    <div className="scout-connection"><div><span className={`small-dot ${data?.disk.connected ? 'green' : ''}`}/><strong>rfq-scout</strong><span>{data?.disk.connected ? 'Connected · read-only' : busy ? 'Checking connection…' : 'Connection unavailable'}</span><span className="scout-bridge-arrow" aria-hidden="true">→</span><strong>out-reach</strong><span>Reviewed imports</span></div><button className="button button-secondary button-small" disabled={busy} onClick={() => void load()}>{busy ? 'Refreshing…' : 'Refresh Scout'}</button></div>
    <p className="scout-bridge-note">Choose a request and start sourcing. Agents use the available requirements; missing details stay open.</p>
    {(error || data?.error) && <div role="alert" className="rfq-form-error">{error || data?.error}</div>}
    <div className="scout-toolbar"><label htmlFor="scout-filter">Find an RFQ<input id="scout-filter" type="search" value={filter} onChange={e => setFilter(e.target.value)} placeholder="Search part, reference or buyer"/></label><span>{items.length} {items.length === 1 ? 'request' : 'requests'}{data?.limited ? ' · latest bounded snapshot' : ''}{data && <small>Checked {new Date(data.checkedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</small>}</span></div>
    <div className={`scout-content ${item ? 'has-selection' : ''}`}>
      <div className="scout-requests">{busy && !data ? <p className="scout-empty" role="status">Reading published RFQs from Archil…</p> : items.length ? items.map(entry => <button type="button" className={`scout-request ${item?.id === entry.id ? 'selected' : ''}`} key={entry.id} onClick={() => setSelected(entry.id)} aria-pressed={item?.id === entry.id}>
        <div className="scout-request-meta"><span>{entry.reference || 'RFQ'}</span><span>{entry.source.kind === 'document' ? 'Example RFQ' : 'Scout disk'}</span></div><h2>{entry.title}</h2><p>{entry.summary}</p><div className="scout-request-bottom"><span>{entry.buyer || 'Buyer not provided'}</span><span>{entry.dueDate ? `Quote due ${entry.dueDate}` : 'Deadline not provided'}</span></div>
      </button>) : <p className="scout-empty">{filter ? 'No RFQs match this search.' : 'No published RFQs found. Refresh after Scout publishes its next results, or create a request manually.'}</p>}</div>
      {item && <aside className="scout-detail" aria-label="Selected RFQ details"><div className="scout-detail-heading"><span className="eyebrow">REVIEW BEFORE SOURCING</span><button className="icon-button" onClick={() => setSelected(null)} aria-label="Close RFQ details">✕</button></div><h2>{item.title}</h2><p>{item.reference}</p><dl>{Object.entries(item.rfq).filter(([,value]) => value !== null && value !== '').map(([key,value]) => <div key={key}><dt>{({description:'Requirement',standard:'Specification',size:'Dimensions',grade:'Material / grade',finish:'Finish',quantity:'Quantity',currency:'Currency',incoterm:'Shipping term',destination:'Destination',requiredBy:'Delivery date',targetUnitPrice:'Target / unit',maxUnitPrice:'Maximum / unit'} as Record<string,string>)[key] || key}</dt><dd>{String(value)}</dd></div>)}</dl><div className="scout-requirements"><h3>Needs your review</h3><ul>{item.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul></div><button className="button button-primary" disabled={loading} onClick={() => void review(item)}>{loading ? 'Loading source…' : 'Source this RFQ'}</button><details className="scout-source"><summary>Source record & fingerprint</summary><p>{item.source.diskName || 'Supplied document'} · {item.source.path}</p><p>{item.source.revision || 'No source revision provided'}</p><code>{item.source.sha256}</code><small>Identifies the captured source; it does not validate the buyer’s claims.</small>{item.sourceUrl && /^(https?:\/\/|\/api\/scout\/)/i.test(item.sourceUrl) && <a href={item.sourceUrl} target="_blank" rel="noreferrer">Open source document ↗</a>}</details></aside>}
    </div>
  </section>;
}
