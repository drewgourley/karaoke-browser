import {
  useState, useEffect, useRef, useCallback, useReducer,
} from 'react';
import { useNavigate } from 'react-router-dom';
import { useSession } from '../../context/SessionContext.tsx';
import { useWebSocket } from '../../hooks/useWebSocket.ts';
import { api } from '../../api/client.ts';
import type { StateMessage, ClientMessage, QueueItem, PublicSongRequest, SearchResult, PlaylistSearchResult } from '@karaoke-browser/shared';
import './ControllerPage.css';

// ── Constants ────────────────────────────────────────────────────────────
const MX_HANDLE_H  = 40;
const MX_DEFAULT_H = 320;
const VU_DOTS      = 20;

function thumb(videoId: string) {
  return `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`;
}

// Split a "family|weight" font value (matches the legacy standby settings format)
function parseFont(v: string): { family: string; weight: string } {
  if (!v) return { family: '', weight: '' };
  const sep = v.indexOf('|');
  return sep === -1 ? { family: v, weight: '' } : { family: v.slice(0, sep), weight: v.slice(sep + 1) };
}

// Standby font picker options (shared by the title and subtitle selects)
function FontOptions() {
  return (
    <>
      <option value="">— Default —</option>
      <optgroup label="Sans-Serif">
        <option value="'Oswald', sans-serif|200">Oswald · ExtraLight</option>
        <option value="'Oswald', sans-serif|400">Oswald · Regular</option>
        <option value="'Oswald', sans-serif|600">Oswald · SemiBold</option>
        <option value="'Raleway', sans-serif|100">Raleway · Thin</option>
        <option value="'Raleway', sans-serif|400">Raleway · Regular</option>
        <option value="'Raleway', sans-serif|800">Raleway · ExtraBold</option>
        <option value="'SN Pro', sans-serif|200">SN Pro · ExtraLight</option>
        <option value="'SN Pro', sans-serif|400">SN Pro · Regular</option>
        <option value="'SN Pro', sans-serif|800">SN Pro · ExtraBold</option>
      </optgroup>
      <optgroup label="Serif">
        <option value="'Domine', serif|400">Domine · Regular</option>
        <option value="'Domine', serif|700">Domine · Bold</option>
        <option value="'Instrument Serif', serif">Instrument Serif</option>
        <option value="'Abril Fatface', serif">Abril Fatface</option>
      </optgroup>
      <optgroup label="Script">
        <option value="'MonteCarlo', cursive">MonteCarlo</option>
        <option value="'Great Vibes', cursive">Great Vibes</option>
      </optgroup>
      <optgroup label="Display">
        <option value="'Carter One', sans-serif">Carter One</option>
        <option value="'Chango', sans-serif">Chango</option>
      </optgroup>
    </>
  );
}

