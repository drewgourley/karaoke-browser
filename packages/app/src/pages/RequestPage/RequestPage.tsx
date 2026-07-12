import { useState, useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useDeviceToken } from '../../hooks/useDeviceToken.ts';
import { useWakeLock } from '../../hooks/useWakeLock.ts';
import { useFullscreen } from '../../hooks/useFullscreen.ts';
import type { ServerMessage, RequestMode } from '@karaoke-browser/shared';
import './RequestPage.css';

type RequestView = 'invalid' | 'form' | 'blocked' | 'banned' | 'success';

export default function RequestPage() {
  useEffect(() => {
    document.title = 'Request a Song';
    const icon = document.querySelector<HTMLLinkElement>("link[rel='icon']");
    if (icon) icon.href = `data:image/svg+xml,${encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🎵</text></svg>")}`;
  }, []);

  const [searchParams] = useSearchParams();
  const sessionId  = searchParams.get('s');
  const deviceToken = useDeviceToken();

  const [view, setView]         = useState<RequestView>(sessionId ? 'form' : 'invalid');
  const [mode, setMode]         = useState<RequestMode>('kiosk');
  const [isBlocked, setIsBlocked] = useState(false);
  const [wsError, setWsError]   = useState(false);
  const [submitDisabled, setSubmitDisabled] = useState(true);

  const [name, setName]     = useState('');
  const [artist, setArtist] = useState('');
  const [title, setTitle]   = useState('');
  const { enable: wakeLockEnable, disable: wakeLockDisable } = useWakeLock();
  const { isFullscreen, toggle: toggleFullscreen } = useFullscreen({ onEnter: wakeLockEnable, onExit: wakeLockDisable });

  const wsRef       = useRef<WebSocket | null>(null);
  const retryTimer  = useRef<ReturnType<typeof setTimeout> | null>(null);
  const successTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isBlockedRef = useRef(isBlocked);
  const modeRef     = useRef(mode);

  useEffect(() => { isBlockedRef.current = isBlocked; }, [isBlocked]);
  useEffect(() => { modeRef.current = mode; }, [mode]);

  const connect = () => {
    if (!sessionId) return;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(
      `${proto}//${location.host}/ws?role=request&s=${encodeURIComponent(sessionId)}`
    );
    wsRef.current = ws;

    ws.onopen = () => {
      setWsError(false);
      ws.send(JSON.stringify({ type: 'hello', deviceToken }));
      if (!isBlockedRef.current) setSubmitDisabled(false);
    };

    ws.onclose = () => {
      setSubmitDisabled(true);
      setWsError(true);
      retryTimer.current = setTimeout(connect, 3000);
    };

    ws.onmessage = (event: MessageEvent<string>) => {
      let msg: ServerMessage;
      try { msg = JSON.parse(event.data) as ServerMessage; } catch { return; }

      if (msg.type === 'device-status') {
        setMode(msg.mode);
        modeRef.current = msg.mode;
        if (msg.banned) { setView('banned'); setSubmitDisabled(true); return; }
        isBlockedRef.current = !!msg.blocked;
        setIsBlocked(!!msg.blocked);
        if (msg.blocked) {
          setSubmitDisabled(true);
          setView('blocked');
        } else {
          setSubmitDisabled(ws.readyState !== WebSocket.OPEN);
          setView(v => (v === 'blocked' || v === 'form') ? 'form' : v);
        }

      } else if (msg.type === 'device-banned') {
        if (msg.token === deviceToken) {
          if (successTimer.current) clearTimeout(successTimer.current);
          setView('banned');
          setSubmitDisabled(true);
        }

      } else if (msg.type === 'device-cleared') {
        if (msg.token === deviceToken) {
          if (successTimer.current) clearTimeout(successTimer.current);
          isBlockedRef.current = false;
          setIsBlocked(false);
          setName(''); setArtist(''); setTitle('');
          setView('form');
          setSubmitDisabled(ws.readyState !== WebSocket.OPEN);
        }

      } else if (msg.type === 'state') {
        const incoming = msg.requestMode ?? 'kiosk';
        if (incoming !== modeRef.current) {
          modeRef.current = incoming;
          setMode(incoming);
          if (incoming === 'kiosk' && isBlockedRef.current) {
            isBlockedRef.current = false;
            setIsBlocked(false);
            setName(''); setArtist(''); setTitle('');
            setView('form');
            setSubmitDisabled(ws.readyState !== WebSocket.OPEN);
          }
        }
      }
    };
  };

  useEffect(() => {
    if (sessionId) connect();
    return () => {
      wsRef.current?.close();
      if (retryTimer.current) clearTimeout(retryTimer.current);
      if (successTimer.current) clearTimeout(successTimer.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, deviceToken]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    ws.send(JSON.stringify({ type: 'request', name: name.trim(), artist: artist.trim(), title: title.trim(), deviceToken }));

    if (modeRef.current === 'crowd') {
      isBlockedRef.current = true;
      setIsBlocked(true);
      setSubmitDisabled(true);
      setView('blocked');
    } else {
      setView('success');
      successTimer.current = setTimeout(() => {
        setName(''); setArtist(''); setTitle('');
        setView('form');
      }, 4000);
    }
  };



  return (
    <div className="page">
      {/* Fullscreen toggle — only shown when the API is available */}
      {(document.fullscreenEnabled || !!(document as any).webkitFullscreenEnabled) && (
        <button className="fullscreen-btn" onClick={toggleFullscreen} title={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}>
          {isFullscreen ? (
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.5">
              <polyline points="4,14 10,14 10,20" /><polyline points="20,10 14,10 14,4" />
              <line x1="10" y1="14" x2="3" y2="21" /><line x1="21" y1="3" x2="14" y2="10" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.5">
              <polyline points="15,3 21,3 21,9" /><polyline points="9,21 3,21 3,15" />
              <line x1="21" y1="3" x2="14" y2="10" /><line x1="3" y1="21" x2="10" y2="14" />
            </svg>
          )}
        </button>
      )}

      <header>
        <div className="logo">🎤</div>
        <h1>Karaoke Request</h1>
        <p className="subtitle">Ask the DJ to play your song</p>
      </header>

      {view === 'invalid' && (
        <div id="invalid-section" className="card">
          <p className="hint">This request link is invalid. Please ask the host for a valid link.</p>
        </div>
      )}

      {view === 'form' && (
        <div id="form-section" className="card">
          <form id="request-form" autoComplete="off" noValidate onSubmit={handleSubmit}>
            <div className="field">
              <label htmlFor="request-name">Your name</label>
              <input id="request-name" type="text" placeholder="Your name"
                     autoComplete="given-name" maxLength={120}
                     value={name} onChange={e => setName(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="request-artist">Artist</label>
              <input id="request-artist" type="text" placeholder="Artist name"
                     autoComplete="off" maxLength={120}
                     value={artist} onChange={e => setArtist(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="request-title">Song title <span className="required">*</span></label>
              <input id="request-title" type="text" placeholder="Song title"
                     autoComplete="off" maxLength={120}
                     value={title} onChange={e => setTitle(e.target.value)} />
            </div>
            <button type="submit" id="submit-btn" className="btn-primary" disabled={submitDisabled}>Send Request</button>
          </form>
          <div id="ws-error" className="error" hidden={!wsError}>Connection lost — please reload the page.</div>
        </div>
      )}

      {view === 'success' && (
        <div id="success-section" className="success">
          <div className="success-icon">📬</div>
          <div className="success-title">Request Sent!</div>
          <div className="success-sub">The DJ has your request.</div>
        </div>
      )}

      {view === 'blocked' && (
        <div id="blocked-section" className="success">
          <div className="success-icon">📬</div>
          <div className="success-title">Request Sent!</div>
          <div className="success-sub">Once your request is processed you'll be able to submit another one.</div>
        </div>
      )}

      {view === 'banned' && (
        <div id="banned-section" className="success" style={{ '--success-color': '#ef476f' } as React.CSSProperties}>
          <div className="success-icon">🚫</div>
          <div className="success-title">Requests Closed</div>
          <div className="success-sub">You're unable to submit requests for this session.</div>
        </div>
      )}


    </div>
  );
}
