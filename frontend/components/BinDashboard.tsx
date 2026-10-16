'use client';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Camera, CheckCircle2, CircleHelp, Clock3, Leaf, MessageCircle, Plus, Send, Wifi, WifiOff, X } from 'lucide-react';
import CameraCapture from './CameraCapture';
import { useBackendStatus } from './useBackendStatus';
import { classifyScan, createAiConversation, getAiMessages, getBin, getScanInterpretation, getScans, getStats, sendAiMessage } from '@/lib/api';
import { BIN_INFO, type AiMessage, type AiSource, type BinDetails, type BinId, type Scan, type ScanInterpretation, type Stats } from '@/lib/types';

const BinScene = dynamic(() => import('./BinScene'), { ssr: false, loading: () => <div className="scene-loading">Preparing 3D bin…</div> });
type ChatEntry = AiMessage & { sources?: AiSource[] };

function dateLabel(date?: string | null) {
  if (!date) return 'No scans yet';
  const value = new Date(date);
  return Number.isNaN(value.valueOf()) ? 'Unknown time' : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(value);
}

function InterpretationPanel({ scanId, interpretation, busy, error, onInterpret }: {
  scanId: string | null; interpretation: ScanInterpretation | null; busy: boolean; error: string; onInterpret: () => void;
}) {
  return <section className="panel-section interpretation-panel">
    <div className="section-title"><h3>AI scan interpretation</h3><span>SEPARATE FROM YOLO</span></div>
    {interpretation ? <>
      <p className="interpretation-summary">{interpretation.summary}</p>
      <div className="interpretation-counts"><span><b>{interpretation.confirmed_waste_items.length}</b> confirmed</span><span><b>{interpretation.possible_waste_items.length}</b> possible</span><span><b>{interpretation.excluded_detections.length}</b> excluded</span></div>
      {interpretation.possible_waste_items.length > 0 && <div className="interpretation-items"><strong>Possible waste</strong>{interpretation.possible_waste_items.slice(0, 4).map(item => <p key={item.detection_index}>{item.original_label}{item.confidence !== null ? ` · ${Math.round(item.confidence * 100)}%` : ''} — {item.reason}</p>)}</div>}
      {interpretation.excluded_detections.length > 0 && <div className="interpretation-items excluded"><strong>Excluded detections</strong>{interpretation.excluded_detections.map(item => <p key={item.detection_index}>{item.original_label} — {item.reason}</p>)}</div>}
      {interpretation.recommendations.length > 0 && <div className="interpretation-items"><strong>Next steps</strong>{interpretation.recommendations.slice(0, 2).map((item, index) => <p key={index}>{item}</p>)}</div>}
      {interpretation.limitations.length > 0 && <p className="interpretation-limit">{interpretation.limitations[0]}</p>}
    </> : <div className="empty-state compact"><span>⌁</span><p>{scanId ? 'No interpretation saved' : 'No scan to interpret'}</p><small>{scanId ? 'Review the latest scan with the AI assistant.' : 'Capture a waste image to start.'}</small></div>}
    {error && <p className="inline-error">{error}</p>}
    {scanId && <button className="interpret-button" disabled={busy} onClick={onInterpret}>{busy ? 'Interpreting…' : interpretation ? 'Refresh interpretation' : 'Interpret latest scan'}</button>}
  </section>;
}

