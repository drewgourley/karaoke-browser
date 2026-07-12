import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../../api/client.ts';
import { useFullscreen } from '../../hooks/useFullscreen.ts';
import type { StandbyThemeResponse } from '@karaoke-browser/shared';
import './DisplayPage.css';

function applyTheme(t: StandbyThemeResponse) {
  const root = document.documentElement;
  const defs = ['#4cc9f0', '#4361ee', '#7c3aed', '#f72585', '#ff6b35', '#ffd166', '#06d6a0', '#3a0ca3'];
  (t.standbyColors ?? defs).forEach((c, i) => root.style.setProperty(`--sc${i + 1}`, c || defs[i]!));
  root.style.setProperty('--scq-heading-color', t.standbyTitleColor ?? '#ffffff');
  const tSz = t.standbyTitleOutlineSize ?? 20;
  root.style.setProperty('--scq-heading-stroke', tSz > 0 ? `${Math.ceil(tSz / 2)}px ${t.standbyTitleOutline ?? '#000000'}` : '0px transparent');
  root.style.setProperty('--scq-sub-color', t.standbySubtitleColor ?? '#ffffff');
  const sSz = t.standbySubtitleOutlineSize ?? 8;
  root.style.setProperty('--scq-sub-stroke', sSz > 0 ? `${Math.ceil(sSz / 2)}px ${t.standbySubtitleOutline ?? '#000000'}` : '0px transparent');
}

export default function DisplayPage() {
  useEffect(() => {
    document.title = 'Karaoke Display';
    const icon = document.querySelector<HTMLLinkElement>("link[rel='icon']");
    if (icon) icon.href = `data:image/svg+xml,${encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>📱</text></svg>")}`;
  }, []);

  const [searchParams] = useSearchParams();
  const sessionId = searchParams.get('s');

  const [qrSrc, setQrSrc]   = useState<string | null>(null);
  const [error, setError]   = useState(false);
  const [requestUrl, setRequestUrl] = useState('');

  const hideTimer     = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [btnVisible, setBtnVisible] = useState(true);
  const { isFullscreen, toggle: toggleFullscreen } = useFullscreen();

  // Fullscreen button hide-on-idle
  useEffect(() => {
    const show = () => {
      setBtnVisible(true);
      if (hideTimer.current) clearTimeout(hideTimer.current);
      hideTimer.current = setTimeout(() => setBtnVisible(false), 3000);
    };
    document.addEventListener('mousemove', show);
    show();
    return () => { document.removeEventListener('mousemove', show); if (hideTimer.current) clearTimeout(hideTimer.current); };
  }, []);

  // Load theme + QR
  useEffect(() => {
    if (!sessionId) { setError(true); return; }
    const reqUrl = `${location.origin}/request?s=${encodeURIComponent(sessionId)}`;
    setRequestUrl(reqUrl);

    Promise.all([
      api.getStandbyTheme(sessionId).catch(() => null),
      api.getQr(sessionId, reqUrl).catch(() => null),
    ]).then(([theme, qr]) => {
      if (theme) applyTheme(theme);
      if (qr?.dataUrl) setQrSrc(qr.dataUrl);
      else setError(true);
    }).catch(() => setError(true));
  }, [sessionId]);

  if (error) {
    return (
      <>
        <button
          id="fullscreen-btn"
          className={btnVisible ? 'visible' : ''}
          onClick={toggleFullscreen}
          title={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
        >
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
        <div className="display-page" id="error-page">
          <div className="logo">😕</div>
          <h1 className="heading" style={{ fontSize: 'clamp(1.5rem,5vw,2.5rem)' }}>Invalid Link</h1>
          <p className="sub">This display link is invalid or the session has expired.<br />Ask the host for a valid link.</p>
        </div>
      </>
    );
  }

  return (
    <>
      <button
        id="fullscreen-btn"
        className={btnVisible ? 'visible' : ''}
        onClick={toggleFullscreen}
        title={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
      >
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

      <div className="display-page" id="display-page">
        <div className="logo">🎤</div>
        <h1 className="heading">Make a Request!</h1>
        <p className="sub">Scan the code to pick a karaoke song</p>
        <div className="qr-card" id="qr-card">
          {qrSrc && <img id="qr-img" className="qr-img" src={qrSrc} alt="Scan to request a song" />}
        </div>
        <p className="url-pill" id="url-pill">{requestUrl}</p>
      </div>
    </>
  );
}
