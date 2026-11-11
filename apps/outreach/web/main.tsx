import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { AppEvent, Candidate, CaseDetail, CaseState, Message, Quote, Rfq, RuntimeSnapshot, SupplierStatus } from '../shared/types';
import { RfqDialog } from './RfqDialog';
import { ScoutPanel } from './ScoutPanel';
import type { RfqProvenance, ScoutReview } from '../shared/scout';
import { EmailConnectionPanel, EmailDrafts, OutreachDialog, QuoteSourceEvidence } from './EmailPanels';
import type { EmailStatus } from '../shared/email';
import './styles.css';

type IconName = 'grid' | 'arrow' | 'plus' | 'search' | 'inbox' | 'activity' | 'file' | 'play' | 'chevron' | 'close' | 'external' | 'check' | 'pause' | 'copy' | 'shield' | 'retry' | 'send' | 'code' | 'globe' | 'warning';
function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  const paths: Record<IconName, React.ReactNode> = {
    grid: <><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></>,
    arrow: <><path d="M5 12h14M13 6l6 6-6 6"/></>,
    plus: <path d="M12 5v14M5 12h14"/>, search: <><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></>,
    inbox: <><path d="M4 4h16l2 10v6H2v-6L4 4Z"/><path d="M2 14h6l2 3h4l2-3h6"/></>,
    activity: <path d="M2 12h4l3-8 5 16 3-8h5"/>, file: <><path d="M14 2H5v20h14V7l-5-5Z"/><path d="M14 2v6h5M8 12h8M8 16h6"/></>,
    play: <path d="m8 4 12 8-12 8V4Z"/>, chevron: <path d="m9 5 7 7-7 7"/>, close: <path d="m6 6 12 12M6 18 18 6"/>,
    external: <><path d="M14 3h7v7M21 3 10 14M10 3H3v18h18v-7"/></>, check: <path d="m5 12 4 4L19 6"/>, pause: <><path d="M8 5v14M16 5v14"/></>,
    copy: <><rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V3H3v13h5"/></>, shield: <><path d="m12 2 8 4v6c0 5-8 10-8 10S4 17 4 12V6l8-4Z"/><path d="m8 12 3 3 5-6"/></>,
    retry: <><path d="M4 10a8 8 0 1 1 1 9M4 3v7h7"/></>, send: <><path d="m22 2-7 20-4-9-9-4L22 2Z"/><path d="m22 2-11 11"/></>,
    code: <><path d="m8 6-6 6 6 6M16 6l6 6-6 6M14 3l-4 18"/></>, globe: <><circle cx="12" cy="12" r="10"/><ellipse cx="12" cy="12" rx="4" ry="10"/><path d="M2 12h20"/></>,
    warning: <><path d="m12 3 10 18H2L12 3Z"/><path d="M12 9v5M12 17v.1"/></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
const money = (value: number | null | undefined, currency = 'USD') => {
  if (value == null) return '—';
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency, minimumFractionDigits: 3, maximumFractionDigits: 3 }).format(value); }
  catch { return `${currency} ${value.toFixed(3)}`; }
};
const clock = (s: string) => new Date(s).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const duration = (ms: number | null) => ms === null ? '—' : ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
const shortId = (s: string) => s.slice(-8).toUpperCase();
const statusClass = (s: string) => s.replaceAll(' ', '-');
const safeUrl = (url: string) => /^https?:\/\//i.test(url) ? url : '#';
const emptyRuntime: RuntimeSnapshot = { slots: [1, 2, 3].map(slot => ({ slot, jobId: null, kind: null, status: 'idle', startedAt: null, durationMs: null })), queue: [], execJobs: [], keenable: { searches: 0, fetches: 0, credits: 0 }, config: { archil: false, keenable: false, model: 'Codex', storage: 'Archil' } };

async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(typeof data.error === 'string' ? data.error : data.error?.message || data.message || `Request failed (${response.status})`), { status: response.status });
  return data as T;
}

function Badge({ status }: { status: string }) { return <span className={`status ${statusClass(status)}`}><span className="status-dot"/>{status}</span>; }

