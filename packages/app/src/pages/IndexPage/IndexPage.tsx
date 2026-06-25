import { useState, useEffect, useRef, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useSession } from '../../context/SessionContext.tsx';
import { api } from '../../api/client.ts';
import type { RequestMode } from '@karaoke-browser/shared';
import './IndexPage.css';

type View = 'login' | 'create' | 'links';

const SAFE_PREFIXES = ['/controller', '/player', '/request'];
function isSafeRedirect(url: string | null): url is string {
  return typeof url === 'string' && SAFE_PREFIXES.some(p => url.startsWith(p));
}

async function sha256hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export default function IndexPage() {
  useEffect(() => {
    document.title = 'Karaoke Browser';
    const icon = document.querySelector<HTMLLinkElement>("link[rel='icon']");
    if (icon) icon.href = `data:image/svg+xml,${encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🎤</text></svg>")}`;
  }, []);

  const { sessionId, setSessionId, authStatus, refreshAuth } = useSession();
  const [searchParams] = useSearchParams();
  const redirectTarget = searchParams.get('redirect');

  const [view, setView]               = useState<View>('create');
  const [authMode, setAuthMode]       = useState(false);
  const [loginError, setLoginError]   = useState(false);
  const [createError, setCreateError] = useState(false);
  const [creating, setCreating]       = useState(false);
  const [requestMode, setRequestMode] = useState<RequestMode>('kiosk');
  const [requestQr, setRequestQr]     = useState<string | null>(null);
  const [displayQr, setDisplayQr]     = useState<string | null>(null);
  const [showRequestQrModal, setShowRequestQrModal] = useState(false);
  const [showDisplayQrModal, setShowDisplayQrModal] = useState(false);
  const [password, setPassword]       = useState('');
  const [copyReqText, setCopyReqText] = useState('Copy');
  const [copyDispText, setCopyDispText] = useState('Copy');
  const [copySdUrlText, setCopySdUrlText] = useState('Copy');
  const [copySdSidText, setCopySdSidText] = useState('Copy');
  const [sdOpen, setSdOpen]           = useState(false);

  const wsRef      = useRef<WebSocket | null>(null);
  const wsTimer    = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Computed URLs ───────────────────────────────────────────────────────
  const requestUrl = sessionId ? `${location.origin}/request?s=${encodeURIComponent(sessionId)}` : '';
  const displayUrl = sessionId ? `${location.origin}/display?s=${encodeURIComponent(sessionId)}` : '';

  // ── Ingress WebSocket (mode sync) ────────────────────────────────────────
  const connectIngressWs = useCallback((sid: string) => {
    if (wsRef.current) wsRef.current.close();
    if (wsTimer.current) clearTimeout(wsTimer.current);
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/ws?role=ingress&s=${encodeURIComponent(sid)}`);
    wsRef.current = ws;
    ws.onmessage = (ev: MessageEvent<string>) => {
      try {
        const msg = JSON.parse(ev.data) as { type: string; requestMode?: RequestMode };
        if (msg.type === 'state' && msg.requestMode) setRequestMode(msg.requestMode);
      } catch { /* ignore */ }
    };
    ws.onclose = () => { wsTimer.current = setTimeout(() => connectIngressWs(sid), 3000); };
  }, []);

  useEffect(() => {
    return () => {
      wsRef.current?.close();
      if (wsTimer.current) clearTimeout(wsTimer.current);
    };
  }, []);

  // ── QR fetching ──────────────────────────────────────────────────────────
  const fetchRequestQr = useCallback(async (sid: string, reqUrl: string) => {
    try {
      const { dataUrl } = await api.getQr(sid, reqUrl);
      if (dataUrl) setRequestQr(dataUrl);
    } catch { /* optional */ }
  }, []);

  const fetchDisplayQr = useCallback(async (sid: string, dispUrl: string) => {
    try {
      const { dataUrl } = await api.getQr(sid, dispUrl);
      if (dataUrl) setDisplayQr(dataUrl);
    } catch { /* optional */ }
  }, []);

  // ── Show links view ──────────────────────────────────────────────────────
  const showLinks = useCallback((sid: string, mode: RequestMode, isAuthMode: boolean) => {
    setView('links');
    setAuthMode(isAuthMode);
    setRequestMode(mode);
    connectIngressWs(sid);
    const rUrl = `${location.origin}/request?s=${encodeURIComponent(sid)}`;
    void fetchRequestQr(sid, rUrl);
    if (mode === 'crowd') void fetchDisplayQr(sid, `${location.origin}/display?s=${encodeURIComponent(sid)}`);
  }, [connectIngressWs, fetchRequestQr, fetchDisplayQr]);

  // ── Boot ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!authStatus) return;
    const { authRequired, authed } = authStatus;
    setAuthMode(authRequired);

    if (authRequired && !authed) {
      setView('login');
      return;
    }

    // Try to restore an existing session from localStorage
    const storedId = sessionId;
    if (storedId) {
      api.getSession(storedId)
        .then(({ sessionId: sid, requestMode: mode }) => {
          showLinks(sid, mode, authRequired);
        })
        .catch(() => {
          setSessionId(null);
          setView('create');
        });
    } else {
      setView('create');
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authStatus]);

  // ── Update display QR when mode switches to crowd ────────────────────────
  useEffect(() => {
    if (view === 'links' && sessionId && requestMode === 'crowd' && !displayQr) {
      void fetchDisplayQr(sessionId, displayUrl);
    }
  }, [view, sessionId, requestMode, displayQr, displayUrl, fetchDisplayQr]);

  // ── Login submit ─────────────────────────────────────────────────────────
  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password.trim()) return;
    try {
      const hash = await sha256hex(password.trim());
      const { ok } = await api.login(hash);
      if (ok) {
        await refreshAuth();
        setView('create');
        setPassword('');
      } else {
        setLoginError(true);
      }
    } catch {
      setLoginError(true);
    }
  };

  // ── Create session ───────────────────────────────────────────────────────
  const handleCreate = async () => {
    setCreating(true);
    setCreateError(false);
    try {
      const { sessionId: sid, requestMode: mode } = await api.createSession();
      setSessionId(sid);
      if (isSafeRedirect(redirectTarget)) {
        location.replace(redirectTarget);
      } else {
        showLinks(sid, mode as RequestMode, authMode);
      }
    } catch {
      setCreateError(true);
    } finally {
      setCreating(false);
    }
  };

  // ── Open controller / player in new tab ──────────────────────────────────
  const openController = () => { if (sessionId) window.open('/controller', '_blank'); };
  const openPlayer     = () => { if (sessionId) window.open('/player', '_blank'); };

  // ── Mode toggle ──────────────────────────────────────────────────────────
  const toggleMode = async () => {
    if (!sessionId) return;
    const newMode: RequestMode = requestMode === 'crowd' ? 'kiosk' : 'crowd';
    try {
      await api.setSessionMode(sessionId, newMode);
      setRequestMode(newMode);
      if (newMode !== 'crowd') setDisplayQr(null);
    } catch { /* ignore */ }
  };

  // ── Logout / new room ────────────────────────────────────────────────────
  const handleLogout = async () => {
    setSessionId(null);
    wsRef.current?.close();
    await api.logout().catch(() => {});
    setView('login');
    setPassword('');
  };

  const handleNewRoom = () => {
    setSessionId(null);
    wsRef.current?.close();
    setView('create');
  };

  // ── Copy helpers ─────────────────────────────────────────────────────────
  const copyToClipboard = async (text: string, setter: (s: string) => void) => {
    try {
      await navigator.clipboard.writeText(text);
      setter('Copied ✓');
      setTimeout(() => setter('Copy'), 2000);
    } catch { /* ignore */ }
  };

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <>
      <div className="page">

        <header>
          <div className="logo">🎤</div>
          <h1>Karaoke Browser</h1>
          <p className="subtitle">Your karaoke night command center</p>
        </header>

        {/* ── Login (AUTH_TOKEN mode) ── */}
        {view === 'login' && (
          <div id="login-section" className="card">
            <h2>This Karaoke Room is Password Protected</h2>
            <p className="hint">Enter the password to access the player and controller.</p>
            <form id="token-form" autoComplete="off" onSubmit={handleLogin}>
              <input
                id="token-input"
                type="password"
                placeholder="Enter password…"
                autoComplete="off"
                spellCheck={false}
                autoFocus
                value={password}
                onChange={e => { setPassword(e.target.value); setLoginError(false); }}
              />
              <button type="submit" className="btn-primary">Log In</button>
            </form>
            <div id="token-error" className="error" hidden={!loginError}>Invalid password — please try again.</div>
          </div>
        )}

        {/* ── Create a new room ── */}
        {view === 'create' && (
          <div id="create-section" className="card">
            <button id="create-btn" className="btn-primary" onClick={handleCreate} disabled={creating}>
              {creating ? 'Setting up…' : 'Start Karaoke Night'}
            </button>
            <div id="create-error" className="error" hidden={!createError}>Could not create room — please try again.</div>
          </div>
        )}

        {/* ── Room links ── */}
        {view === 'links' && sessionId && (
          <div id="room-links">
            <div className="links-grid">
              <button id="controller-btn" className="link-card" onClick={openController}>
                <div className="link-icon">🎤</div>
                <div className="link-title">Controller</div>
                <div className="link-desc">Add songs, manage the queue, and control playback</div>
              </button>
              <button id="player-btn" className="link-card" onClick={openPlayer}>
                <div className="link-icon">📺</div>
                <div className="link-title">Player</div>
                <div className="link-desc">Fullscreen video player — display on screen or capture in OBS</div>
              </button>
            </div>

            <h3 className="section-label">Requests</h3>
            <div id="request-link-row" className="request-link-row">
              <div className="request-link-header">
                <div className="request-link-label" id="request-link-label">
                  {requestMode === 'kiosk'
                    ? '🔗 Use this link to open the song request form'
                    : '🔗 Share this link so guests can request songs'}
                </div>
                <button
                  id="req-mode-toggle"
                  className="mode-toggle"
                  data-mode={requestMode}
                  onClick={toggleMode}
                  title={'Kiosk: unlimited requests per device\nCrowd: one request per device until processed'}
                >
                  <span className="mode-track"></span>
                  <span className="mode-option">🏠 Kiosk</span>
                  <span className="mode-option">📱 Crowd</span>
                </button>
              </div>
              <div className="request-link-controls">
                <input id="request-url" type="text" readOnly className="request-url-input" value={requestUrl} />
                <button id="copy-request-btn" className="btn-copy" onClick={() => copyToClipboard(requestUrl, setCopyReqText)}>{copyReqText}</button>
                <a id="open-request-link" className="btn-copy" href={requestUrl} target="_blank" rel="noopener noreferrer">Open ↗</a>
              </div>
              <button id="request-qr-btn" className="btn-display-qr" onClick={() => setShowRequestQrModal(true)}>
                <span className="btn-qr-icon">📱</span>Use a QR Code to open the request form on a separate device
              </button>

              {requestMode === 'crowd' && (
                <div id="display-link-row" className="display-link-row">
                  <div className="request-link-label">📺 Display this page so guests can scan the QR code to open the song request form</div>
                  <div className="request-link-controls">
                    <input id="display-url-input" type="text" readOnly className="request-url-input" value={displayUrl} />
                    <button id="copy-display-btn" className="btn-copy" onClick={() => copyToClipboard(displayUrl, setCopyDispText)}>{copyDispText}</button>
                    <a id="open-display-link" className="btn-copy" href={displayUrl} target="_blank" rel="noopener noreferrer">Open ↗</a>
                  </div>
                  <button id="display-qr-btn" className="btn-display-qr" onClick={() => setShowDisplayQrModal(true)}>
                    <span className="btn-qr-icon">📱</span>Use a QR Code to open the crowd QR display page on a separate device
                  </button>
                </div>
              )}
            </div>

            <button id="sd-accordion-btn" className="sd-accordion-toggle" onClick={() => setSdOpen(o => !o)}>
              <span>🎮 Stream Deck</span>
              <span className="sd-chevron" style={sdOpen ? { transform: 'rotate(90deg)' } : undefined}>&#x203A;</span>
            </button>
            {sdOpen && (
              <div id="sd-content" className="sd-inline">
                <p className="hint">Enter these values once in the plugin's property inspector — all buttons share the same connection.</p>
                <div className="sd-field">
                  <p className="sd-field-label">Server URL</p>
                  <div className="request-link-controls">
                    <input id="sd-server-url" type="text" readOnly className="request-url-input" autoComplete="off" value={location.origin} />
                    <button id="sd-copy-url" className="btn-copy" onClick={() => copyToClipboard(location.origin, setCopySdUrlText)}>{copySdUrlText}</button>
                  </div>
                </div>
                <div className="sd-field">
                  <p className="sd-field-label">Session ID</p>
                  <div className="request-link-controls">
                    <input id="sd-session-id" type="text" readOnly className="request-url-input" autoComplete="off" value={sessionId} />
                    <button id="sd-copy-sid" className="btn-copy" onClick={() => copyToClipboard(sessionId, setCopySdSidText)}>{copySdSidText}</button>
                  </div>
                </div>
                <p className="hint">If your server requires a password, enter the Auth Token separately in the plugin inspector.</p>
              </div>
            )}
          </div>
        )}

        {view === 'links' && authMode && (
          <button id="logout-btn" className="btn-ghost btn-logout" onClick={handleLogout}>Log out</button>
        )}
        {view === 'links' && !authMode && (
          <button id="new-room-btn" className="btn-ghost btn-logout" onClick={handleNewRoom}>↺ Start New Room</button>
        )}

      </div>

      {/* ── Request QR modal ── */}
      {showRequestQrModal && (
        <div id="request-qr-modal" className="modal-overlay" role="dialog" aria-modal="true" aria-label="Request form QR code"
             onClick={e => { if (e.target === e.currentTarget) setShowRequestQrModal(false); }}>
          <div className="modal">
            <div className="modal-header-row">
              <span className="modal-heading">Open Request Form</span>
              <button id="request-qr-close" className="btn-modal-close" aria-label="Close" onClick={() => setShowRequestQrModal(false)}>&times;</button>
            </div>
            <p className="modal-hint">Scan to open the song request form on another device.</p>
            {requestQr && <img id="request-qr-img" className="req-link-qr" src={requestQr} alt="Request form QR code" />}
          </div>
        </div>
      )}

      {/* ── Display QR modal ── */}
      {showDisplayQrModal && (
        <div id="display-qr-modal" className="modal-overlay" role="dialog" aria-modal="true" aria-label="Display page QR code"
             onClick={e => { if (e.target === e.currentTarget) setShowDisplayQrModal(false); }}>
          <div className="modal">
            <div className="modal-header-row">
              <span className="modal-heading">Open Crowd QR Display Page</span>
              <button id="display-qr-close" className="btn-modal-close" aria-label="Close" onClick={() => setShowDisplayQrModal(false)}>&times;</button>
            </div>
            <p className="modal-hint">Scan to open the crowd display on another device.</p>
            {displayQr && <img id="display-qr-img" className="req-link-qr" src={displayQr} alt="Display page QR code" />}
          </div>
        </div>
      )}

    </>
  );
}