export default function BinDashboard({ binId: raw }: { binId: string }) {
  const valid = raw === 'bin-01' || raw === 'bin-02';
  const id = (valid ? raw : 'bin-01') as BinId;
  const info = BIN_INFO[id];
  const backend = useBackendStatus();
  const [details, setDetails] = useState<BinDetails | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [scans, setScans] = useState<Scan[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [capture, setCapture] = useState(false);
  const [assistant, setAssistant] = useState(false);
  const [chatMessages, setChatMessages] = useState<ChatEntry[]>([]);
  const [conversationId, setConversationId] = useState('');
  const [conversationLoading, setConversationLoading] = useState(true);
  const [chatBusy, setChatBusy] = useState(false);
  const [chatError, setChatError] = useState('');
  const [draft, setDraft] = useState('');
  const [latestScanId, setLatestScanId] = useState<string | null>(null);
  const [interpretation, setInterpretation] = useState<ScanInterpretation | null>(null);
  const [interpretBusy, setInterpretBusy] = useState(false);
  const [interpretError, setInterpretError] = useState('');
  const counts = useMemo(() => Object.entries(stats?.detections_by_label || {}).sort((a, b) => b[1] - a[1]), [stats]);
  const storageKey = `rebin-ai-conversation:${id}`;

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [binResponse, statsResponse, scanResponse] = await Promise.all([getBin(id), getStats(id), getScans(id)]);
      setDetails(binResponse.data);
      setStats(statsResponse.data);
      setScans(scanResponse.data);
      const latest = scanResponse.data[0];
      const scanId = latest?.id || latest?.scan_id || null;
      setLatestScanId(scanId);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load bin data.');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    let active = true;
    if (!latestScanId) return () => { active = false; };
    setInterpretation(null);
    setInterpretError('');
    getScanInterpretation(latestScanId).then(response => {
      if (active && response.data.classification_status === 'completed') setInterpretation(response.data.interpretation);
      else if (active && response.data.error_message) setInterpretError(response.data.error_message);
    }).catch(() => { /* A missing interpretation is the normal state before the user requests one. */ });
    return () => { active = false; };
  }, [latestScanId]);

  const startConversation = useCallback(async (forceNew = false) => {
    setConversationLoading(true);
    setChatError('');
    try {
      if (!forceNew) {
        const savedId = window.localStorage.getItem(storageKey);
        if (savedId) {
          try {
            const history = await getAiMessages(savedId);
            if (history.data.bin_id === id) {
              setConversationId(savedId);
              setChatMessages(history.data.messages);
              return;
            }
          } catch { window.localStorage.removeItem(storageKey); }
        }
      }
      const created = await createAiConversation(id);
      window.localStorage.setItem(storageKey, created.data.conversation_id);
      setConversationId(created.data.conversation_id);
      setChatMessages([]);
    } catch (e) {
      setChatError(e instanceof Error ? e.message : 'Could not start a saved conversation.');
    } finally {
      setConversationLoading(false);
    }
  }, [id, storageKey]);

  useEffect(() => { void startConversation(); }, [startConversation]);

  const send = async (event: React.FormEvent) => {
    event.preventDefault();
    const message = draft.trim();
    if (!message || !conversationId || chatBusy) return;
    const optimistic: ChatEntry = { id: `local-${Date.now()}`, role: 'user', content: message, created_at: new Date().toISOString() };
    setChatMessages(current => [...current, optimistic]);
    setDraft('');
    setChatBusy(true);
    setChatError('');
    try {
      const response = await sendAiMessage(conversationId, id, message);
      const answer: ChatEntry = { id: `answer-${Date.now()}`, role: 'assistant', content: response.data.answer, created_at: new Date().toISOString(), sources: response.data.sources };
      setChatMessages(current => [...current, answer]);
    } catch (e) {
      setChatError(e instanceof Error ? e.message : 'AI request failed. Please retry.');
    } finally {
      setChatBusy(false);
    }
  };

  const runInterpretation = async () => {
    if (!latestScanId) return;
    setInterpretBusy(true);
    setInterpretError('');
    try {
      const response = await classifyScan(latestScanId);
      setInterpretation(response.data);
      await load();
    } catch (e) {
      setInterpretError(e instanceof Error ? e.message : 'AI interpretation failed. Original YOLO results remain unchanged.');
    } finally {
      await load();
      setInterpretBusy(false);
    }
  };

  if (!valid) return <main className="not-found"><div className="not-found-mark"><CircleHelp/></div><p className="eyebrow">BIN NOT FOUND</p><h1>This campus location doesn’t exist.</h1><Link href="/" className="button-primary">Return to campus</Link></main>;

  return <main className="bin-page" style={{ '--bin-accent': info.accent, '--bin-light': info.color } as React.CSSProperties}>
    <section className="visual-pane"><BinScene id={id} capacity={details?.capacity || null} stale={backend !== 'connected'}/><div className="visual-vignette"/><header className="bin-topbar"><Link href="/" className="back-link"><ArrowLeft size={16}/> Campus map</Link><span className="scene-live"><i/> 3D DIGITAL TWIN</span></header><div className="bin-heading"><span className="eyebrow">SMART RECYCLING STATION <b>·</b> {id.toUpperCase()}</span><h1>{info.name}</h1><p><span className="pin-dot"/>{info.location}<span className="heading-divider"/>Campus collection point</p></div><div className="scene-bottom"><span><span className="orbit-hint">↻</span> Drag to orbit <i/> Scroll to zoom</span><button className="button-primary capture-button" onClick={() => setCapture(true)}><Camera size={16}/> Capture Waste</button></div></section>
    <aside className="analytics-panel">
      <div className="panel-header"><div><span className="eyebrow">LOCATION OVERVIEW</span><h2>Live insights</h2></div><span className={`status-dot ${backend === 'connected' ? 'online' : ''}`} title={backend === 'connected' ? 'Backend connected' : 'Backend offline'}>{backend === 'connected' ? <Wifi size={14}/> : <WifiOff size={14}/>}</span></div>
      {error && <div className="error-card"><WifiOff size={17}/><div><strong>{backend === 'offline' ? 'Backend unavailable' : 'Could not load data'}</strong><p>{error}</p><button onClick={() => void load()}>Retry connection</button></div></div>}
      {loading ? <div className="analytics-loading"><span className="loading-ring"/>Loading bin data…</div> : <>
        <div className="metric-grid"><div className="metric-card"><span>Scans recorded</span><strong>{details?.total_scans ?? stats?.total_scans ?? 0}</strong><small>All time at this bin</small></div><div className="metric-card"><span>Objects detected</span><strong>{details?.total_detections ?? stats?.total_detections ?? 0}</strong><small>Raw YOLO detections</small></div></div>
        {details?.capacity && <section className="panel-section"><div className="section-title"><h3>Stored bin capacity</h3><span>{backend === 'connected' ? 'LIVE' : 'STALE'}</span></div><div className="metric-grid"><div className="metric-card"><span>Fill level</span><strong>{Math.round(details.capacity.capacity_percentage)}%</strong><small>{details.capacity.current_fill_liters.toFixed(1)} L / {details.capacity.capacity_liters.toFixed(0)} L</small></div><div className="metric-card"><span>Remaining</span><strong>{details.capacity.remaining_liters.toFixed(1)} L</strong><small>{details.capacity.status}</small></div></div><p className="interpretation-limit">{details.acceptance_policy.note} Volume figures are configurable estimates, not camera measurements.</p></section>}
        <section className="panel-section"><div className="section-title"><h3>Raw detections by label</h3><span>{counts.length ? `${counts.length} labels` : ''}</span></div>{counts.length ? <div className="labels-list">{counts.slice(0, 7).map(([label, count]) => <div className="label-row" key={label}><span className="label-icon"><Leaf size={13}/></span><span className="label-name">{label}</span><span className="label-count">{count}</span><div className="label-track"><i style={{ width: `${Math.max(10, (count / Math.max(...counts.map(([, n]) => n))) * 100)}%` }}/></div></div>)}</div> : <div className="empty-state"><span>⌁</span><p>No detections yet</p><small>Capture an image to begin tracking objects here.</small></div>}</section>
        <section className="panel-section history-section"><div className="section-title"><h3>Recent scans</h3><span>LAST 10</span></div>{scans.length ? <div className="scan-list">{scans.slice(0, 5).map((scan, index) => { const result = scan.result; const total = scan.total_detections ?? result?.summary?.total_detections ?? 0; const labels = scan.counts_by_label ?? result?.summary?.counts_by_label ?? {}; return <article className="scan-row" key={scan.id || scan.scan_id || `${scan.created_at}-${index}`}><span className="scan-icon"><Camera size={14}/></span><div className="scan-copy"><strong>{scan.image_filename || `Waste scan ${scans.length - index}`}</strong><small><Clock3 size={11}/>{dateLabel(scan.created_at)}</small></div><span className="scan-total">{total} <small>items</small><span>{Object.keys(labels).join(', ') || 'detections'}</span></span></article>; })}</div> : <div className="empty-state compact"><span>◷</span><p>No scan history</p><small>Completed scans will appear here.</small></div>}</section>
        {details?.recent_item_events && <section className="panel-section history-section"><div className="section-title"><h3>Recent item decisions</h3><span>CAPACITY LOG</span></div>{details.recent_item_events.length ? <div className="scan-list">{details.recent_item_events.map(event => <article className="scan-row" key={event.id}><span className="scan-icon">{event.acceptance_status === 'accepted' ? '✓' : event.acceptance_status === 'rejected' ? '×' : '?'}</span><div className="scan-copy"><strong>{event.detection_label} · {event.acceptance_status.replace('_',' ')}</strong><small>{dateLabel(event.created_at)}</small><small>{event.reason}</small></div><span className="scan-total">{event.estimated_volume_liters === null ? '—' : `${Number(event.estimated_volume_liters).toFixed(1)} L`}</span></article>)}</div> : <div className="empty-state compact"><span>◷</span><p>No accepted items</p><small>Confirmed bin decisions will appear here.</small></div>}</section>}
        <InterpretationPanel scanId={latestScanId} interpretation={interpretation} busy={interpretBusy} error={interpretError} onInterpret={() => void runInterpretation()}/>
        <div className="last-scan"><span>Latest scan</span><strong>{dateLabel(details?.last_scan_at)}</strong></div>
      </>}
      <footer className="panel-footer"><span className="connection-text"><i/>{backend === 'connected' ? 'Connected to campus backend' : 'Waiting for backend'}</span><span>ReBin <b>·</b> {id}</span></footer>
    </aside>

    <button className="assistant-fab" onClick={() => setAssistant(value => !value)} aria-label={assistant ? 'Close recycling assistant' : 'Open recycling assistant'}>{assistant ? <X size={21}/> : <MessageCircle size={21}/>}</button>
    {assistant && <section className="assistant-panel"><header><span className="assistant-avatar"><Leaf size={16}/></span><div><strong>ReBin AI</strong><small>Database-aware recycling guide</small></div><button className="new-chat-button" onClick={() => void startConversation(true)} title="Start a new conversation" aria-label="Start a new conversation"><Plus size={16}/></button><button onClick={() => setAssistant(false)} aria-label="Close assistant"><X size={17}/></button></header>
      <div className="chat-log">{conversationLoading ? <div className="chat-loading"><span className="loading-ring"/>Loading saved conversation…</div> : chatMessages.length === 0 ? <div className="chat-welcome">Ask about {info.name} scan history, detections, or recycling guidance. Answers use current database context.</div> : chatMessages.map((item, index) => <div className={`chat-entry ${item.role}`} key={item.id || index}><div className={`chat-bubble ${item.role}`}>{item.content}</div>{item.sources?.length ? <small className="chat-sources">Sources: {item.sources.slice(0, 3).map(source => source.scan_id.slice(0, 8)).join(', ')}</small> : null}</div>)}
        {chatBusy && <div className="chat-bubble assistant typing">Checking this bin’s records…</div>}{chatError && <div className="chat-error" role="alert">{chatError}</div>}
      </div>
      <form onSubmit={send} className="chat-form"><input value={draft} onChange={event => setDraft(event.target.value)} placeholder="Ask about this bin…" maxLength={2000} disabled={conversationLoading || chatBusy}/><button aria-label="Send message" type="submit" disabled={conversationLoading || chatBusy || !draft.trim()}><Send size={15}/></button></form>
      <p className="assistant-note">Chat history is saved on the backend. No sign-in is enabled; anyone with its conversation ID can access it.</p>
    </section>}
    {capture && <CameraCapture binId={id} onComplete={() => void load()} onClose={() => setCapture(false)} onInterpretation={setInterpretation}/>}
  </main>;
}