function App() {
  const [runtime, setRuntime] = useState<RuntimeSnapshot>(emptyRuntime);
  const [cases, setCases] = useState<CaseState[]>([]);
  const [selected, setSelected] = useState<string | null>(localStorage.getItem('sourcecontrol.case'));
  const [detail, setDetail] = useState<CaseDetail | null>(null);
  const [events, setEvents] = useState<AppEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [initialized, setInitialized] = useState(false);
  const [tab, setTab] = useState<'suppliers' | 'inbox' | 'evidence'>('suppliers');
  const [activeSupplier, setActiveSupplier] = useState<string | null>(null);
  const [demoOpen, setDemoOpen] = useState(false);
  const [view, setView] = useState<'scout' | 'workspace'>(() => localStorage.getItem('sourcecontrol.case') ? 'workspace' : 'scout');
  const [systemsOpen, setSystemsOpen] = useState(false);
  const [scoutReview, setScoutReview] = useState<ScoutReview | undefined>();
  const [importOpen, setImportOpen] = useState(false);
  const [outreachOpen, setOutreachOpen] = useState(false);
  const [emailStatus, setEmailStatus] = useState<EmailStatus | null>(null);
  const [pending, setPending] = useState<string[]>([]);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const [reply, setReply] = useState('');
  const [logOpen, setLogOpen] = useState(false);
  const selectedRef = useRef(selected);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const readRequests = useRef(new Set<string>());
  selectedRef.current = selected;

  const refresh = useCallback(async () => {
    try {
      const [result, currentRuntime, currentEmail] = await Promise.all([api<{ cases: CaseState[] }>('/api/cases'), api<RuntimeSnapshot>('/api/runtime'), api<EmailStatus>('/api/email/status').catch(() => null)]);
      setRuntime(currentRuntime);
      if (currentEmail) setEmailStatus(currentEmail);
      setCases(result.cases || []);
      const id = selectedRef.current;
      if (id && result.cases?.some(item => item.id === id)) {
        const next = await api<CaseDetail>(`/api/cases/${encodeURIComponent(id)}`);
        if (selectedRef.current === id) setDetail(next);
      }
      setInitialized(true);
    } catch (error) { setNotice({ text: (error as Error).message, error: true }); setInitialized(true); }
  }, []);
  useEffect(() => {
    refresh();
    api<RuntimeSnapshot>('/api/runtime').then(setRuntime).catch(() => {});
    const source = new EventSource('/api/events');
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    source.addEventListener('snapshot', event => { try { setRuntime(JSON.parse((event as MessageEvent).data)); } catch {} });
    source.addEventListener('event', event => {
      try {
        const value: AppEvent = JSON.parse((event as MessageEvent).data);
        setEvents(old => [value, ...old.filter(item => item.id !== value.id)].slice(0, 120));
        if (refreshTimer.current) clearTimeout(refreshTimer.current);
        refreshTimer.current = setTimeout(refresh, 250);
      } catch {}
    });
    const poll = setInterval(refresh, 12000);
    return () => { source.close(); clearInterval(poll); if (refreshTimer.current) clearTimeout(refreshTimer.current); };
  }, [refresh]);
  useEffect(() => {
    if (selected) {
      localStorage.setItem('sourcecontrol.case', selected);
      setDetail(null);
      api<CaseDetail>(`/api/cases/${encodeURIComponent(selected)}`).then(next => { if (selectedRef.current === selected) setDetail(next); }).catch(error => {
        if (selectedRef.current !== selected) return;
        if (error.status === 404) { selectedRef.current = null; setSelected(null); localStorage.removeItem('sourcecontrol.case'); }
        setNotice({ text: error.message, error: true });
      });
    }
    setActiveSupplier(null);
  }, [selected]);
  useEffect(() => { if (!notice || notice.error) return; const t = setTimeout(() => setNotice(null), 6000); return () => clearTimeout(t); }, [notice]);

  const work = async (name: string, fn: () => Promise<void>) => {
    if (pending.includes(name)) return;
    setPending(old => [...old, name]);
    try { await fn(); await refresh(); } catch (error) { setNotice({ text: (error as Error).message, error: true }); }
    finally { setPending(old => old.filter(item => item !== name)); }
  };
  const create = (rfq?: unknown) => work('create', async () => {
    const result = await api<CaseState>('/api/cases', rfq ? { rfq } : {});
    setSelected(result.id); selectedRef.current = result.id;
    setView('workspace'); setTab('suppliers'); setImportOpen(false);
    setNotice({ text: 'RFQ saved. Your sourcing case is ready.', error: false });
  });
  const saveRfq = async (rfq: Rfq, start: boolean) => {
    if (pending.includes('create')) return;
    setPending(old => [...old, 'create']);
    let created: CaseState | null = null;
    try {
      created = scoutReview ? await api<CaseState>('/api/scout/import', { rfq, source: scoutReview.source }) : await api<CaseState>('/api/cases', { rfq });
      selectedRef.current = created.id; setSelected(created.id); setView('workspace'); setTab('suppliers'); setImportOpen(false);
      if (start) {
        await api(`/api/cases/${created.id}/run`, {});
        setNotice({ text: 'RFQ saved and sourcing started. Open Agent activity to follow the workers.', error: false });
      } else setNotice({ text: 'RFQ saved as a draft. Start sourcing whenever you are ready.', error: false });
    } catch (error) {
      if (created) setNotice({ text: `Your RFQ is saved, but sourcing could not start: ${(error as Error).message}`, error: true });
      else throw error;
    } finally {
      setPending(old => old.filter(item => item !== 'create'));
      await refresh();
    }
  };
  const run = () => selected && work('run', async () => { await api(`/api/cases/${selected}/run`, {}); setNotice({ text: 'Case started. Open Agent activity to follow its progress.', error: false }); });
  const replay = () => selected && work('replay', async () => {
    const result = await api<CaseState | CaseDetail>(`/api/cases/${selected}/replay`, {});
    const next = 'state' in result ? result.state : result;
    selectedRef.current = next.id; setSelected(next.id); setView('workspace'); setTab('suppliers');
    setNotice({ text: 'Replay case created from saved evidence. Original source timestamps are retained. Start sourcing to run live synthesis and Archil verification; negotiations also run live against simulated replies.', error: false });
  });
  const demo = (action: string) => selected && work(action, async () => {
    await api(`/api/cases/${selected}/demo`, { action });
    setTab('inbox'); setNotice({ text: action === 'duplicate' ? 'Duplicate message submitted. Watch the event log for deduplication.' : 'Simulated reply submitted to the persistent inbox.', error: false });
  });
  const state = detail?.state;
  const isEmail = state?.communicationMode === 'email';
  const isTestEmail = isEmail && !!detail?.emailDrafts?.some(draft => draft.subject.includes('[TEST ONLY]')); 
  const mailbox = runtime.email || emailStatus;
  const visibleDemo = demoOpen && !isEmail && view === 'workspace';
  const suppliers = state?.suppliers || [];
  const supplier = suppliers.find(item => item.supplier.supplierId === activeSupplier) || suppliers[0];
  const conversation = supplier ? detail?.conversations[supplier.supplier.supplierId] || [] : [];
  const caseEvents = [...new Map([...(events.filter(e => e.caseId === selected)), ...(detail?.events || [])].map(e => [e.id, e])).values()].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 50);
  const best = [...suppliers].filter(s => s.status === 'target met').sort((a, b) => (a.latestOffer?.unitPrice ?? Infinity) - (b.latestOffer?.unitPrice ?? Infinity))[0];
  const negotiationCount = suppliers.filter(s => s.status === 'negotiating').length;
  const eventCount = caseEvents.length;
  const actionDisabled = !selected || suppliers.length === 0;
  const selectEmailCase = (next: CaseState) => {
    selectedRef.current = next.id; setSelected(next.id); setView('workspace'); setTab('inbox'); setOutreachOpen(false);
    setDemoOpen(false); setNotice({ text: 'Real-email case created. Review each recipient and draft before approving a send.', error: false });
    void refresh();
  };
  useEffect(() => {
    if (view !== 'workspace' || tab !== 'inbox' || !selected || !supplier || supplier.unread <= 0) return;
    const supplierId = supplier.supplier.supplierId;
    const key = `${selected}:${supplierId}`;
    if (readRequests.current.has(key)) return;
    readRequests.current.add(key);
    api<CaseState>(`/api/cases/${selected}/read`, { supplierId })
      .then(() => refresh())
      .catch(error => setNotice({ text: error.message, error: true }))
      .finally(() => readRequests.current.delete(key));
  }, [view, tab, selected, supplier?.supplier.supplierId, supplier?.unread, refresh]);

  const newRfq = () => { setScoutReview(undefined); setImportOpen(true); };
  const reviewScout = (review: ScoutReview) => { setScoutReview(review); setImportOpen(true); };
  const openWorkspace = (nextTab: 'suppliers' | 'inbox' | 'evidence' = 'suppliers') => { setView('workspace'); setTab(nextTab); };
  const runningWorkers = runtime.slots.filter(slot => slot.status === 'running').length;
  const runningVerifiers = runtime.execJobs.filter(job => job.status === 'running').length;
  const totalUnread = cases.reduce((sum, item) => sum + item.suppliers.reduce((count, supplier) => count + supplier.unread, 0), 0);
  const pageTitle = view === 'scout' ? 'RFQ Scout' : tab === 'inbox' ? 'Supplier inbox' : 'Sourcing workspace';
  const pageDescription = view === 'scout' ? 'Discover requirements. Review the details. Put the right ones to work.' : tab === 'inbox' ? 'Read supplier replies, compare terms, and review every outgoing email.' : 'Move from a buying requirement to a considered supplier shortlist.';

  return <div className="app-shell">
    <a className="skip-link" href="#main-content">Skip to workspace</a>
    <aside className="sidebar" aria-label="Main navigation">
      <a className="brand" href="/" aria-label="Source Control home"><span className="brand-symbol" aria-hidden="true"><i/><i/><i/><i/></span><span>SOURCE<span className="brand-slash"> / </span><br/>CONTROL<span className="brand-period">.</span></span></a>
      <div className="workspace-label"><span className="workspace-avatar">01</span><div>Procurement desk<small>LOCAL WORKSPACE</small></div></div>
      <nav aria-label="Workspace">
        <button className={`nav-item ${view === 'scout' ? 'active' : ''}`} onClick={() => setView('scout')}><Icon name="search"/><span>RFQ Scout</span><Icon name="chevron" size={13}/></button>
        <button className={`nav-item ${view === 'workspace' && tab !== 'inbox' ? 'active' : ''}`} onClick={() => openWorkspace()}><Icon name="grid"/><span>Sourcing</span><span className="nav-count">{cases.length}</span></button>
        <button className={`nav-item ${view === 'workspace' && tab === 'inbox' ? 'active' : ''}`} onClick={() => openWorkspace('inbox')}><Icon name="inbox"/><span>Supplier inbox</span>{totalUnread > 0 && <span className="nav-count unread-count">{totalUnread}</span>}</button>
      </nav>
      <div className="sidebar-section-title">YOUR CASES<button className="tiny-icon" aria-label="New RFQ" onClick={newRfq} disabled={pending.includes('create')}><Icon name="plus" size={15}/></button></div>
      <div className="case-list">{cases.length ? cases.map(item => <button className={`case-item ${item.id === selected && view === 'workspace' ? 'selected' : ''}`} key={item.id} onClick={() => { setSelected(item.id); openWorkspace(item.communicationMode === 'email' ? 'inbox' : 'suppliers'); }}><span className={`case-dot ${statusClass(item.status)}`}/><span><b>{item.rfq.description || 'Untitled RFQ'}</b><small>{item.communicationMode === 'email' ? 'Email' : 'Sourcing'} · {item.status}</small></span></button>) : <p className="sidebar-empty">Your sourcing cases<br/>will appear here.</p>}</div>
      <div className="sidebar-bottom"><div className="infra-heading">WORKSPACE CONNECTIONS</div><div className="infra-row"><span className={`small-dot ${runtime.config.archil ? 'green' : ''}`}/>Archil<small>{runtime.config.archil ? 'Connected' : 'Set up'}</small></div><div className="infra-row"><span className={`small-dot ${runtime.config.keenable ? 'green' : ''}`}/>Keenable<small>{runtime.config.keenable ? 'Connected' : 'Set up'}</small></div><div className="infra-row"><span className={`small-dot ${mailbox?.connected ? 'green' : ''}`}/>AgentMail<small>{mailbox?.connected ? 'Connected' : 'Set up'}</small></div><div className="local-user"><span className="user-avatar">YOU</span><div>Local operator<small>All sends reviewed</small></div></div></div>
    </aside>
    <div className="main-shell">
      <header className="topbar"><div className="breadcrumb">Procurement desk<Icon name="chevron" size={12}/><strong>{pageTitle}</strong></div><div className="topbar-actions"><span className={`connection ${connected ? 'online' : ''}`}><span/>{connected ? 'Live' : 'Reconnecting'}</span>{view === 'workspace' && !isEmail && <button className={`button button-small ${demoOpen ? 'button-dark' : 'button-secondary'}`} onClick={() => setDemoOpen(!demoOpen)}><Icon name="play" size={13}/>Demo</button>}</div></header>
      <div className={`workspace-layout ${visibleDemo ? 'with-drawer' : ''}`}>
        <main className="workspace-main" id="main-content" tabIndex={-1}>
          <div className="page-heading"><div><div className="eyebrow">SOURCE / CONTROL</div><h1>{pageTitle}</h1><p>{pageDescription}</p></div><button className="button button-primary import-button" onClick={newRfq}><Icon name="plus" size={16}/>New RFQ</button></div>
          {notice && <div role={notice.error ? 'alert' : 'status'} className={`notice ${notice.error ? 'notice-error' : 'notice-success'}`}><Icon name={notice.error ? 'warning' : 'check'} size={16}/><span>{notice.text}</span><button aria-label="Dismiss notification" onClick={() => setNotice(null)}><Icon name="close" size={15}/></button></div>}
          {view === 'scout' ? <ScoutPanel onReview={reviewScout}/> : <>
          <div className="compact-case-picker"><label htmlFor="active-case">Active case</label><select id="active-case" value={selected || ''} onChange={event => { if (event.target.value) setSelected(event.target.value); }}><option value="" disabled>{cases.length ? 'Select a sourcing case' : 'No sourcing cases yet'}</option>{cases.map(item => <option key={item.id} value={item.id}>{item.rfq.description} · {item.communicationMode === 'email' ? 'Email' : 'Sourcing'} · {item.status}</option>)}</select></div>
          {initialized && (!runtime.config.keenable || !runtime.config.archil) && <div className="setup-banner"><Icon name="warning" size={17}/><div><strong>Workspace setup</strong><span>{!runtime.config.keenable ? 'Connect Keenable to start live research. Run npm run connect:keenable in the app folder. ' : ''}{!runtime.config.archil ? 'Archil is not configured. ' : ''}</span></div><span className="tag">SETUP</span></div>}
          <details className="systems-panel" open={systemsOpen} onToggle={event => setSystemsOpen(event.currentTarget.open)}><summary><span className="system-summary-title"><Icon name="activity" size={17}/><strong>Agent activity</strong></span><span className="system-summary-meta"><span className={`small-dot ${runningWorkers || runningVerifiers ? 'orange' : 'green'}`}/>{runningWorkers ? `${runningWorkers} of 3 workers running` : 'Workers idle'}{runtime.queue.length > 0 ? ` · ${runtime.queue.length} queued` : ''}{runningVerifiers > 0 ? ` · ${runningVerifiers} verifying` : ''}</span><span className="system-summary-action">{systemsOpen ? 'Hide details' : 'View details'}<Icon name="chevron" size={14}/></span></summary><div className="systems-content">
          <section className="execution-panel" aria-label="Live agent execution"><div className="section-heading"><div><span className="live-indicator"/><h2>Live execution</h2><span className="section-caption">Actual worker activity</span></div><span className="mono muted">{runtime.queue.length} queued / 3 slots</span></div><div className="worker-grid">{runtime.slots.map(slot => <div key={slot.slot} className={`worker-card ${slot.status}`}><div className="worker-card-top"><span className="worker-icon"><Icon name="code" size={16}/></span><span className="mono worker-slot">SLOT {slot.slot}</span><span className={`worker-status ${slot.status}`}>{slot.status === 'running' && <span className="spinner"/>}{slot.status}</span></div><strong>{slot.kind ? slot.kind.replaceAll('-', ' ') : 'Ready for a task'}</strong><div className="worker-footer"><span title={slot.jobId || ''}>{slot.jobId ? slot.jobId.length > 33 ? `${slot.jobId.slice(0, 29)}…` : slot.jobId : 'Local Codex worker'}</span><span className="mono">{duration(slot.durationMs)}</span></div></div>)}</div>
          {runtime.queue.length > 0 && <div className="queue-bar"><Icon name="pause" size={13}/><span>Waiting for a free slot:</span>{runtime.queue.slice(0, 4).map(job => <span className={`queue-chip ${job.priority === 1 ? 'high' : ''}`} key={job.jobId}>{job.priority === 1 ? '↑ ' : ''}{job.kind}</span>)}</div>}
          <div className="data-plane"><div className="archil-label"><span className="archil-mark">A</span><div><strong>Archil serverless</strong><small>Evidence verification</small></div></div><div className="exec-list">{runtime.execJobs.length ? runtime.execJobs.slice(-2).map(job => <div key={job.id} className={`exec-job ${job.status}`}><div><span className={`small-dot ${job.status === 'completed' ? 'green' : job.status === 'running' ? 'orange' : ''}`}/><b>{job.track}</b><span>{job.status}</span><span className="mono">{duration(job.durationMs)}</span></div><div className="mounts">{job.mounts.map(mount => <span key={mount.name} title={`${mount.path} · ${mount.permission}`}><Icon name={mount.permission === 'readOnly' ? 'shield' : 'file'} size={10}/>{mount.name}<em>{mount.permission === 'readOnly' ? 'readOnly' : 'conditional'}</em></span>)}</div>{job.error && <p className="exec-error">{job.error}</p>}</div>) : <span className="exec-empty">No verification jobs yet. Each research track gets its own microVM.</span>}</div><div className="keenable-meter"><span className="eyebrow">KEENABLE</span><div><strong className="mono">{runtime.keenable.searches}</strong><span>searches</span><strong className="mono">{runtime.keenable.fetches}</strong><span>fetches</span></div><small>{runtime.keenable.credits.toFixed(1)} credits reported</small></div></div></section>
          {tab !== 'inbox' && <EmailConnectionPanel status={mailbox} onRefresh={refresh}/>}
          </div></details>
          {tab === 'inbox' && <EmailConnectionPanel status={mailbox} onRefresh={refresh}/>}
          {isTestEmail && <div className="setup-banner test-mode-banner"><Icon name="warning" size={17}/><div><strong>Controlled email test</strong><span>Messages run between your test accounts. Prices are fictional; the manufacturer has not provided these offers.</span></div><span className="tag">TEST ONLY</span></div>}
          {selected && !state ? <section className="case-loading" role="status"><span className="spinner"/><div><h2>Loading your sourcing case</h2><p>Restoring its evidence, conversations, and negotiation state.</p></div></section> : !state ? <section className="empty-workspace"><span className="eyebrow">GET STARTED</span><h2>Start with a clear requirement.</h2><p>Create a request or bring one in from RFQ Scout. Review the details, then find suitable manufacturers.</p><div className="empty-actions"><button className="button button-primary" onClick={newRfq}><Icon name="plus" size={16}/>Create RFQ</button><button className="text-button" onClick={() => setView('scout')}>Browse RFQs<Icon name="arrow" size={15}/></button></div><div className="workflow-steps"><span><b>01</b>Source with evidence</span><Icon name="arrow" size={13}/><span><b>02</b>Compare & negotiate</span><Icon name="arrow" size={13}/><span><b>03</b>Resume from disk</span></div></section> : <>
          <section className="rfq-card"><div className="rfq-top"><div className="rfq-label"><span className="file-icon"><Icon name="file" size={20}/></span><div><span className="eyebrow">RFQ · {shortId(state.id)}</span><h2>{state.rfq.description}</h2></div></div><div className="rfq-top-actions"><Badge status={state.status}/><button className="button button-primary" onClick={run} disabled={pending.includes('run') || state.status === 'researching'}>{state.status === 'researching' ? <span className="spinner"/> : <Icon name={state.error ? 'retry' : 'play'} size={14}/>} {isEmail ? 'Resume monitoring' : state.researchComplete ? 'Resume case' : state.status === 'researching' ? 'Researching' : state.error ? 'Retry sourcing' : 'Start sourcing'}</button></div></div><div className="rfq-metrics"><div><label>REQUIREMENT</label><strong>{state.rfq.standard} · {state.rfq.size}</strong><small>Grade {state.rfq.grade} · {state.rfq.finish}</small></div><div><label>QUANTITY</label><strong className="mono">{state.rfq.quantity.toLocaleString()}<small> pcs</small></strong><small>{state.rfq.incoterm} {state.rfq.destination}</small></div><div><label>TARGET / UNIT</label><strong className="mono accent">{money(state.rfq.targetUnitPrice, state.rfq.currency)}</strong><small>Maximum {money(state.rfq.maxUnitPrice, state.rfq.currency)} · {state.rfq.currency}</small></div><div><label>DELIVERY</label><strong className={state.rfq.requiredBy ? '' : 'unresolved'}>{state.rfq.requiredBy || 'To be confirmed'}</strong><small>{state.rfq.requiredBy ? 'Required by buyer' : 'Unresolved requirement'}</small></div></div>{state.rfqSource && <RfqSource source={state.rfqSource}/>}<div className="rfq-foot"><span><span className="small-dot green"/>{runtime.config.storage === 'Local test storage' ? 'Saved locally · test mode' : 'Persisted on Archil'}</span><span>{state.researchMode === 'saved research' ? 'Saved research — labeled replay' : 'Live supplier research'}<i/>{isTestEmail ? 'Test email exchange · fictional offers' : isEmail ? 'Real email · every send reviewed' : 'Negotiation replies and offers are simulated'}</span></div>{state.error && <div className="case-error"><Icon name="warning" size={15}/>{state.error}</div>}</section>
          {best && <div className="recommendation"><span className="recommendation-check"><Icon name="check" size={22}/></span><div><strong>{isTestEmail ? 'Test price target met' : `Price target met · ${best.supplier.companyName}`}</strong><span>{isTestEmail ? 'Latest fictional test offer:' : isEmail ? 'Latest supplier offer:' : 'Latest simulated offer:'} {money(best.latestOffer?.unitPrice, best.latestOffer?.currency || state.rfq.currency)} / unit. {state.rfq.requiredBy ? '' : 'Delivery date still requires confirmation. '}No purchase commitment.</span></div><span className="tag">{isTestEmail ? 'TEST EMAIL' : isEmail ? 'REAL EMAIL' : 'SIMULATED'}</span></div>}
          {!isEmail && state.holdProcessingMs > 0 && <div className="hold-banner"><Icon name="pause" size={17}/><strong>Crash-test hold enabled</strong><span>Incoming replies persist to Archil before the 5-second processing delay.</span></div>}
          <section className="workspace-content">{!isEmail && state.researchComplete && suppliers.length > 0 && <div className="outreach-prepare-bar"><div><strong>Take the shortlist to your suppliers</strong><p>Prepare reviewed RFQ emails in a separate case using published contacts.</p></div><button className="button button-secondary" onClick={() => setOutreachOpen(true)}><Icon name="send" size={15}/>Prepare email outreach</button></div>}<div className="content-tabs" role="tablist" aria-label="Sourcing views"><button role="tab" aria-selected={tab === 'suppliers'} className={tab === 'suppliers' ? 'selected' : ''} onClick={() => setTab('suppliers')}><Icon name="grid" size={15}/>Supplier shortlist<span>{suppliers.length}</span></button><button role="tab" aria-selected={tab === 'inbox'} className={tab === 'inbox' ? 'selected' : ''} onClick={() => setTab('inbox')}><Icon name="inbox" size={15}/>Negotiation inbox<span>{suppliers.reduce((a, s) => a + (detail?.conversations[s.supplier.supplierId]?.length || 0), 0)}</span></button><button role="tab" aria-selected={tab === 'evidence'} className={tab === 'evidence' ? 'selected' : ''} onClick={() => setTab('evidence')}><Icon name="shield" size={15}/>Evidence</button><span className="tab-note">{isTestEmail ? 'TEST EMAIL · FICTIONAL OFFERS' : isEmail ? 'REAL EMAIL · REVIEWED SENDS' : negotiationCount > 0 ? `${negotiationCount} negotiating` : 'SIMULATED COMMUNICATIONS'}</span></div>
          {suppliers.length === 0 ? <div className="inner-empty"><Icon name={state.status === 'researching' ? 'search' : 'grid'} size={26}/><h3>{state.status === 'researching' ? 'Looking for the right fit.' : 'Your shortlist is waiting.'}</h3><p>{state.status === 'researching' ? 'English and Mandarin tracks are researching candidates. Expand Agent activity to follow their progress.' : 'Start sourcing to discover manufacturers and examine the evidence behind each candidate.'}</p></div> : tab === 'suppliers' ? <><div className="table-scroll"><table className="supplier-table"><thead><tr><th>SUPPLIER / LOCATION</th><th>TECHNICAL FIT</th><th>LATEST / UNIT</th><th>NEGOTIATION</th><th/></tr></thead><tbody>{suppliers.map((s, index) => <tr key={s.supplier.supplierId}><td><button className="supplier-name-button" onClick={() => { setActiveSupplier(s.supplier.supplierId); setTab('evidence'); }}><span className="supplier-avatar">{String(index + 1).padStart(2, '0')}</span><span><strong>{s.supplier.companyName}</strong><small>{s.supplier.city || 'Location unconfirmed'}{s.supplier.chineseName ? ` · ${s.supplier.chineseName}` : ''}</small></span></button></td><td><div className="fit-cell"><span className="fit-track"><span style={{ width: `${Math.max(0, Math.min(100, s.supplier.technicalFit.score))}%` }}/></span><strong className="mono">{s.supplier.technicalFit.score}<small>/100</small></strong></div><small className="muted">Evidence-based assessment</small></td><td><strong className="mono price">{money(s.latestOffer?.unitPrice, s.latestOffer?.currency || state.rfq.currency)}</strong><small className="price-origin">{s.originalOffer ? `Initial ${money(s.originalOffer.unitPrice, s.originalOffer.currency || state.rfq.currency)}` : 'Awaiting quote'}</small></td><td><Badge status={s.status}/><small className="round-caption">{s.round}/1 counteroffers</small></td><td><button className="row-open" aria-label={`Open conversation with ${s.supplier.companyName}`} onClick={() => { setActiveSupplier(s.supplier.supplierId); setTab('inbox'); }}><Icon name="chevron" size={18}/></button></td></tr>)}</tbody></table></div><div className="shortlist-note"><Icon name="shield" size={14}/><span>Sources show why a candidate fits. Published claims are not independently verified factory credentials.</span></div></> : tab === 'inbox' ? <div className="inbox-layout"><div className="thread-list">{suppliers.map(s => <button key={s.supplier.supplierId} className={`thread-button ${s === supplier ? 'selected' : ''}`} onClick={() => setActiveSupplier(s.supplier.supplierId)}><div><strong>{s.supplier.companyName}</strong>{s.unread > 0 && <span className="unread">{s.unread}</span>}</div><small>{s.nextAction || s.status}</small><div><Badge status={s.status}/><span className="mono">{money(s.latestOffer?.unitPrice, s.latestOffer?.currency || state.rfq.currency)}</span></div></button>)}</div><div className="conversation">{supplier && <><div className="conversation-heading"><div><h3>{supplier.supplier.companyName}</h3><span>{supplier.round}/1 counteroffers · persistent conversation</span></div><span className="tag">{isTestEmail ? 'TEST EMAIL / REVIEWED SENDS' : isEmail ? 'REAL EMAIL / REVIEWED SENDS' : 'SIMULATED INBOX'}</span></div><div className="messages">{conversation.length ? conversation.map(message => <MessageBubble key={message.messageId} message={message}/>) : <div className="messages-empty"><Icon name="inbox" size={24}/><p>No messages in this conversation yet.</p></div>}</div><OfferHistory entries={detail?.offerHistory?.[supplier.supplier.supplierId] || []} simulated={!isEmail}/>{isEmail && <QuoteSourceEvidence entries={detail?.quoteEvidence?.[supplier.supplier.supplierId] || []} messages={conversation}/>}<div className="next-action"><span className="eyebrow">NEXT ACTION</span><p>{supplier.nextAction || supplier.explanation || 'Awaiting supplier reply.'}</p></div>{isEmail ? <><EmailDrafts drafts={(detail?.emailDrafts || []).filter(draft => draft.supplierId === supplier.supplier.supplierId)} onRefresh={refresh}/><div className="mail-monitor-note"><span className={`small-dot ${mailbox?.connected ? 'green' : ''}`}/><p>{mailbox?.connected ? 'Monitoring real replies while this backend is running. Check replies now above to sync immediately.' : 'Connect your inbox above to receive real supplier replies.'} Saved decisions resume after restart.</p></div></> : <form className="reply-composer" onSubmit={event => { event.preventDefault(); if (!reply.trim()) return; work('reply', async () => { await api(`/api/cases/${selected}/inbox/reply`, { messageId: crypto.randomUUID(), supplierId: supplier.supplier.supplierId, text: reply }); setReply(''); }); }}><label htmlFor="supplier-reply">Add a simulated supplier reply</label><textarea id="supplier-reply" value={reply} onChange={e => setReply(e.target.value)} placeholder="Enter the supplier’s quote, specifications, and terms…" rows={3}/><div><small>Persisted before processing. No external email is sent.</small><button className="button button-dark button-small" type="submit" disabled={!reply.trim() || pending.includes('reply')}><Icon name="send" size={13}/>Submit reply</button></div></form>}</>}</div></div> : <div className="evidence-layout">{state.researchAttempt && suppliers.length > 0 && <div className="evidence-replay-bar"><div><strong>Reuse the captured sources</strong><p>Original source timestamps stay intact. Synthesis, verification, and negotiation run live in a new case.</p></div><button className="button button-secondary" disabled={pending.includes('replay')} onClick={replay}>{pending.includes('replay') ? <span className="spinner"/> : <Icon name="retry" size={15}/>}Replay saved evidence</button></div>}<div className="evidence-tabs">{suppliers.map(s => <button className={supplier === s ? 'selected' : ''} key={s.supplier.supplierId} onClick={() => setActiveSupplier(s.supplier.supplierId)}>{s.supplier.companyName}</button>)}</div>{supplier && <Evidence candidate={supplier.supplier}/>}</div>}
          </section>
          <section className="activity-panel" id="activity-log"><button className="activity-heading" onClick={() => setLogOpen(!logOpen)} aria-expanded={logOpen}><span><Icon name="activity" size={17}/><h2>Operational timeline</h2><small>{eventCount} events</small></span><Icon name={logOpen ? 'close' : 'plus'} size={16}/></button>{logOpen && <div className="event-list">{caseEvents.length ? caseEvents.map(event => <div className={`event-row ${event.type.includes('error') || event.type.includes('failed') ? 'event-error' : ''}`} key={event.id}><time className="mono">{clock(event.at)}</time><span className="event-dot"/><div><strong>{event.message}</strong><small className="mono">{event.type}{event.supplierId ? ` · ${shortId(event.supplierId)}` : ''}</small></div></div>) : <div className="log-empty">Case events will appear here as the workflow progresses.</div>}</div>}</section>
          </>}

          </>}
          <footer className="workspace-footer"><span>SOURCE / CONTROL</span><p>Requirements → suppliers → reviewed conversations</p><span>POWERED BY ARCHIL</span></footer>
        </main>
        {visibleDemo && <aside className="demo-drawer" aria-label="Demo controls"><div className="drawer-heading"><div className="eyebrow">THE 90-SECOND WALKTHROUGH</div><div><h2>Run the story.</h2><button className="icon-button" aria-label="Close demo controls" onClick={() => setDemoOpen(false)}><Icon name="close" size={17}/></button></div><p>Live agents. Real evidence.<br/>Clearly simulated negotiations.</p></div><div className="demo-steps"><DemoButton number="01" icon="file" title="Load default RFQ" description="50,000 fasteners · CIF Oakland" disabled={pending.includes('create')} busy={pending.includes('create')} onClick={() => create()}/><DemoButton number="02" icon="inbox" title="Three concurrent quotes" description="One reply for each shortlisted supplier" disabled={actionDisabled || pending.includes('initial-quotes')} busy={pending.includes('initial-quotes')} onClick={() => demo('initial-quotes')}/><DemoButton number="03" icon="copy" title="Inject duplicate message" description="Watch the inbox deduplicate it" disabled={actionDisabled || pending.includes('duplicate')} busy={pending.includes('duplicate')} onClick={() => demo('duplicate')}/><DemoButton number="04" icon="warning" title="Change spec to Grade 8.8" description="Route the substitution to attention" disabled={actionDisabled || pending.includes('spec-mutation')} busy={pending.includes('spec-mutation')} onClick={() => demo('spec-mutation')}/><DemoButton number="05" icon="check" title="Reply at $0.064 / unit" description="Meet the price target, preserve the spec" disabled={actionDisabled || pending.includes('final-reply')} busy={pending.includes('final-reply')} onClick={() => demo('final-reply')}/></div><div className="crash-test"><div><span className="crash-icon"><Icon name="retry" size={19}/></span><h3>Prove it survives.</h3></div><p>Hold processing, submit a reply, then restart the backend. Archil keeps the pending work.</p><label className="toggle-row"><span>Hold queue 5s<small>Crash test</small></span><button role="switch" aria-checked={!!state?.holdProcessingMs} aria-label="Hold queue five seconds for crash test" disabled={!state || pending.includes('hold')} className={`toggle ${state?.holdProcessingMs ? 'on' : ''}`} onClick={() => selected && work('hold', async () => { await api(`/api/cases/${selected}/hold`, { holdProcessingMs: state?.holdProcessingMs ? 0 : 5000 }); })}><span/></button></label><div className="crash-caption"><span className="small-dot"/>Persist → acknowledge → process</div></div><div className="demo-note"><Icon name="shield" size={18}/><p>All inbox replies and prices in this walkthrough are simulated. No orders are placed.</p></div><div className="drawer-foot"><span className="mono">01 / LOCAL DEMO</span><span className="small-dot orange"/></div></aside>}
      </div>
    </div>
    {outreachOpen && state && <OutreachDialog state={state} connected={!!mailbox?.connected} onClose={() => setOutreachOpen(false)} onCreated={selectEmailCase}/>}
    {importOpen && <RfqDialog onClose={() => { setImportOpen(false); if (scoutReview) setView('scout'); }} onSave={saveRfq} busy={pending.includes('create')} keenable={runtime.config.keenable} initialRfq={scoutReview?.rfq} sourceTitle={scoutReview?.title} sourceWarnings={scoutReview?.warnings}/>}
  </div>;
}

