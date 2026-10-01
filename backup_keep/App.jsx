import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  FileText, Image as ImageIcon, Headphones, Plus, X, Send,
  ArrowUpRight, Settings as SettingsIcon, Paperclip, FileSpreadsheet,
  AlertCircle, ChevronRight, FolderOpen, MessageSquare, Trash2,
  Home, PanelLeftClose, PanelLeft, User, Moon, Sun
} from 'lucide-react';

import { LogOut } from 'lucide-react';
import { auth, login, logout } from './firebase';
import { onAuthStateChanged } from 'firebase/auth';
import GlowCursor from './GlowCursor';

const API = 'http://127.0.0.1:8000';

// Ponytail trick: intercept fetch to attach token without rewriting 50 lines of React
let currentToken = null;
const originalFetch = window.fetch;
window.fetch = async (...args) => {
  if (typeof args[0] === 'string' && args[0].startsWith(API) && currentToken) {
    args[1] = args[1] || {};
    args[1].headers = args[1].headers || {};
    args[1].headers['Authorization'] = `Bearer ${currentToken}`;
  }
  return originalFetch(...args);
};

/* ── helpers ─────────────────────────────────────────────── */

const fIcon = (n) => {
  if (!n) return FileText;
  const e = n.split('.').pop().toLowerCase();
  if ('png jpg jpeg webp bmp tiff tif'.split(' ').includes(e)) return ImageIcon;
  if ('wav mp3 m4a flac ogg'.split(' ').includes(e)) return Headphones;
  if (e === 'csv') return FileSpreadsheet;
  return FileText;
};

const fSize = (b) => {
  if (!b) return '';
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(0) + ' KB';
  return (b / 1048576).toFixed(1) + ' MB';
};

const locLabel = (c) => {
  if (c.location?.page_number) return 'p.' + c.location.page_number;
  if (c.location?.section) return c.location.section;
  if (c.location?.timestamp_start != null) {
    const f = (s) => `${String(Math.floor(Math.round(s)/60)).padStart(2,'0')}:${String(Math.round(s)%60).padStart(2,'0')}`;
    return f(c.location.timestamp_start) + '–' + f(c.location.timestamp_end);
  }
  return '';
};

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

const chatTitle = (msgs) => {
  const u = msgs.find(m => m.role === 'user');
  if (!u) return 'New Chat';
  const t = u.text || '';
  return t.length > 36 ? t.slice(0, 36) + '…' : t || 'New Chat';
};

/* ── logo ────────────────────────────────────────────────── */

function Logo({ size = 16, light = false }) {
  return (
    <img src="/logo.jpg" alt="DocLink Logo" style={{ width: size, height: size, objectFit: 'contain', borderRadius: '4px', background: 'white' }} />
  );
}

function LogoWide({ height = 24 }) {
  return (
    <img src="/logo-wide.png" alt="DocLink Logo" className="logo-wide" style={{ height: height, width: 'auto', objectFit: 'contain' }} />
  );
}

/* ── App ─────────────────────────────────────────────────── */

export default function App() {
  const [user, setUser] = useState(null);
  const [authChecking, setAuthChecking] = useState(true);
  const [theme, setTheme] = useState(() => localStorage.getItem('dl_theme') || 'dark');

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('dl_theme', theme);
  }, [theme]);

  useEffect(() => {
    return onAuthStateChanged(auth, async (u) => {
      setUser(u);
      if (u) {
        currentToken = await u.getIdToken();
      } else {
        currentToken = null;
      }
      setAuthChecking(false);
    });
  }, []);

  if (authChecking) return <div className="shell center">Loading...</div>;

  if (!user) {
    window.location.href = '/landing.html';
    return null;
  }

  return (
    <div style={{ position: 'relative', width: '100%', height: '100vh' }}>
      <GlowCursor
        color="#67E8F9"
        secondaryColor="#A78BFA"
        trailLength={40}
        trailWidth={8}
        trailTaper={0.8}
        followSpeed={0.16}
        glowIntensity={1.9}
        glowSpread={1.2}
        hotspot={0.65}
        brightness={1.25}
        opacity={1}
        pulseSpeed={1.1}
        noiseStrength={0.035}
        idleFade
        idleTimeout={700}
        fadeDuration={900}
        maxDevicePixelRatio={1} /* Reduced for performance optimization */
        blendMode={theme === 'light' ? 'normal' : 'screen'}
      >
        <MainApp user={user} theme={theme} setTheme={setTheme} />
      </GlowCursor>
    </div>
  );
}