// ── ControllerPage ────────────────────────────────────────────────────────
export default function ControllerPage() {
  const { sessionId } = useSession();
  const navigate = useNavigate();

  useEffect(() => {
    document.title = 'Karaoke Controller';
    const icon = document.querySelector<HTMLLinkElement>("link[rel='icon']");
    if (icon) icon.href = `data:image/svg+xml,${encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🎛️</text></svg>")}`;
  }, []);

  useEffect(() => {
    if (!sessionId) navigate('/?redirect=/controller');
  }, [sessionId, navigate]);

  const { sendMessage, lastMessage, connected, displaced, reclaim } = useWebSocket('controller', sessionId);

  // ── Server state ─────────────────────────────────────────────────────────
  const [st, setSt] = useState<StateMessage | null>(null);
  useEffect(() => {
    if (lastMessage?.type === 'state') setSt(lastMessage as StateMessage);
  }, [lastMessage]);

  // ── Add-song form ─────────────────────────────────────────────────────────
  const [addUrl, setAddUrl]     = useState('');
  const [addTitle, setAddTitle] = useState('');
  const [fetching, setFetching] = useState(false);
  const [addTab, setAddTab]     = useState<'search' | 'url'>('search');
  const [searchQ, setSearchQ]   = useState('');
  const [searchKaraoke, setSearchKaraoke] = useState(true);
  const [searching, setSearching]         = useState(false);
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchError, setSearchError]     = useState('');

  // ── Singer modal ─────────────────────────────────────────────────────────
  const [singerModal, setSingerModal] = useState<{ url: string; title: string; onConfirm?: () => void } | null>(null);
  const [singerName, setSingerName]   = useState('');
  const [pendingRequestName, setPendingRequestName] = useState<string | null>(null);
  const [pendingGrantId, setPendingGrantId]         = useState<number | null>(null);

  // ── Drag reorder ──────────────────────────────────────────────────────────
  const dragFrom = useRef<number | null>(null);

  // ── Devices modal ─────────────────────────────────────────────────────────
  const [showDevices, setShowDevices] = useState(false);

  // ── Link modals ───────────────────────────────────────────────────────────
  const [reqLinkModal, setReqLinkModal]       = useState(false);
  const [kioskLinkModal, setKioskLinkModal]   = useState(false);
  const [reqLinkQr, setReqLinkQr]             = useState('');
  const [kioskLinkQr, setKioskLinkQr]         = useState('');
  const [showSdModal, setShowSdModal]         = useState(false);
  const [, forceRerender] = useReducer(x => x + 1, 0);

  // ── Standby settings modal ────────────────────────────────────────────────
  const [showSsModal, setShowSsModal] = useState(false);
  const [ssTitle, setSsTitle]         = useState('Karaoke Browser');
  const [ssSub, setSsSub]             = useState('Your karaoke night command center');
  const [ssColors, setSsColors]       = useState(['#4cc9f0', '#4361ee', '#7c3aed', '#f72585', '#ff6b35', '#ffd166', '#06d6a0', '#3a0ca3']);
  const [ssTitleColor, setSsTitleColor]       = useState('#ffffff');
  const [ssTitleOutline, setSsTitleOutline]   = useState('#000000');
  const [ssTitleFont, setSsTitleFont]         = useState('');
  const [ssTitleSize, setSsTitleSize]         = useState(0);
  const [ssTitleOSize, setSsTitleOSize]       = useState(20);
  const [ssSubColor, setSsSubColor]           = useState('#ffffff');
  const [ssSubOutline, setSsSubOutline]       = useState('#000000');
  const [ssSubFont, setSsSubFont]             = useState('');
  const [ssSubSize, setSsSubSize]             = useState(0);
  const [ssSubOSize, setSsSubOSize]           = useState(8);

  // ── Mixer panel ───────────────────────────────────────────────────────────
  const [mxOpen, setMxOpen]     = useState(() => localStorage.getItem('kk_mixer_open') === 'true');
  const [mxHeight, setMxHeight] = useState(() => parseInt(localStorage.getItem('kk_mixer_h') ?? '0') || MX_DEFAULT_H);
  const mxDragStart = useRef<{ y: number; h: number } | null>(null);
  const mxDragged   = useRef(false);

  const [mxTab, setMxTab]           = useState<'search' | 'url'>('search');
  const [mxUrlInput, setMxUrlInput] = useState('');
  const [mxSearchQ, setMxSearchQ]   = useState('');
  const [mxSearching, setMxSearching] = useState(false);
  const [mxSearchResults, setMxSearchResults] = useState<PlaylistSearchResult[]>([]);
  const [mxSearchStatus, setMxSearchStatus]   = useState('');
  type TrackItem = { videoId: string; title: string; thumbnail: string };
  const [mxTracks, setMxTracks]               = useState<TrackItem[]>([]);
  const [mxTracksLoaded, setMxTracksLoaded]   = useState<string | null>(null);

  // ── Mic (Web Audio) ────────────────────────────────────────────────────
  const micCtx      = useRef<AudioContext | null>(null);
  const micGain     = useRef<GainNode | null>(null);
  const micAnalyser = useRef<AnalyserNode | null>(null);
  const micStream   = useRef<MediaStream | null>(null);
  const micLevelTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const [micReady, setMicReady] = useState<boolean | null>(null);
  const [vuLevel, setVuLevel]   = useState(-1);
  const [vuPeak, setVuPeak]     = useState(-1);
  const vuPeakTimer  = useRef<ReturnType<typeof setTimeout>  | null>(null);
  const vuDecayTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const vuFillTimer  = useRef<ReturnType<typeof setTimeout>  | null>(null);

  // ── Displaced banner ─────────────────────────────────────────────────

  useEffect(() => {
    if (lastMessage?.type === 'state') return; // handled above
    // controller doesn't receive transient messages
  }, [lastMessage]);

  const send = useCallback((msg: ClientMessage) => sendMessage(msg), [sendMessage]);

  // ── Mic helpers ──────────────────────────────────────────────────────────
  const setVuLevelFn = useCallback((level: number) => {
    const idx = level <= 0 ? -1 : Math.min(VU_DOTS - 1, Math.ceil((level / 100) * VU_DOTS) - 1);
    setVuLevel(idx);
    setVuPeak(p => {
      if (idx > p) {
        if (vuPeakTimer.current) clearTimeout(vuPeakTimer.current);
        if (vuDecayTimer.current) clearInterval(vuDecayTimer.current);
        vuDecayTimer.current = null;
        vuPeakTimer.current = setTimeout(() => {
          vuDecayTimer.current = setInterval(() => {
            setVuPeak(pp => { if (pp <= 0) { clearInterval(vuDecayTimer.current!); return -1; } return pp - 1; });
          }, 60);
        }, 1200);
        return idx;
      }
      return p;
    });
    if (vuFillTimer.current) clearTimeout(vuFillTimer.current);
    vuFillTimer.current = setTimeout(() => setVuLevel(-1), 300);
  }, []);

  const applyMicGain = useCallback((vol: number, muted: boolean) => {
    if (micGain.current) micGain.current.gain.value = muted ? 0 : vol / 100;
  }, []);

  const initMic = useCallback(async () => {
    if (micStream.current) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false },
      });
      const ctx = new AudioContext();
      const source = ctx.createMediaStreamSource(stream);
      const gain = ctx.createGain();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.75;
      source.connect(gain);
      gain.connect(analyser);
      analyser.connect(ctx.destination);
      micCtx.current = ctx;
      micGain.current = gain;
      micAnalyser.current = analyser;
      micStream.current = stream;
      const buf = new Uint8Array(analyser.fftSize);
      micLevelTimer.current = setInterval(() => {
        analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (const b of buf) { const v = (b - 128) / 128; sum += v * v; }
        const rms = Math.sqrt(sum / buf.length);
        const db = rms > 0.0001 ? 20 * Math.log10(rms) : -100;
        setVuLevelFn(Math.round(Math.max(0, Math.min(100, (db + 60) / 60 * 100))));
      }, 50);
      setMicReady(true);
    } catch { setMicReady(false); }
  }, [setVuLevelFn]);

  useEffect(() => {
    if (connected) void initMic();
  }, [connected, initMic]);

  useEffect(() => {
    document.addEventListener('click', () => void initMic(), { once: true });
    return () => {
      if (micLevelTimer.current) clearInterval(micLevelTimer.current);
      micStream.current?.getTracks().forEach(t => t.stop());
    };
  }, [initMic]);

  // Sync mic gain whenever state changes
  useEffect(() => {
    if (st) applyMicGain(st.micVolume, st.micMuted);
  }, [st, applyMicGain]);

  // ── Mixer drag ────────────────────────────────────────────────────────────
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!mxDragStart.current) return;
      const delta = mxDragStart.current.y - e.clientY;
      if (Math.abs(delta) > 5) mxDragged.current = true;
      if (!mxDragged.current) return;
      const newH = Math.max(MX_HANDLE_H, Math.min(Math.floor(window.innerHeight * 0.8), mxDragStart.current.h + delta));
      setMxHeight(newH);
    };
    const onUp = () => {
      if (!mxDragStart.current) return;
      const wasDrag = mxDragged.current;
      mxDragStart.current = null;
      mxDragged.current = false;
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      if (!wasDrag) {
        setMxOpen(o => { const n = !o; localStorage.setItem('kk_mixer_open', String(n)); return n; });
      } else {
        setMxHeight(h => {
          const isClosed = h <= MX_HANDLE_H + 30;
          setMxOpen(!isClosed);
          if (!isClosed) { localStorage.setItem('kk_mixer_h', String(h)); localStorage.setItem('kk_mixer_open', 'true'); }
          return isClosed ? MX_HANDLE_H : h;
        });
      }
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
  }, []);

  // ── Load playlist tracks ──────────────────────────────────────────────────
  useEffect(() => {
    const pid = st?.standbyPlaylistId;
    if (!pid || pid === mxTracksLoaded || !sessionId) return;
    void api.mixerPlaylistItems(sessionId, pid)
      .then(({ items }) => { setMxTracks(items as TrackItem[]); setMxTracksLoaded(pid); })
      .catch(() => {});
  }, [st?.standbyPlaylistId, mxTracksLoaded, sessionId]);

  useEffect(() => {
    if (!st?.standbyPlaylistId) { setMxTracks([]); setMxTracksLoaded(null); }
  }, [st?.standbyPlaylistId]);

  // ── Actions ───────────────────────────────────────────────────────────────
  const fetchTitle = async (url: string) => {
    if (!url) return;
    setFetching(true);
    try {
      const { title } = await api.getTitle(url);
      if (title) setAddTitle(title);
    } catch { /* ignore */ }
    setFetching(false);
  };

  const handleAddSong = () => {
    if (!addUrl.trim()) return;
    const url = addUrl.trim(); const title = addTitle.trim();
    setAddUrl(''); setAddTitle('');
    openSingerModal(url, title || url);
  };

  const openSingerModal = (url: string, title: string, onConfirm?: () => void) => {
    setSingerModal({ url, title, onConfirm });
    setSingerName(pendingRequestName ?? '');
    setPendingRequestName(null);
  };

  const confirmSinger = () => {
    if (!singerModal) return;
    send({ type: 'add', url: singerModal.url, title: singerModal.title, singer: singerName.trim() });
    if (pendingGrantId !== null) {
      send({ type: 'dismiss-request', id: pendingGrantId });
      setPendingGrantId(null);
    }
    singerModal.onConfirm?.();
    setSingerModal(null); setSingerName('');
  };

  const closeSinger = () => {
    if (pendingGrantId !== null) { setPendingGrantId(null); forceRerender(); }
    setSingerModal(null); setSingerName('');
  };

  const doSearch = async () => {
    const q = searchQ.trim();
    if (!q) return;
    setSearching(true); setSearchError(''); setSearchResults([]);
    try {
      const { results, error } = await api.search(searchKaraoke ? q + ' karaoke' : q);
      if (error) { setSearchError(error); return; }
      setSearchResults(results ?? []);
    } catch { setSearchError('Search failed'); }
    setSearching(false);
  };

  const grantRequest = (req: PublicSongRequest) => {
    setPendingGrantId(req.id);
    setPendingRequestName(req.name ?? null);
    setAddTab('search');
    setSearchQ([req.artist, req.title].filter(Boolean).join(' '));
  };

  const openReqLinkModal = async () => {
    if (!sessionId) return;
    const url = `${location.origin}/display?s=${encodeURIComponent(sessionId)}`;
    setReqLinkQr('');
    setReqLinkModal(true);
    try { const { dataUrl } = await api.getQr(sessionId, url); setReqLinkQr(dataUrl); } catch { /* ignore */ }
  };

  const openKioskLinkModal = async () => {
    if (!sessionId) return;
    const url = `${location.origin}/request?s=${encodeURIComponent(sessionId)}`;
    setKioskLinkQr('');
    setKioskLinkModal(true);
    try { const { dataUrl } = await api.getQr(sessionId, url); setKioskLinkQr(dataUrl); } catch { /* ignore */ }
  };

  const openSsModal = () => {
    if (!st) return;
    const defs = ['#4cc9f0', '#4361ee', '#7c3aed', '#f72585', '#ff6b35', '#ffd166', '#06d6a0', '#3a0ca3'];
    setSsTitle(st.standbyTitle || 'Karaoke Browser');
    setSsSub(st.standbySubtitle ?? 'Your karaoke night command center');
    setSsColors(st.standbyColors || defs);
    setSsTitleColor(st.standbyTitleColor || '#ffffff');
    setSsTitleOutline(st.standbyTitleOutline || '#000000');
    setSsTitleFont(st.standbyTitleFont || '');
    setSsTitleSize(st.standbyTitleSize || 0);
    setSsTitleOSize(st.standbyTitleOutlineSize ?? 20);
    setSsSubColor(st.standbySubtitleColor || '#ffffff');
    setSsSubOutline(st.standbySubtitleOutline || '#000000');
    setSsSubFont(st.standbySubtitleFont || '');
    setSsSubSize(st.standbySubtitleSize || 0);
    setSsSubOSize(st.standbySubtitleOutlineSize ?? 8);
    setShowSsModal(true);
  };

  const saveSs = () => {
    send({ type: 'set-standby-settings', title: ssTitle.slice(0,80), subtitle: ssSub.slice(0,120), colors: ssColors, titleColor: ssTitleColor, titleOutline: ssTitleOutline, titleFont: ssTitleFont, titleSize: ssTitleSize, titleOutlineSize: ssTitleOSize, subtitleColor: ssSubColor, subtitleOutline: ssSubOutline, subtitleFont: ssSubFont, subtitleSize: ssSubSize, subtitleOutlineSize: ssSubOSize });
    setShowSsModal(false);
  };

  const mxDoSearch = async () => {
    const q = mxSearchQ.trim();
    if (!q) return;
    setMxSearching(true); setMxSearchStatus('Searching…'); setMxSearchResults([]);
    try {
      const { items, error } = await api.mixerSearch(q);
      if (error === 'not_configured') { setMxSearchStatus('Requires a YouTube API key — URL paste still works.'); return; }
      if (error || !items) { setMxSearchStatus('Search failed.'); return; }
      if (!items.length) { setMxSearchStatus('No playlists found.'); return; }
      setMxSearchStatus('');
      setMxSearchResults(items);
    } catch { setMxSearchStatus('Search failed.'); }
    setMxSearching(false);
  };

  const displayUrl = sessionId ? `${location.origin}/display?s=${encodeURIComponent(sessionId)}` : '';
  const requestUrl = sessionId ? `${location.origin}/request?s=${encodeURIComponent(sessionId)}` : '';

  const np = st?.nowPlaying ?? null;
  const queue = st?.queue ?? [];
  const requests = st?.requests ?? [];
  const micVol = st?.micVolume ?? 80;
  const micMuted = !!st?.micMuted;

  if (displaced) {
    return (
      <div id="displaced-banner">
        <span>⚠️ This tab was replaced by another controller.</span>
        <button id="displaced-reclaim-btn" onClick={reclaim}>Take back control</button>
      </div>
    );
  }

  return (
    <>
      <header>
        <h1>🎤 Karaoke Controller</h1>
        <div className="header-right">
          <button className="ghost" id="streamdeck-btn" title="Stream Deck plugin setup info" onClick={() => setShowSdModal(true)}>🎮 Stream Deck</button>
          {st?.requestMode === 'crowd' && (
            <button className="ghost" id="req-link-btn" title="Get the crowd QR display link" onClick={openReqLinkModal}>🗃️ Crowd QR Display</button>
          )}
          {st?.requestMode !== 'crowd' && (
            <button className="ghost" id="kiosk-link-btn" title="Get the kiosk / request link" onClick={openKioskLinkModal}>🏠 Kiosk Link</button>
          )}
          <button className="ghost" id="open-player-btn" title="Open the player in a new tab" onClick={() => window.open('/player', '_blank')}>📺 Open Player</button>
          {(st?.requesterCount ?? 0) > 0 && (
            <div className="status status-clickable" id="requester-badge" title="Manage connected devices" onClick={() => setShowDevices(true)}>
              <div className="dot on"></div>
              <span id="requester-badge-text">{st?.requestMode === 'kiosk' ? 'Kiosk' : `${st?.requesterCount} Requester${(st?.requesterCount ?? 0) === 1 ? '' : 's'}`}</span>
            </div>
          )}
          {st?.playerConnected && (
            <div className="status" id="player-up-badge">
              <div className="dot on"></div>
              <span>Player</span>
            </div>
          )}
          <div className="status">
            <div className={`dot${connected ? ' on' : ''}`} id="dot"></div>
            <span id="status-text">{connected ? 'Connected' : 'Connecting…'}</span>
          </div>
        </div>
      </header>

      <main>
        {/* Left column: Now Playing + Queue */}
        <div className="col">
          <div className="card">
            <div className="queue-header">
              <div className="card-label" style={{ marginBottom: 0 }}>Now Playing</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                {np && !np.embedError && queue.length > 0 && (
                  <button className="ghost" id="requeue-btn" title="Requeue: put current track back at the top of the queue and play next" style={{ fontSize: '0.75rem' }} disabled={!st?.playerConnected || st?.playerMode === 'standby'} onClick={() => send({ type: 'requeue' })}>↩ Requeue</button>
                )}
                <div className="player-mode-toggle" id="player-mode-toggle" data-mode={st?.playerMode ?? 'karaoke'} title={'Standby: show standby screen\nKaraoke: normal karaoke playback'}>
                  <span className="pmt-track"></span>
                  <button className="pmt-opt" id="pmt-standby" onClick={() => send({ type: 'set-player-mode', mode: 'standby' })}>🌙 Standby</button>
                  <button className="pmt-opt" id="pmt-karaoke" onClick={() => send({ type: 'set-player-mode', mode: 'karaoke' })}>🎤 Karaoke</button>
                </div>
              </div>
            </div>
            <div id="now-playing">
              {!np ? (
                <span className="np-idle">Nothing playing</span>
              ) : np.embedError ? (
                <div className="embed-warn">
                  <div className="embed-warn-title">⚠️ {np.title}</div>
                  <div className="embed-warn-msg">This video can't be embedded — playing on YouTube in the player window.</div>
                  <div className="row" style={{ marginTop: '0.25rem' }}>
                    <a className="btn" href={np.url} target="_blank" rel="noopener noreferrer">Open in YouTube</a>
                    <button className="secondary" disabled={!st?.playerConnected || st?.playerMode === 'standby'} onClick={() => send({ type: 'next' })}>⏭ Skip</button>
                  </div>
                </div>
              ) : (
                <div className="np-wrap">
                  <img className="np-thumb" src={thumb(np.videoId)} alt="" />
                  <div className="np-info">
                    <div className="np-title" title={np.title}>{np.title}</div>
                    {np.singer && <div className="np-singer">🎤 {np.singer}</div>}
                    <div className="row">
                      <button className="secondary icon" disabled={!st?.playerConnected || st?.playerMode === 'standby'} onClick={() => send({ type: 'restart' })}>↺ Restart</button>
                      <button className="secondary icon" disabled={!st?.playerConnected || st?.playerMode === 'standby'} onClick={() => send({ type: st?.paused ? 'resume' : 'pause' })}>
                        {(!st?.playerConnected || st?.paused) ? '▶ Begin' : '⏸ Pause'}
                      </button>
                      <button className="secondary icon" disabled={!st?.playerConnected || st?.playerMode === 'standby'} onClick={() => send({ type: 'next' })}>⏭ Skip</button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="card">
            <div className="queue-header">
              <div className="card-label" style={{ marginBottom: 0 }}>Up Next <span className="badge" id="q-count">{queue.length}</span></div>
              <button className="ghost" id="clear-btn" title="Clear entire queue" style={{ fontSize: '0.75rem' }} onClick={() => { if (queue.length && confirm('Clear queue?')) for (let i = queue.length - 1; i >= 0; i--) send({ type: 'remove', index: i }); }}>Clear all</button>
            </div>
            <ul className="queue" id="queue-list">
              {queue.length === 0 ? (
                <li className="empty">Queue is empty</li>
              ) : queue.map((item: QueueItem, i: number) => (
                <li
                  key={item.id}
                  className="qi"
                  draggable
                  onDragStart={() => { dragFrom.current = i; }}
                  onDragOver={e => e.preventDefault()}
                  onDrop={e => { e.preventDefault(); if (dragFrom.current !== null && dragFrom.current !== i) send({ type: 'reorder', from: dragFrom.current, to: i }); dragFrom.current = null; }}
                >
                  <span className="qi-num">{i + 1}</span>
                  <img className="qi-thumb" src={thumb(item.videoId)} alt="" />
                  <div className="qi-info">
                    <span className="qi-title" title={item.title}>{item.title}</span>
                    {item.singer && <span className="qi-singer">🎤 {item.singer}</span>}
                  </div>
                  <div className="qi-actions">
                    {i > 0 && <button className="ghost" onClick={() => send({ type: 'reorder', from: i, to: i - 1 })}>↑</button>}
                    {i < queue.length - 1 && <button className="ghost" onClick={() => send({ type: 'reorder', from: i, to: i + 1 })}>↓</button>}
                    <button className="ghost" onClick={() => send({ type: 'play-index', index: i })}>▶</button>
                    <button className="ghost" onClick={() => send({ type: 'remove', index: i })}>✕</button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </div>

        {/* Middle column: Find Song */}
        <div className="col">
          <div className="card">
            <div className="find-header">
              <div className="card-label" style={{ marginBottom: 0 }}>Find Song</div>
              <div className="find-tab-toggle" id="find-tab-toggle" data-tab={addTab}>
                <span className="find-tab-track"></span>
                <button className="find-tab-btn" id="tab-search" onClick={() => setAddTab('search')}>🔍 Search</button>
                <button className="find-tab-btn" id="tab-url" onClick={() => setAddTab('url')}>🔗 Paste URL</button>
              </div>
            </div>

            <div id="panel-search" style={addTab === 'search' ? undefined : { display: 'none' }}>
              <div className="row">
                <input type="text" id="search-input" value={searchQ} onChange={e => setSearchQ(e.target.value)} onKeyDown={e => e.key === 'Enter' && doSearch()} placeholder="Search for a karaoke song…" autoComplete="off" />
                <label className="karaoke-label" title="Append 'karaoke' to your search">
                  <input type="checkbox" id="karaoke-check" checked={searchKaraoke} onChange={e => setSearchKaraoke(e.target.checked)} /> +karaoke
                </label>
                <button id="search-btn" disabled={searching} onClick={doSearch}>{searching ? '…' : 'Search'}</button>
              </div>
              {searchError && <div className="empty">{searchError}</div>}
              <div id="search-results">
                {searchResults.map((item, i) => (
                  <div key={i} className="sr-item">
                    <img className="sr-thumb" src={item.thumb} alt="" loading="lazy" />
                    <div className="sr-info">
                      <div className="sr-title" title={item.title}>{item.title}</div>
                      <div className="sr-channel">{item.channel}</div>
                    </div>
                    <button className="secondary sr-add-btn" onClick={() => openSingerModal(item.url, item.title, () => { /* mark added */ })}>+ Add</button>
                  </div>
                ))}
              </div>
            </div>

            <div id="panel-url" style={addTab === 'url' ? undefined : { display: 'none' }}>
              <div className="add-form">
                <div className="row">
                  <input type="url" id="url-input" value={addUrl} onChange={e => setAddUrl(e.target.value)} onPaste={e => { setTimeout(() => fetchTitle((e.target as HTMLInputElement).value.trim()), 80); }} onKeyDown={e => e.key === 'Enter' && handleAddSong()} placeholder="Paste a YouTube URL…" autoComplete="off" />
                  <button className="secondary" id="fetch-btn" disabled={fetching} onClick={() => fetchTitle(addUrl.trim())}>{fetching ? '…' : 'Fetch Title'}</button>
                </div>
                <div className="row">
                  <input type="text" id="title-input" value={addTitle} onChange={e => setAddTitle(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleAddSong()} placeholder="Title (auto-fetched on paste)" autoComplete="off" />
                  <button id="add-btn" onClick={handleAddSong}>+ Add</button>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Third column: Incoming Requests */}
        <div className="col" id="requests-col">
          <div className="card">
            <div className="queue-header">
              <div className="card-label" style={{ marginBottom: 0 }}>
                Requests <span className="badge" id="req-count">{requests.length}</span>
                {(st?.bannedCount ?? 0) > 0 && (
                  <span id="req-banned-badge" className="badge" style={{ background: 'rgba(239,71,111,0.15)', color: '#ef476f', marginLeft: '0.3rem' }}>🔨 <span id="req-banned-count">{st?.bannedCount}</span> banned</span>
                )}
              </div>
              <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
                {st?.requestMode === 'crowd' && (st?.blockedCount ?? 0) > 0 && (
                  <button id="req-clear-blocked-btn" className="btn-clear-blocked" title="Unblock all waiting crowd devices" onClick={() => send({ type: 'clear-blocked-devices' })}>↺ Unblock all</button>
                )}
                <button id="req-mode-btn" className="mode-toggle" data-mode={st?.requestMode ?? 'kiosk'} title={'Kiosk: unlimited requests per device\nCrowd: one request per device until processed'} onClick={() => send({ type: 'set-request-mode', mode: st?.requestMode === 'crowd' ? 'kiosk' : 'crowd' })}>
                  <span className="mode-track"></span>
                  <span className="mode-option">🏠 Kiosk</span>
                  <span className="mode-option">📱 Crowd</span>
                </button>
              </div>
            </div>
            <ul className="queue" id="request-list">
              {requests.length === 0 ? (
                <li className="empty">No requests yet</li>
              ) : requests.map((req: PublicSongRequest) => (
                <li key={req.id} className={`req-item${req.id === pendingGrantId ? ' req-granting' : ''}`}>
                  <div className="req-meta">
                    {req.name   && <span className="req-name">🎤 {req.name}</span>}
                    {req.artist && <span className="req-artist">{req.artist}</span>}
                    <span className="req-title">{req.title}</span>
                  </div>
                  <div className="req-actions">
                    <button className={`req-grant-btn${req.id === pendingGrantId ? ' req-grant-btn--active' : ''}`} onClick={() => grantRequest(req)}>Grant</button>
                    <button className="ghost req-dismiss-btn" onClick={() => send({ type: 'dismiss-request', id: req.id })}>✕</button>
                    {st?.requestMode !== 'kiosk' && (
                      <button className="ghost req-ban-btn" title="Ban device" onClick={() => send({ type: 'ban-device', id: req.id })}>🔨</button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </main>

      {/* ── Mixer panel ── */}
      <div
        id="mixer-panel"
        style={{ height: (mxOpen ? mxHeight : MX_HANDLE_H) + 'px' }}
      >
        <div
          id="mixer-handle"
          onMouseDown={e => {
            if (e.button !== 0) return;
            mxDragged.current = false;
            mxDragStart.current = { y: e.clientY, h: mxOpen ? mxHeight : MX_HANDLE_H };
            document.body.style.userSelect = 'none';
            document.body.style.cursor = 'ns-resize';
            e.preventDefault();
          }}
        >
          <div className="mixer-grip"></div>
          <span className="mixer-handle-label">🎛️ Mixer</span>
          <div className="mixer-grip"></div>
        </div>
        {mxOpen && st && (
          <div className="mixer-body">

            {/* Col 1: Standby now playing */}
            <div className="col">
              <div className="card">
                <div className="queue-header" style={{ marginBottom: '0.9rem' }}>
                  <div className="card-label" style={{ marginBottom: 0 }}>Standby Music</div>
                  <button className="ghost" id="standby-settings-btn" style={{ fontSize: '0.75rem' }} onClick={openSsModal}>🎨 Customize Standby Screen</button>
                </div>
                <div id="standby-now-playing">
                  {!st.standbyPlaylistId ? (
                    <span className="np-idle">No playlist set</span>
                  ) : (
                    <div className="np-wrap">
                      {st.standbyTrack?.videoId
                        ? <img className="np-thumb" src={`https://img.youtube.com/vi/${st.standbyTrack.videoId}/hqdefault.jpg`} alt="" />
                        : st.standbyPlaylistThumbnail
                          ? <img className="np-thumb" src={st.standbyPlaylistThumbnail} alt="" />
                          : <div className="np-thumb np-thumb-placeholder">🎵</div>
                      }
                      <div className="np-info">
                        <div className="np-title">{st.standbyTrack?.title ?? st.standbyPlaylistTitle ?? st.standbyPlaylistId}</div>
                        <div className="np-singer">🎵 {st.standbyPlaylistTitle ?? 'Standby Music'}</div>
                        <div className="row">
                          <button className="secondary icon" disabled={!st.playerConnected} onClick={() => send({ type: st.standbyPaused ? 'standby-resume' : 'standby-pause' })}>
                            {st.standbyPaused ? '▶ Play' : '⏸ Pause'}
                          </button>
                          <button className="secondary icon" disabled={!st.playerConnected} onClick={() => send({ type: 'standby-skip' })}>⏭ Skip</button>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>
              {st.standbyPlaylistId && (
                <div className="card" id="standby-track-card">
                  <div className="queue-header">
                    <div className="card-label" style={{ marginBottom: 0 }}>
                      Playlist Tracks <span className="badge" id="standby-track-count">{mxTracks.length}</span>
                    </div>
                    <button className="ghost" id="clear-standby-btn" title="Clear standby playlist" style={{ fontSize: '0.75rem' }} onClick={() => send({ type: 'clear-standby' })}>Clear</button>
                  </div>
                  <ul className="queue" id="standby-track-list">
                    {mxTracks.map((t, i) => (
                      <li key={t.videoId} className={`qi${st.standbyTrack?.videoId === t.videoId ? ' qi-current' : ''}`}>
                        <span className="qi-num">{i + 1}</span>
                        <img className="qi-thumb" src={t.thumbnail || thumb(t.videoId)} alt="" loading="lazy" />
                        <div className="qi-info"><span className="qi-title">{t.title}</span></div>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>

            {/* Col 2: Standby playlist */}
            <div className="col">
              <div className="card">
                <div className="find-header">
                  <div className="card-label" style={{ marginBottom: 0 }}>Standby Playlist</div>
                  <div className="find-tab-toggle" id="mx-find-tab-toggle" data-tab={mxTab}>
                    <span className="find-tab-track"></span>
                    <button className="find-tab-btn" id="mx-tab-search" onClick={() => setMxTab('search')}>🔍 Search</button>
                    <button className="find-tab-btn" id="mx-tab-url" onClick={() => setMxTab('url')}>🔗 Paste URL</button>
                  </div>
                </div>
                <div id="mx-panel-search" style={mxTab === 'search' ? undefined : { display: 'none' }}>
                  <div className="row">
                    <input type="text" id="mx-search-input" value={mxSearchQ} onChange={e => setMxSearchQ(e.target.value)} onKeyDown={e => e.key === 'Enter' && mxDoSearch()} placeholder="Search for a playlist…" autoComplete="off" />
                    <button id="mx-search-btn" disabled={mxSearching} onClick={mxDoSearch}>{mxSearching ? '…' : 'Search'}</button>
                  </div>
                  {mxSearchStatus && <div id="mx-search-status" className="mixer-search-status">{mxSearchStatus}</div>}
                  <div id="mx-search-results">
                    {mxSearchResults.map(item => (
                      <div key={item.playlistId} className="sr-item">
                        <img className="sr-thumb" src={item.thumbnail} alt="" loading="lazy" />
                        <div className="sr-info">
                          <div className="sr-title">{item.title}</div>
                          <div className="sr-channel">{item.channelTitle}</div>
                        </div>
                        <button className="secondary" onClick={() => send({ type: 'set-standby-playlist', url: `https://www.youtube.com/playlist?list=${item.playlistId}`, title: item.title, thumbnail: item.thumbnail })}>Use</button>
                      </div>
                    ))}
                  </div>
                </div>
                <div id="mx-panel-url" style={mxTab === 'url' ? undefined : { display: 'none' }}>
                  <div className="add-form">
                    <div className="row">
                      <input type="url" id="mx-url-input" value={mxUrlInput} onChange={e => setMxUrlInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && mxUrlInput.trim()) { send({ type: 'set-standby-playlist', url: mxUrlInput.trim(), title: '', thumbnail: '' }); setMxUrlInput(''); } }} placeholder="Paste a YouTube playlist URL…" autoComplete="off" />
                      <button id="mx-set-btn" onClick={() => { if (mxUrlInput.trim()) { send({ type: 'set-standby-playlist', url: mxUrlInput.trim(), title: '', thumbnail: '' }); setMxUrlInput(''); } }}>Set</button>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Col 3: Volume faders */}
            <div className="col">
              <div className="card">
                <div className="card-label">Volume</div>
                <div className="fader-row">
                  <div className="fader-label-row">
                    <span>🎵 Standby Music</span>
                    <span className="fader-val" id="standby-vol-value">{st.standbyVolume}</span>
                  </div>
                  <input type="range" id="standby-vol-slider" className="fader" min="0" max="100" value={st.standbyVolume}
                    style={{ '--fader-fill': '#00695c', '--pct': st.standbyVolume } as React.CSSProperties}
                    onChange={e => { send({ type: 'set-standby-volume', volume: Number(e.target.value) }); e.currentTarget.style.setProperty('--pct', e.target.value); }} />
                  <div className="fader-hint">{st.playerIsIOS ? <span className="ios-vol-note">📱 iOS player — use device volume buttons</span> : 'Level when idle or between songs'}</div>
                </div>
                <div className="fader-row">
                  <div className="fader-label-row">
                    <span>🎤 Karaoke Video</span>
                    <span className="fader-val" id="video-vol-value">{st.videoVolume}</span>
                  </div>
                  <input type="range" id="video-vol-slider" className="fader" min="0" max="100" value={st.videoVolume}
                    style={{ '--fader-fill': '#283593', '--pct': st.videoVolume } as React.CSSProperties}
                    onChange={e => { send({ type: 'set-video-volume', volume: Number(e.target.value) }); e.currentTarget.style.setProperty('--pct', e.target.value); }} />
                  <div className="fader-hint">{st.playerIsIOS ? <span className="ios-vol-note">📱 iOS player — use device volume buttons</span> : 'Level during song playback'}</div>
                </div>
                <div className="fader-row">
                  <div className="fader-label-row">
                    <span className="fader-mic-label">
                      <label className="toggle-switch" title="Mute microphone">
                        <input type="checkbox" id="mic-mute-btn" checked={!micMuted} disabled={!micReady} onChange={() => send({ type: 'mic-mute', muted: !micMuted })} />
                        <span className="toggle-track"></span>
                      </label>
                      🎙️ Microphone
                      <span className={`status-dot-sm${micReady && !micMuted ? ' on' : ''}`} id="mic-status-dot"></span>
                    </span>
                    <span className="fader-val" id="mic-vol-value">{micVol}</span>
                  </div>
                  <input type="range" id="mic-vol-slider" className="fader" min="0" max="100" value={micVol} disabled={!micReady}
                    style={{ '--fader-fill': '#880e4f', '--pct': micVol } as React.CSSProperties}
                    onChange={e => { send({ type: 'set-mic-volume', volume: Number(e.target.value) }); applyMicGain(Number(e.target.value), micMuted); e.currentTarget.style.setProperty('--pct', e.target.value); }} />
                  <div className="vu-meter" id="mic-vu-meter">
                    {Array.from({ length: VU_DOTS }, (_, i) => (
                      <span key={i} className={`vu-dot ${i < 15 ? 'vu-green' : i < 19 ? 'vu-yellow' : 'vu-red'}${(i <= vuLevel || (i === vuPeak && vuPeak > vuLevel)) ? ' lit' : ''}${(i === vuPeak && vuPeak > vuLevel) ? ' peak' : ''}`} />
                    ))}
                  </div>
                  <div className="fader-hint" id="mic-hint">
                    {micReady === null ? 'Awaiting player…' : micReady === false ? 'Permission denied or unavailable' : micMuted ? 'Muted' : 'Active'}
                  </div>
                </div>
              </div>
            </div>

          </div>
        )}
      </div>

      {/* ── Singer modal ── */}
      {singerModal && (
        <div id="singer-modal" className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) closeSinger(); }}>
          <div className="modal">
            <div className="modal-song" id="modal-song">{singerModal.title}</div>
            <div className="modal-heading">🎤 Who's singing?</div>
            <input type="text" id="singer-input" value={singerName} autoFocus autoComplete="off"
              onChange={e => setSingerName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') confirmSinger(); if (e.key === 'Escape') closeSinger(); }}
              placeholder="Singer's name (optional)" />
            <div className="modal-actions">
              <button className="secondary" id="modal-skip" onClick={closeSinger}>Cancel</button>
              <button id="modal-confirm" onClick={confirmSinger}>Add to queue</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Stream Deck setup modal ── */}
      {showSdModal && sessionId && (
        <div id="sd-modal" className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) setShowSdModal(false); }}>
          <div className="modal">
            <div className="modal-heading">🎮 Stream Deck Setup</div>
            <p className="req-link-label">Enter these values once in the plugin's property inspector — all buttons share the same connection.</p>
            <p className="req-link-label" style={{ marginTop: '0.5rem' }}>Server URL</p>
            <div className="req-link-controls">
              <input id="sd-server-url" type="text" readOnly className="req-link-url" autoComplete="off" value={location.origin} />
              <button className="btn-copy-link" id="sd-copy-url" onClick={e => { navigator.clipboard?.writeText(location.origin); const b = e.currentTarget, t = b.textContent; b.textContent = 'Copied!'; setTimeout(() => { b.textContent = t; }, 1200); }}>Copy</button>
            </div>
            <p className="req-link-label">Session ID</p>
            <div className="req-link-controls">
              <input id="sd-session-id" type="text" readOnly className="req-link-url" autoComplete="off" value={sessionId} />
              <button className="btn-copy-link" id="sd-copy-sid" onClick={e => { navigator.clipboard?.writeText(sessionId); const b = e.currentTarget, t = b.textContent; b.textContent = 'Copied!'; setTimeout(() => { b.textContent = t; }, 1200); }}>Copy</button>
            </div>
            <div className="modal-actions">
              <button className="ghost" id="sd-modal-close" onClick={() => setShowSdModal(false)}>Close</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Kiosk / request link modal ── */}
      {kioskLinkModal && (
        <div id="kiosk-link-modal" className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) setKioskLinkModal(false); }}>
          <div className="modal">
            <div className="modal-heading" id="kiosk-link-heading">🏠 Kiosk Link</div>
            <p className="req-link-label" id="kiosk-link-hint">Open this on a device to request songs. In kiosk mode, any number of devices can use the same link.</p>
            <div className="req-link-controls">
              <input id="kiosk-link-url-input" type="text" readOnly className="req-link-url" autoComplete="off" value={requestUrl} />
              <button className="btn-copy-link" id="kiosk-link-copy" onClick={e => { navigator.clipboard?.writeText(requestUrl); const b = e.currentTarget, t = b.textContent; b.textContent = 'Copied!'; setTimeout(() => { b.textContent = t; }, 1200); }}>Copy</button>
              <a id="kiosk-link-open" className="btn-copy-link" href={requestUrl} target="_blank" rel="noopener noreferrer">Open ↗</a>
            </div>
            <p className="req-link-label">Use this QR code to open the song request form on another device.</p>
            {kioskLinkQr && <img id="kiosk-link-qr" className="req-link-qr" src={kioskLinkQr} alt="Kiosk QR code" />}
            <div className="modal-actions">
              <button className="ghost" id="kiosk-link-close" onClick={() => setKioskLinkModal(false)}>Close</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Display page link modal ── */}
      {reqLinkModal && (
        <div id="req-link-modal" className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) setReqLinkModal(false); }}>
          <div className="modal">
            <div className="modal-heading" id="req-link-heading">📺 Crowd QR Display</div>
            <p className="req-link-label" id="req-link-hint">Show this page on a screen at your venue so guests can scan the QR code to request songs.</p>
            <div className="req-link-controls">
              <input id="req-link-url-input" type="text" readOnly className="req-link-url" autoComplete="off" value={displayUrl} />
              <button className="btn-copy-link" id="req-link-copy" onClick={e => { navigator.clipboard?.writeText(displayUrl); const b = e.currentTarget, t = b.textContent; b.textContent = 'Copied!'; setTimeout(() => { b.textContent = t; }, 1200); }}>Copy</button>
              <a id="req-link-open" className="btn-copy-link" href={displayUrl} target="_blank" rel="noopener noreferrer">Open ↗</a>
            </div>
            <p className="req-link-label">Use this QR code to open the crowd QR display on another device.</p>
            {reqLinkQr && <img id="req-link-qr" className="req-link-qr" src={reqLinkQr} alt="Crowd QR Display code" />}
            <div className="modal-actions">
              <button className="ghost" id="req-link-close" onClick={() => setReqLinkModal(false)}>Close</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Devices modal ── */}
      {showDevices && st && (
        <div id="devices-modal" className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) setShowDevices(false); }}>
          <div className="modal">
            <div className="modal-heading">🔧 Connected Devices</div>

            <div className="dm-section">
              <div className="dm-row">
                <div>
                  <div className="dm-label" id="dm-requester-label">{st.requestMode === 'kiosk' ? 'Kiosks' : 'Requestors'}</div>
                  <div className="dm-hint">Reset if the count looks stuck after a device closed without a clean disconnect.</div>
                </div>
                <span className="dm-count" id="dm-requester-count">{st.requesterCount}</span>
                <button className="ghost dm-btn" id="dm-reset-btn" title="Recalculate from live connections" onClick={() => send({ type: 'reset-requester-presence' })}>↺ Reset</button>
              </div>
            </div>

            {st.requestMode === 'crowd' && (
              <div className="dm-section" id="dm-banned-section">
                <div className="dm-row">
                  <div className="dm-label">Banned Devices</div>
                  <span className="dm-count" id="dm-banned-count">{st.bannedCount}</span>
                  <button className="ghost dm-btn" id="dm-unban-btn" disabled={!(st.bannedCount > 0)} onClick={() => send({ type: 'unban-all-devices' })}>🔓 Unban all</button>
                </div>
              </div>
            )}

            {st.requestMode === 'crowd' && (
              <div className="dm-section" id="dm-blocked-section">
                <div className="dm-row">
                  <div className="dm-label">Waiting</div>
                  <span className="dm-count" id="dm-blocked-count">{st.blockedCount}</span>
                  <button className="ghost dm-btn" id="dm-unblock-btn" disabled={!(st.blockedCount > 0)} onClick={() => send({ type: 'clear-blocked-devices' })}>↺ Unblock all</button>
                </div>
              </div>
            )}

            <div className="modal-actions">
              <button className="ghost" id="devices-modal-close" onClick={() => setShowDevices(false)}>Close</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Standby settings modal ── */}
      {showSsModal && (
        <div id="standby-settings-modal" className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) setShowSsModal(false); }}>
          <div className="modal" style={{ width: 'min(580px,calc(100vw - 2rem))' }}>
            <div className="modal-heading">🖥️ Standby Screen</div>

            <label className="ss-label">Title</label>
            <input type="text" id="ss-title" maxLength={80} placeholder="Karaoke Browser" autoComplete="off" value={ssTitle} onChange={e => setSsTitle(e.target.value)} />
            <select id="ss-title-font" className="ss-font-select" value={ssTitleFont} onChange={e => setSsTitleFont(e.target.value)}>
              <FontOptions />
            </select>
            <div className="ss-size-row">
              <div className="ss-size-field">
                <span>Size</span>
                <input type="number" id="ss-title-size" min={1} max={500} step={1} placeholder="auto" value={ssTitleSize || ''} onChange={e => setSsTitleSize(Number(e.target.value) || 0)} />
                <span>px</span>
              </div>
              <div className="ss-size-field">
                <span>Outline</span>
                <input type="number" id="ss-title-outline-size" min={0} max={50} step={1} value={ssTitleOSize} onChange={e => setSsTitleOSize(Number(e.target.value) || 0)} />
                <span>px</span>
              </div>
            </div>
            <label className="ss-label">Title Colors</label>
            <div className="ss-color-preview-row">
              <div className="ss-colors">
                <label className="ss-color-swatch">
                  <input type="color" id="ss-title-color" value={ssTitleColor} onChange={e => setSsTitleColor(e.target.value)} />
                  <span>Text</span>
                </label>
                <label className="ss-color-swatch">
                  <input type="color" id="ss-title-outline" value={ssTitleOutline} onChange={e => setSsTitleOutline(e.target.value)} />
                  <span>Outline</span>
                </label>
              </div>
              <div className="ss-preview" id="ss-title-preview">
                <div className="ss-preview-bg" id="ss-preview-bg-title" style={Object.fromEntries(ssColors.map((c, i) => [`--sc${i + 1}`, c])) as React.CSSProperties}></div>
                <span className="ss-preview-text" id="ss-title-preview-text" style={{
                  fontFamily: parseFont(ssTitleFont).family || undefined,
                  fontWeight: (parseFont(ssTitleFont).weight || undefined) as React.CSSProperties['fontWeight'],
                  fontSize: ssTitleSize > 0 ? Math.min(ssTitleSize, 48) + 'px' : '2rem',
                  color: ssTitleColor,
                  WebkitTextStroke: ssTitleOSize > 0 ? `${Math.min(ssTitleOSize, 6)}px ${ssTitleOutline}` : undefined,
                }}>{ssTitle.trim() || 'Karaoke Browser'}</span>
              </div>
            </div>

            <label className="ss-label">Subtitle <span style={{ color: 'var(--muted)', fontWeight: 400 }}>(optional)</span></label>
            <input type="text" id="ss-subtitle" maxLength={120} placeholder="Your karaoke night command center" autoComplete="off" value={ssSub} onChange={e => setSsSub(e.target.value)} />
            <select id="ss-subtitle-font" className="ss-font-select" value={ssSubFont} onChange={e => setSsSubFont(e.target.value)}>
              <FontOptions />
            </select>
            <div className="ss-size-row">
              <div className="ss-size-field">
                <span>Size</span>
                <input type="number" id="ss-subtitle-size" min={1} max={500} step={1} placeholder="auto" value={ssSubSize || ''} onChange={e => setSsSubSize(Number(e.target.value) || 0)} />
                <span>px</span>
              </div>
              <div className="ss-size-field">
                <span>Outline</span>
                <input type="number" id="ss-subtitle-outline-size" min={0} max={50} step={1} value={ssSubOSize} onChange={e => setSsSubOSize(Number(e.target.value) || 0)} />
                <span>px</span>
              </div>
            </div>
            <label className="ss-label">Subtitle Colors</label>
            <div className="ss-color-preview-row">
              <div className="ss-colors">
                <label className="ss-color-swatch">
                  <input type="color" id="ss-subtitle-color" value={ssSubColor} onChange={e => setSsSubColor(e.target.value)} />
                  <span>Text</span>
                </label>
                <label className="ss-color-swatch">
                  <input type="color" id="ss-subtitle-outline" value={ssSubOutline} onChange={e => setSsSubOutline(e.target.value)} />
                  <span>Outline</span>
                </label>
              </div>
              <div className="ss-preview" id="ss-subtitle-preview">
                <div className="ss-preview-bg" id="ss-preview-bg-subtitle" style={Object.fromEntries(ssColors.map((c, i) => [`--sc${i + 1}`, c])) as React.CSSProperties}></div>
                <span className="ss-preview-text" id="ss-subtitle-preview-text" style={{
                  fontFamily: parseFont(ssSubFont).family || undefined,
                  fontWeight: (parseFont(ssSubFont).weight || undefined) as React.CSSProperties['fontWeight'],
                  fontSize: ssSubSize > 0 ? Math.min(ssSubSize, 36) + 'px' : '1.5rem',
                  color: ssSubColor,
                  WebkitTextStroke: ssSubOSize > 0 ? `${Math.min(ssSubOSize, 4)}px ${ssSubOutline}` : undefined,
                }}>{ssSub.trim() || 'Subtitle'}</span>
              </div>
            </div>

            <label className="ss-label">Background Colors</label>
            <div className="ss-colors">
              {ssColors.map((c, i) => (
                <label key={i} className="ss-color-swatch">
                  <input type="color" id={`ss-color${i + 1}`} value={c} onChange={e => setSsColors(col => col.map((v, j) => j === i ? e.target.value : v))} />
                  <span>{i + 1}</span>
                </label>
              ))}
            </div>
            <div className="modal-actions">
              <button className="ghost" id="ss-cancel" onClick={() => setShowSsModal(false)}>Cancel</button>
              <button id="ss-save" onClick={saveSs}>Save</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