function RfqSource({ source }: { source: RfqProvenance }) {
  return <details className="rfq-provenance"><summary><span><Icon name="file" size={14}/><strong>Imported source</strong><small>{source.title}</small></span><Icon name="chevron" size={13}/></summary><dl><div><dt>Origin</dt><dd>{source.diskName ? `${source.diskName} · ${source.diskId}` : 'Local RFQ document'}</dd></div><div><dt>File</dt><dd>{source.path}</dd></div><div><dt>Source fingerprint</dt><dd><code>{source.sha256}</code></dd></div>{source.snapshotSha256 && <div><dt>Saved snapshot</dt><dd><code>{source.snapshotSha256}</code></dd></div>}<div><dt>Imported</dt><dd>{new Date(source.importedAt).toLocaleString()}</dd></div></dl><p>Original source retained. Reviewed buying requirements are shown above.</p></details>;
}

function DemoButton({ number, icon, title, description, disabled, busy, onClick }: { number: string; icon: IconName; title: string; description: string; disabled: boolean; busy: boolean; onClick: () => unknown }) {
  return <button className="demo-step" disabled={disabled} onClick={onClick}><span className="step-number mono">{number}</span><span className="step-body"><strong>{title}</strong><small>{description}</small></span><span className="step-icon">{busy ? <span className="spinner"/> : <Icon name={icon} size={17}/>}</span></button>;
}
function MessageBubble({ message }: { message: Message }) {
  return <article className={`message ${message.direction}`}><div className="message-meta"><span>{message.email?.from || (message.direction === 'inbound' ? 'Supplier' : 'Sourcing agent')}</span><small>{message.simulated ? 'SIMULATED' : 'REAL EMAIL'}</small><time dateTime={message.createdAt} title={new Date(message.createdAt).toLocaleString()}>{clock(message.createdAt)}</time></div>{message.email && <details className="mail-headers"><summary>{message.email.subject || '(No subject)'}</summary><dl><div><dt>From</dt><dd>{message.email.from}</dd></div><div><dt>To</dt><dd>{message.email.to.join(', ')}</dd></div><div><dt>Received</dt><dd>{new Date(message.createdAt).toLocaleString()}</dd></div><div><dt>Message ID</dt><dd className="mono">{message.email.rfcMessageId}</dd></div><div><dt>Thread</dt><dd className="mono">{message.email.threadId}</dd></div>{message.email.attachments.length > 0 && <div><dt>Attachments</dt><dd>{message.email.attachments.map(item => item.filename).join(', ')} · metadata only</dd></div>}{message.email.truncated && <div><dt>Capture</dt><dd>Truncated message · some content may be unavailable</dd></div>}</dl></details>}<div className="message-body">{message.text}</div><div className="message-id mono" title={message.messageId}>{message.messageId}</div></article>;
}