function MainApp({ user, theme, setTheme }) {
  const [page, setPage] = useState('chat');
  const [sessions, setSessions] = useState(() => {
    try { return JSON.parse(localStorage.getItem('dl_sessions') || '[]'); } catch { return []; }
  });
  const [activeId, setActiveId] = useState(() => localStorage.getItem('dl_active') || null);
  const [sources, setSources] = useState([]);
  const [srcFilter, setSrcFilter] = useState('');
  const [citation, setCitation] = useState(null);
  const [health, setHealth] = useState(null);
  const [dragging, setDragging] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [backend, setBackend] = useState('online');
  const [topK, setTopK] = useState(10);
  const [rerankK, setRerankK] = useState(5);
  useEffect(() => { localStorage.setItem('dl_sessions', JSON.stringify(sessions)); }, [sessions]);
  useEffect(() => { if (activeId) localStorage.setItem('dl_active', activeId); }, [activeId]);
  
  const active = sessions.find(s => s.id === activeId);
  const msgs = active?.messages || [];

  const setMsgs = (fn) => {
    setSessions(prev => prev.map(s => s.id !== activeId ? s : { ...s, messages: typeof fn === 'function' ? fn(s.messages) : fn }));
  };

  const newChat = () => {
    const s = { id: uid(), messages: [], ts: Date.now() };
    setSessions(prev => [s, ...prev]);
    setActiveId(s.id);
    setPage('chat');
    setCitation(null);
  };

  const delChat = (id) => {
    setSessions(prev => prev.filter(s => s.id !== id));
    if (activeId === id) setActiveId(sessions.filter(s => s.id !== id)[0]?.id || null);
  };

  const pickChat = (id) => { setActiveId(id); setPage('chat'); setCitation(null); };

  const ensure = () => {
    if (!activeId || !sessions.find(s => s.id === activeId)) newChat();
  };

  useEffect(() => { fetchSources(); fetchHealth(); }, []);

  const fetchHealth = async () => {
    try { setHealth(await (await fetch(`${API}/health?backend=${backend}`)).json()); } catch {}
  };
  const fetchSources = async () => {
    try { setSources((await (await fetch(`${API}/sources`)).json()).sources || []); } catch {}
  };

  useEffect(() => {
    const dOver = (e) => { e.preventDefault(); setDragging(true); };
    const dLeave = (e) => { if (!e.relatedTarget) setDragging(false); };
    const dDrop = (e) => { e.preventDefault(); setDragging(false); };
    window.addEventListener('dragover', dOver);
    window.addEventListener('dragleave', dLeave);
    window.addEventListener('drop', dDrop);
    return () => { window.removeEventListener('dragover', dOver); window.removeEventListener('dragleave', dLeave); window.removeEventListener('drop', dDrop); };
  }, []);

  return (
    <div className="shell">
      <aside className={`sidebar ${sidebarOpen ? '' : 'collapsed'}`}>
        <div className="sb-brand">
          <LogoWide height={24} />
        </div>

        <button className="sb-new" onClick={newChat}><Plus size={15}/>New Chat</button>

        <nav className="sb-nav">
          <button className={`sb-nav-item ${page === 'chat' ? 'active' : ''}`} onClick={() => setPage('chat')}>
            <Home size={15}/> Home
          </button>
          <button className={`sb-nav-item ${page === 'sources' ? 'active' : ''}`} onClick={() => setPage('sources')}>
            <FolderOpen size={15}/> Sources
          </button>
          <button className={`sb-nav-item ${page === 'settings' ? 'active' : ''}`} onClick={() => setPage('settings')}>
            <SettingsIcon size={15}/> Settings
          </button>
        </nav>

        {sessions.length > 0 && (
          <>
            <div className="sb-divider"/>
            <div className="sb-label">Recent</div>
            <div className="sb-chats">
              {sessions.map(s => (
                <div key={s.id} className={`sb-chat ${s.id === activeId ? 'active' : ''}`} onClick={() => pickChat(s.id)}>
                  <MessageSquare size={14} style={{ opacity: 0.4, flexShrink: 0 }}/>
                  <span className="sb-chat-name">{chatTitle(s.messages)}</span>
                  <button className="sb-chat-del" onClick={(e) => { e.stopPropagation(); delChat(s.id); }}><Trash2 size={12}/></button>
                </div>
              ))}
            </div>
          </>
        )}

        <div style={{ flex: 1 }}/>
        <div className="sb-footer">
          <div className="sb-user">
            <img src={user.photoURL} alt="Avatar" className="sb-avatar" style={{ padding: 0, overflow: 'hidden' }} />
            <span className="sb-user-name" title={user.email}>{user.displayName || 'User'}</span>
          </div>
          <button className="sb-theme-toggle" onClick={logout} title="Sign Out" style={{ marginRight: 8 }}>
            <LogOut size={15}/>
          </button>
          <button className="sb-theme-toggle" onClick={() => setTheme(t => t === 'light' ? 'dark' : 'light')} title="Toggle theme">
            {theme === 'light' ? <Moon size={15}/> : <Sun size={15}/>}
          </button>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <div className="topbar-left">
            <button className="topbar-toggle" onClick={() => setSidebarOpen(v => !v)} title="Toggle sidebar">
              {sidebarOpen ? <PanelLeftClose size={18}/> : <PanelLeft size={18}/>}
            </button>
            {active && page === 'chat' && <span className="topbar-title">{chatTitle(active.messages)}</span>}
          </div>
          <div className="topbar-right">
            <button className={`topbar-btn ${page === 'sources' ? 'active' : ''}`} onClick={() => setPage('sources')}>Sources</button>
            <button className={`topbar-btn ${page === 'settings' ? 'active' : ''}`} onClick={() => setPage('settings')}>Settings</button>
          </div>
        </header>

        {page === 'chat' && (
          <ChatView
            msgs={msgs} setMsgs={setMsgs} sources={sources}
            cite={citation} setCite={setCitation}
            backend={backend} topK={topK} rerankK={rerankK}
            fetchSources={fetchSources} dragging={dragging}
            setDragging={setDragging} ensure={ensure}
          />
        )}
        {page === 'sources' && <SourcesPage sources={sources} filter={srcFilter} setFilter={setSrcFilter} fetchSources={fetchSources}/>}
        {page === 'settings' && <SettingsPage backend={backend} setBackend={setBackend} topK={topK} setTopK={setTopK} rerankK={rerankK} setRerankK={setRerankK} health={health} fetchHealth={fetchHealth}/>}
      </div>

      {citation && <SourcePanel cite={citation} onClose={() => setCitation(null)}/>}
      {dragging && <div className="drag-over"><div className="drag-over-label">Drop files to upload</div></div>}
    </div>
  );
}

/* ── Progress ──────────────────────────────────────────────── */

function ProgressRow({ type }) {
  const [p, setP] = useState(0);
  useEffect(() => {
    const i = setInterval(() => {
      setP(v => {
        const next = v + Math.random() * 12 + 3;
        return next > 95 ? 95 : next;
      });
    }, 600);
    return () => clearInterval(i);
  }, []);
  
  let msg = '';
  if (type === 'ingest') {
    if (p < 20) msg = 'Uploading files...';
    else if (p < 50) msg = 'Extracting document text...';
    else if (p < 80) msg = 'Generating embeddings...';
    else msg = 'Indexing into vector store...';
  } else {
    if (p < 30) msg = 'Analyzing query...';
    else if (p < 60) msg = 'Searching knowledge base...';
    else if (p < 85) msg = 'Reranking results...';
    else msg = 'Generating grounded response...';
  }
  
  return (
    <div className="prog-row">
      <div className="prog-text"><span>{msg}</span><span className="prog-perc">{Math.floor(p)}%</span></div>
      <div className="prog-bar-bg"><div className="prog-bar-fill" style={{ width: p + '%' }}/></div>
    </div>
  );
}

/* ── ChatView ────────────────────────────────────────────── */

function ChatView({ msgs, setMsgs, sources, cite, setCite, backend, topK, rerankK, fetchSources, dragging, setDragging, ensure }) {
  const [text, setText] = useState('');
  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(false);
  const [ingesting, setIngesting] = useState(false);
  const [err, setErr] = useState(null);
  const endRef = useRef(null);
  const fileRef = useRef(null);
  const taRef = useRef(null);

  const has = msgs.length > 0;

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [msgs, loading]);
  useEffect(() => { const t = taRef.current; if (t) { t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 160) + 'px'; } }, [text]);

  const send = async () => {
    const q = text.trim();
    if (!q && !files.length) return;
    ensure();
    const uMsg = { role: 'user', text: q || 'Analyze these files.', files: files.map(f => f.name) };
    await new Promise(r => setTimeout(r, 30));
    setMsgs(p => [...p, uMsg]);
    setText('');
    setLoading(true);
    setErr(null);

    if (files.length) {
      setIngesting(true);
      try {
        const fd = new FormData();
        files.forEach(f => fd.append('files', f));
        await fetch(`${API}/ingest`, { method: 'POST', body: fd });
        await fetchSources();
      } catch {}
      setIngesting(false);
    }

    try {
      const res = await fetch(`${API}/query?backend=${backend}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: q || 'Summarize the uploaded files.', top_k: +topK, rerank_top_k: +rerankK, inference_mode: 'local', query_modality: 'text' }),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const d = await res.json();
      setMsgs(p => [...p, { role: 'ai', text: d.answer, citations: d.citations || [], abstained: d.abstained, confidence: d.confidence }]);
    } catch (e) {
      setErr(e.message);
      setMsgs(p => [...p, { role: 'ai', text: 'Something went wrong. Please try again.', error: true }]);
    } finally { setLoading(false); setFiles([]); }
  };

  const keyDown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } };
  const addFiles = (e) => { setFiles(p => [...p, ...Array.from(e.target.files)]); e.target.value = ''; };
  const rmFile = (i) => setFiles(p => p.filter((_, j) => j !== i));
  const drop = useCallback((e) => { e.preventDefault(); setDragging(false); setFiles(p => [...p, ...Array.from(e.dataTransfer.files)]); }, [setDragging]);

  const suggestions = ['Summarize all documents', 'What are the key findings?', 'What risks are mentioned?', 'Compare these documents', 'Find important numbers'];

  return (
    <>
      <div className="chat-scroll" onDrop={drop} onDragOver={e => e.preventDefault()}>
        {!has ? (
          <div className="home">
            <div style={{ marginBottom: 24 }}>
              <LogoWide height={56} />
            </div>
            <h1 className="home-h1">Unlock insights from your <span className="highlight">documents.</span></h1>

            <div className="comp-wrap center">
              <Comp text={text} setText={setText} files={files} addFiles={addFiles} rmFile={rmFile} send={send} keyDown={keyDown} loading={loading} taRef={taRef} fileRef={fileRef}/>
            </div>

            <div className="home-suggestions">
              {suggestions.map((s, i) => (
                <button key={i} className="home-sug" onClick={() => { setText(s); taRef.current?.focus(); }}>{s}</button>
              ))}
            </div>
          </div>
        ) : (
          <div className="msgs">
            {msgs.map((m, i) => <Msg key={i} m={m} onCite={setCite}/>)}
            {loading && (
              <div className="msg msg-ai">
                <div className="msg-ai-head">
                  <div className="msg-ai-avatar"><Logo size={12} light/></div>
                  <div className="msg-ai-name">DocLink</div>
                </div>
                {ingesting && <ProgressRow type="ingest" />}
                {!ingesting && <ProgressRow type="query" />}
              </div>
            )}
            {err && !loading && <div className="msg-ai-err"><AlertCircle size={14} style={{ flexShrink: 0, marginTop: 1 }}/>{err}</div>}
            <div ref={endRef}/>
          </div>
        )}
      </div>

      {has && (
        <div className="comp-wrap">
          <Comp text={text} setText={setText} files={files} addFiles={addFiles} rmFile={rmFile} send={send} keyDown={keyDown} loading={loading} taRef={taRef} fileRef={fileRef}/>
        </div>
      )}
    </>
  );
}

/* ── Composer ────────────────────────────────────────────── */

function Comp({ text, setText, files, addFiles, rmFile, send, keyDown, loading, taRef, fileRef }) {
  return (
    <div className="comp">
      {files.length > 0 && (
        <div className="comp-files">
          {files.map((f, i) => {
            const Ic = fIcon(f.name);
            return <div key={i} className="comp-file"><Ic size={12}/>{f.name}<button className="comp-file-x" onClick={() => rmFile(i)}><X size={11}/></button></div>;
          })}
        </div>
      )}
      <div className="comp-row">
        <input ref={fileRef} type="file" multiple onChange={addFiles} style={{ display: 'none' }} accept=".pdf,.doc,.docx,.txt,.csv,.png,.jpg,.jpeg,.webp,.bmp,.tiff,.tif,.wav,.mp3,.m4a,.flac,.ogg"/>
        <button className="comp-attach" onClick={() => fileRef.current?.click()} title="Attach files"><Paperclip size={17}/></button>
        <textarea ref={taRef} className="comp-input" rows={1} placeholder="Ask anything about your documents…" value={text} onChange={e => setText(e.target.value)} onKeyDown={keyDown}/>
        <button className="comp-send" onClick={send} disabled={loading || (!text.trim() && !files.length)} title="Send"><Send size={15}/></button>
      </div>
    </div>
  );
}

/* ── Message ─────────────────────────────────────────────── */

function Msg({ m, onCite }) {
  if (m.role === 'user') {
    return (
      <div className="msg msg-user">
        {m.files?.length > 0 && <div className="msg-user-files">{m.files.map((f, i) => { const I = fIcon(f); return <div key={i} className="msg-file"><I size={11}/>{f}</div>; })}</div>}
        <div className="msg-user-text">{m.text}</div>
      </div>
    );
  }
  return (
    <div className="msg msg-ai">
      <div className="msg-ai-head">
        <div className="msg-ai-avatar"><Logo size={12} light/></div>
        <div className="msg-ai-name">DocLink</div>
      </div>
      {m.abstained ? (
        <div className="msg-ai-warn"><AlertCircle size={15} style={{ flexShrink: 0, marginTop: 2 }}/><span>{m.text}</span></div>
      ) : m.error ? (
        <div className="msg-ai-err"><AlertCircle size={14} style={{ flexShrink: 0, marginTop: 1 }}/>{m.text}</div>
      ) : (
        <div className="msg-ai-body">{m.text}</div>
      )}
      {m.citations?.length > 0 && (
        <div className="cites">
          <div className="cites-label">Sources</div>
          <div className="cites-list">
            {m.citations.map((c, i) => (
              <div key={i} className="cite" onClick={() => onCite(c)}>
                <div className="cite-n">{c.citation_id || i + 1}</div>
                <span className="cite-name">{c.filename}</span>
                {locLabel(c) && <span className="cite-loc">· {locLabel(c)}</span>}
                {c.excerpt && <span className="cite-ex">— {c.excerpt}</span>}
                <ChevronRight size={13} className="cite-arrow"/>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Source Panel ─────────────────────────────────────────── */

function SourcePanel({ cite, onClose }) {
  return (
    <aside className="srcpanel">
      <div className="srcpanel-head">
        <div style={{ overflow: 'hidden' }}>
          <div className="srcpanel-title">{cite.filename}</div>
          {locLabel(cite) && <div className="srcpanel-loc">{locLabel(cite)}</div>}
        </div>
        <button className="srcpanel-close" onClick={onClose}><X size={16}/></button>
      </div>
      <div className="srcpanel-body">
        {cite.modality === 'image' && <img className="srcpanel-img" src={`${API}/source/${cite.source_id}/file`} alt={cite.filename}/>}
        {cite.modality === 'audio' && <audio style={{ width: '100%', marginBottom: 12 }} controls src={`${API}/source/${cite.source_id}/file`}/>}
        {cite.excerpt && <div className="srcpanel-excerpt" style={{ marginTop: cite.modality !== 'text' ? 14 : 0 }}>{cite.excerpt}</div>}
        <div style={{ marginTop: 16 }}>
          <a href={`${API}/source/${cite.source_id}/file`} target="_blank" rel="noreferrer" className="btn-outline"><ArrowUpRight size={13}/>Open original</a>
        </div>
      </div>
    </aside>
  );
}

/* ── Sources Page ────────────────────────────────────────── */

function SourcesPage({ sources, filter, setFilter, fetchSources }) {
  const ref = useRef(null);
  const [ing, setIng] = useState(false);

  const ingest = async (e) => {
    const fs = Array.from(e.target.files);
    if (!fs.length) return;
    setIng(true);
    const fd = new FormData();
    fs.forEach(f => fd.append('files', f));
    try { await fetch(`${API}/ingest`, { method: 'POST', body: fd }); await fetchSources(); } catch {}
    setIng(false);
    e.target.value = '';
  };

  const filtered = sources.filter(s => s.filename.toLowerCase().includes(filter.toLowerCase()));

  return (
    <div className="page-sources">
      <div className="page-head">
        <h1 className="page-title">Sources</h1>
        <input ref={ref} type="file" multiple onChange={ingest} style={{ display: 'none' }} accept=".pdf,.doc,.docx,.txt,.csv,.png,.jpg,.jpeg,.webp,.bmp,.tiff,.tif,.wav,.mp3,.m4a,.flac,.ogg"/>
        <button className="btn-primary" onClick={() => ref.current?.click()}><Plus size={14}/>Add files</button>
      </div>

      {ing && <div className="ingest-bar" style={{ marginLeft: 0, marginBottom: 12 }}><div className="ingest-spinner"/>Processing files…</div>}

      <input className="search-input" placeholder="Search sources…" value={filter} onChange={e => setFilter(e.target.value)}/>

      {filtered.length === 0 ? (
        <div className="empty">
          <FolderOpen size={40} className="empty-icon"/>
          <div className="empty-text">{sources.length === 0 ? 'No files indexed yet. Upload documents to get started.' : 'No sources match your search.'}</div>
        </div>
      ) : (
        <div className="src-list">
          {filtered.map((s, i) => {
            const Ic = fIcon(s.filename);
            return (
              <div key={i} className="src-row">
                <div className="src-icon"><Ic size={16}/></div>
                <div className="src-info">
                  <div className="src-name">{s.filename}</div>
                  <div className="src-meta"><span>{s.source_type?.toUpperCase()}</span>{s.file_size && <span>{fSize(s.file_size)}</span>}</div>
                </div>
                <span className="src-status">Indexed</span>
                <a href={`${API}/source/${s.source_id}/file`} target="_blank" rel="noreferrer" className="src-dl" title="Open"><ArrowUpRight size={14}/></a>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ── Settings Page ───────────────────────────────────────── */

function SettingsPage({ backend, setBackend, topK, setTopK, rerankK, setRerankK, health, fetchHealth }) {
  const ready = health?.inference?.ready;
  return (
    <div className="page-settings">
      <h1 className="page-title" style={{ marginBottom: 28 }}>Settings</h1>

      <div className="set-section">
        <div className="set-section-title">AI Model</div>
        <div className="set-row">
          <div><div className="set-label">Inference backend</div><div className="set-desc">Local Ollama or cloud API</div></div>
          <select className="set-select" value={backend} onChange={e => { setBackend(e.target.value); setTimeout(fetchHealth, 500); }}>
            <option value="offline">Offline (Ollama)</option>
            <option value="online">Online (Cloud API)</option>
          </select>
        </div>
        <div className="set-row">
          <div><div className="set-label">Status</div><div className="set-desc">{health?.inference?.message || ''}</div></div>
          <div className="set-status" style={{ color: ready ? 'var(--green)' : 'var(--red)' }}>
            <span className="set-dot" style={{ background: ready ? 'var(--green)' : 'var(--red)' }}/>
            {ready ? 'Ready' : 'Not ready'}
          </div>
        </div>
        {health?.inference?.model && (
          <div className="set-row">
            <div className="set-label">Model</div>
            <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{health.inference.model}</span>
          </div>
        )}
      </div>

      <div className="set-section">
        <div className="set-section-title">Retrieval</div>
        <div className="set-row">
          <div><div className="set-label">Retrieve top K</div><div className="set-desc">Chunks to retrieve from the index</div></div>
          <input className="set-num" type="number" min={1} max={50} value={topK} onChange={e => setTopK(+e.target.value)}/>
        </div>
        <div className="set-row">
          <div><div className="set-label">Rerank top K</div><div className="set-desc">Chunks after cross-encoder reranking</div></div>
          <input className="set-num" type="number" min={1} max={25} value={rerankK} onChange={e => setRerankK(+e.target.value)}/>
        </div>
      </div>

      <div className="set-section">
        <div className="set-section-title">System</div>
        {health?.models && (
          <>
            <div className="set-row"><div className="set-label">Embedding</div><span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{health.models.embedding}</span></div>
            <div className="set-row"><div className="set-label">Reranker</div><span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{health.models.reranker}</span></div>
            <div className="set-row"><div className="set-label">Whisper</div><span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{health.models.whisper}</span></div>
          </>
        )}
        <div className="set-row">
          <div className="set-label">Tesseract OCR</div>
          <div className="set-status" style={{ color: health?.tesseract?.available ? 'var(--green)' : 'var(--red)' }}>
            <span className="set-dot" style={{ background: health?.tesseract?.available ? 'var(--green)' : 'var(--red)' }}/>
            {health?.tesseract?.available ? 'Available' : 'Missing'}
          </div>
        </div>
        {health?.index && (
          <div className="set-row">
            <div className="set-label">Index</div>
            <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{health.index.sources} sources · {health.index.items} items</span>
          </div>
        )}
      </div>
    </div>
  );
}