function OfferHistory({ entries, simulated }: { entries: { sourceMessageId: string; createdAt: string; quote: Quote; status: SupplierStatus; explanation: string }[]; simulated: boolean }) {
  return <details className="offer-history"><summary><span><Icon name="activity" size={15}/><strong>Offer history</strong><small>{entries.length} {entries.length === 1 ? 'offer' : 'offers'}</small></span><span className="tag">{simulated ? 'SIMULATED' : 'SUPPLIER EMAIL'}</span></summary>{entries.length ? <div className="offer-history-scroll"><table><thead><tr><th>RECEIVED</th><th>PRICE / UNIT</th><th>GRADE</th><th>LEAD TIME</th><th>STATUS</th></tr></thead><tbody>{[...entries].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(entry => <tr key={entry.sourceMessageId}><td><time className="mono" dateTime={entry.createdAt} title={new Date(entry.createdAt).toLocaleString()}>{clock(entry.createdAt)}</time></td><td><strong className="mono">{entry.quote.unitPrice == null ? '—' : entry.quote.unitPrice.toFixed(3)}</strong><small>{entry.quote.currency || 'Currency unknown'}</small></td><td>{entry.quote.grade || '—'}</td><td>{entry.quote.leadTimeDays == null ? 'Unconfirmed' : `${entry.quote.leadTimeDays} days`}</td><td><Badge status={entry.status}/><p>{entry.explanation}</p></td></tr>)}</tbody></table></div> : <p className="offer-history-empty">Parsed supplier offers will appear here as replies are processed.</p>}</details>;
}
function Evidence({ candidate }: { candidate: Candidate }) {
  return <div className="evidence-content"><div className="evidence-heading"><div><div className="eyebrow">SUPPLIER DOSSIER</div><h3>{candidate.companyName}</h3><p>{candidate.chineseName}{candidate.chineseName && candidate.city ? ' · ' : ''}{candidate.city}</p></div><a className="button button-secondary button-small" href={safeUrl(candidate.sourceUrl)} target="_blank" rel="noreferrer">Source website<Icon name="external" size={13}/></a></div><p className="fit-summary">{candidate.technicalFit.summary}</p><div className="evidence-columns"><div><h4>Published contact details</h4>{candidate.publishedContacts.emails.map(email => <span className="contact-value" key={email}>{email}</span>)}{candidate.publishedContacts.phones.map(phone => <span className="contact-value mono" key={phone}>{phone}</span>)}{!candidate.publishedContacts.emails.length && !candidate.publishedContacts.phones.length && <p className="muted">No supported contact found in the captured sources.</p>}<h4>Manufacturing indicators</h4>{candidate.manufacturingEvidence.length ? <ul className="evidence-list">{candidate.manufacturingEvidence.map((v, i) => <li key={i}>{v}</li>)}</ul> : <p className="muted">Not established by captured evidence.</p>}<h4>Published certifications</h4><p>{candidate.certifications.length ? candidate.certifications.join(' · ') : 'None established in the source snapshot.'}</p></div><div><h4>Open questions <span className="uncertainty-count">{candidate.uncertainties.length}</span></h4>{candidate.uncertainties.length ? <ul className="uncertainty-list">{candidate.uncertainties.map((v, i) => <li key={i}><Icon name="warning" size={13}/><span>{v}</span></li>)}</ul> : <p className="muted">No additional extraction uncertainties reported. Factory claims still require independent verification.</p>}</div></div><div className="source-quotes"><h4>Evidence excerpts</h4>{candidate.evidenceQuotes.map((quote, i) => <blockquote key={i}><span className="eyebrow">{quote.claim}</span><p>“{quote.text}”</p><a href={safeUrl(quote.url)} target="_blank" rel="noreferrer">{quote.url}<Icon name="external" size={11}/></a></blockquote>)}</div><div className="fingerprints"><h4><Icon name="shield" size={15}/>Snapshot fingerprints</h4><p>These hashes identify the saved content evaluated by the agents. They do not establish that a supplier’s claims are true.</p>{candidate.fingerprints.map((fp, i) => <div className="fingerprint" key={`${fp.url}-${i}`}><div><a href={safeUrl(fp.url)} target="_blank" rel="noreferrer">{fp.url}</a><span className="tag">{fp.truncated ? 'TRUNCATED' : 'CAPTURED'}</span></div><code>SHA-256 {fp.sha256}</code><small>Retrieved {new Date(fp.fetchedAt).toLocaleString()}</small></div>)}</div></div>;
}

createRoot(document.getElementById('root')!).render(<App/>);
