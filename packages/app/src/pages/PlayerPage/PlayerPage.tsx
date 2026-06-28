import { useEffect, useRef, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSession } from '../../context/SessionContext.tsx';
import type { StateMessage } from '@karaoke-browser/shared';
import './PlayerPage.css';

// Augment the YT global (injected at runtime)
declare global {
  interface Window {
    YT: {
      Player: new (el: string | HTMLElement, opts: unknown) => YTPlayer;
      PlayerState: { PLAYING: number; ENDED: number; PAUSED: number };
    };
    onYouTubeIframeAPIReady: () => void;
  }
}
interface YTPlayer {
  loadVideoById(id: string): void;
  stopVideo(): void;
  playVideo(): void;
  pauseVideo(): void;
  nextVideo(): void;
  setVolume(v: number): void;
  getVolume(): number;
  mute(): void;
  unMute(): void;
  loadPlaylist(opts: { listType: string; list: string; index: number }): void;
  getVideoData(): { video_id?: string; title?: string };
  destroy(): void;
}

function parseFont(v: string | undefined) {
  if (!v) return { family: '', weight: '' };
  const sep = v.indexOf('|');
  return sep === -1 ? { family: v, weight: '' } : { family: v.slice(0, sep), weight: v.slice(sep + 1) };
}

export default function PlayerPage() {
  const { sessionId } = useSession();
  const navigate = useNavigate();

  useEffect(() => {
    document.title = 'Karaoke Player';
    const icon = document.querySelector<HTMLLinkElement>("link[rel='icon']");
    if (icon) icon.href = `data:image/svg+xml,${encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>📺</text></svg>")}`;
  }, []);

  // ── Mobile / tablet hardening ───────────────────────────────────────────
  useEffect(() => {
    // Lock the viewport so pinch-zoom can't break the fixed layout
    const viewport = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
    const prevContent = viewport?.content;
    if (viewport) viewport.content = 'width=device-width, initial-scale=1.0, user-scalable=no';
    // Allow standalone (full-screen) mode when added to the home screen
    const appleMeta = Object.assign(document.createElement('meta'), { name: 'apple-mobile-web-app-capable', content: 'yes' });
    const webMeta   = Object.assign(document.createElement('meta'), { name: 'mobile-web-app-capable',       content: 'yes' });
    document.head.append(appleMeta, webMeta);
    return () => {
      if (viewport && prevContent !== undefined) viewport.content = prevContent;
      appleMeta.remove();
      webMeta.remove();
    };
  }, []);

  // ── Screen wake lock — keeps the display on during karaoke ─────────────
  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wl = (navigator as any).wakeLock as { request(t: string): Promise<{ release(): void }> } | undefined;
    if (!wl) return;
    let lock: { release(): void } | null = null;
    const acquire = () => wl.request('screen').then(l => { lock = l; }).catch(() => {});
    const onVisible = () => { if (document.visibilityState === 'visible') void acquire(); };
    void acquire();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      lock?.release();
    };
  }, []);

  useEffect(() => {
    if (!sessionId) navigate('/?redirect=/player');
  }, [sessionId, navigate]);

  // ── Refs for mutable imperative state ──────────────────────────────────
  const ytRef           = useRef<YTPlayer | null>(null);
  const standbyRef      = useRef<YTPlayer | null>(null);
  const wsRef           = useRef<WebSocket | null>(null);
  const wsTimer         = useRef<ReturnType<typeof setTimeout> | null>(null);

  const currentVideoId    = useRef<string | null>(null);
  const currentTitle      = useRef('');
  const currentSinger     = useRef('');
  const embedFailed       = useRef(false);
  const shouldPauseOnPlay = useRef(false);
  const showingSlate      = useRef(false);
  const userActivated     = useRef(false);
  const controllerReady   = useRef(false);
  const hideSlateTimer    = useRef<ReturnType<typeof setTimeout> | null>(null);
  const slateInHandler    = useRef<((e: TransitionEvent) => void) | null>(null);
  const requestModeRef    = useRef<string | null>(null);
  const slateQrLoaded     = useRef(false);
  const playerModeRef     = useRef('karaoke');

  const currentPlaylistId = useRef<string | null>(null);
  const pendingPlaylistId = useRef<string | null>(null);
  const pendingVideoId    = useRef<string | null>(null);
  const standbyFadeTimer  = useRef<ReturnType<typeof setInterval> | null>(null);
  const standbyTargetVol  = useRef(75);
  const videoTargetVol    = useRef(100);
  const fadeDurationMs    = useRef(1500);

  // ── React visible state (UI triggers) ────────────────────────────────────
  const [displaced, setDisplaced] = useState(false);
  const [gateVisible, setGateVisible] = useState(true);
  const [gateFading, setGateFading]   = useState(false);
  const [controllerDot, setControllerDot] = useState(false);
  const [btnVisible, setBtnVisible]   = useState(true);

  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Fullscreen idle button ─────────────────────────────────────────────
  useEffect(() => {
    const show = () => {
      setBtnVisible(true);
      if (hideTimer.current) clearTimeout(hideTimer.current);
      hideTimer.current = setTimeout(() => setBtnVisible(false), 3000);
    };
    document.addEventListener('mousemove', show);
    document.addEventListener('touchstart', show, { passive: true });
    show();
    return () => {
      document.removeEventListener('mousemove', show);
      document.removeEventListener('touchstart', show);
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, []);

  // ── Standby helpers ────────────────────────────────────────────────────
  const fadeStandbyVolume = useCallback((target: number) => {
    if (!standbyRef.current) return;
    if (standbyFadeTimer.current) { clearInterval(standbyFadeTimer.current); standbyFadeTimer.current = null; }
    const start = standbyRef.current.getVolume?.() ?? 0;
    const steps = 30;
    const stepMs = Math.max(16, fadeDurationMs.current / steps);
    let step = 0;
    standbyFadeTimer.current = setInterval(() => {
      step++;
      const v = Math.round(start + (target - start) * (step / steps));
      standbyRef.current?.setVolume(Math.max(0, Math.min(100, v)));
      if (step >= steps) { clearInterval(standbyFadeTimer.current!); standbyFadeTimer.current = null; }
    }, stepMs);
  }, []);

  const loadStandbyPlaylist = useCallback((id: string) => {
    if (!standbyRef.current) { pendingPlaylistId.current = id; return; }
    currentPlaylistId.current = id;
    pendingPlaylistId.current = null;
    standbyRef.current.setVolume(0);
    standbyRef.current.loadPlaylist({ listType: 'playlist', list: id, index: 0 });
    standbyRef.current.playVideo();
    if (userActivated.current) {
      standbyRef.current.unMute(); // iOS: muted autoplay is permitted; unmute now that user has activated
      fadeStandbyVolume(standbyTargetVol.current);
    }
  }, [fadeStandbyVolume]);

  const stopStandby = useCallback(() => {
    if (standbyFadeTimer.current) { clearInterval(standbyFadeTimer.current); standbyFadeTimer.current = null; }
    currentPlaylistId.current = null;
    pendingPlaylistId.current = null;
    standbyRef.current?.setVolume(0);
    standbyRef.current?.stopVideo?.();
  }, []);

  // ── Gate helpers ──────────────────────────────────────────────────────────
  const maybeShowGate = useCallback(() => {
    if (!userActivated.current || controllerReady.current || currentVideoId.current || playerModeRef.current === 'standby') return;
    setGateVisible(true);
    setGateFading(false);
  }, []);

  const updateGateStatus = useCallback((connected: boolean) => {
    controllerReady.current = connected;
    setControllerDot(connected);
    if (userActivated.current) {
      if (!connected) { maybeShowGate(); }
      else {
        setGateFading(true);
        setTimeout(() => setGateVisible(false), 450);
      }
    }
  }, [maybeShowGate]);

  // ── Slate helpers ──────────────────────────────────────────────────────────
  const hideSlate = useCallback((callback: (() => void) | null) => {
    if (hideSlateTimer.current) { clearTimeout(hideSlateTimer.current); hideSlateTimer.current = null; }
    fadeStandbyVolume(0);
    const slate = document.getElementById('singer-slate');
    const idle  = document.getElementById('idle');
    if (idle) { idle.classList.remove('visible'); idle.style.display = 'none'; }
    if (slate) slate.classList.remove('visible');
    hideSlateTimer.current = setTimeout(() => {
      hideSlateTimer.current = null;
      if (slate) slate.style.display = 'none';
      showingSlate.current = false;
      if (callback) callback();
    }, 560);
  }, [fadeStandbyVolume]);

  const showSlate = useCallback(() => {
    if (hideSlateTimer.current) { clearTimeout(hideSlateTimer.current); hideSlateTimer.current = null; }
    showingSlate.current = true;
    fadeStandbyVolume(standbyTargetVol.current);
    const slate = document.getElementById('singer-slate');
    const crowd = requestModeRef.current === 'crowd';
    const eyebrow = document.getElementById('slate-eyebrow');
    const singer  = document.getElementById('slate-singer');
    const title   = document.getElementById('slate-title');
    if (eyebrow) eyebrow.textContent = currentSinger.current ? 'Now Singing' : 'Up Next';
    if (singer)  { singer.textContent = currentSinger.current; singer.style.display = currentSinger.current ? '' : 'none'; }
    if (title)   title.textContent = currentTitle.current;
    if (slate) {
      slate.style.display = crowd ? 'grid' : 'flex';
      requestAnimationFrame(() => requestAnimationFrame(() => slate.classList.add('visible')));
    }
  }, [fadeStandbyVolume]);

  const showEmbedError = useCallback((videoId: string) => {
    embedFailed.current = true;
    shouldPauseOnPlay.current = false;
    showingSlate.current = false;
    hideSlate(null);
    fadeStandbyVolume(standbyTargetVol.current);
    ytRef.current?.stopVideo?.();
    const thumbEl = document.getElementById('embed-thumb') as HTMLImageElement | null;
    const titleEl = document.getElementById('embed-title');
    const errEl   = document.getElementById('embed-error');
    if (thumbEl) thumbEl.src = `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`;
    if (titleEl) titleEl.textContent = currentTitle.current;
    if (errEl)   errEl.style.display = 'flex';
  }, [hideSlate, fadeStandbyVolume]);

  const showIdle = useCallback(() => {
    if (currentVideoId.current && ytRef.current) ytRef.current.stopVideo?.();
    currentVideoId.current = null;
    embedFailed.current = false;
    shouldPauseOnPlay.current = false;
    showingSlate.current = false;
    hideSlate(null);
    maybeShowGate();
    if (userActivated.current) {
      if (pendingPlaylistId.current) { const pid = pendingPlaylistId.current; pendingPlaylistId.current = null; loadStandbyPlaylist(pid); }
      else fadeStandbyVolume(standbyTargetVol.current);
    }
    const idle = document.getElementById('idle');
    if (idle) {
      idle.style.display = requestModeRef.current === 'crowd' ? 'grid' : 'flex';
      requestAnimationFrame(() => requestAnimationFrame(() => idle.classList.add('visible')));
    }
    const errEl = document.getElementById('embed-error');
    if (errEl) errEl.style.display = 'none';
  }, [hideSlate, maybeShowGate, loadStandbyPlaylist, fadeStandbyVolume]);

  const loadVideo = useCallback((videoId: string) => {
    if (!userActivated.current) { pendingVideoId.current = videoId; return; }
    embedFailed.current = false;
    shouldPauseOnPlay.current = true;
    currentVideoId.current = videoId;
    const errEl = document.getElementById('embed-error');
    if (errEl) errEl.style.display = 'none';
    showSlate();
    const slate = document.getElementById('singer-slate');
    if (slateInHandler.current) { slate?.removeEventListener('transitionend', slateInHandler.current); slateInHandler.current = null; }
    const doLoad = () => {
      if (ytRef.current) {
        ytRef.current.setVolume(videoTargetVol.current);
        ytRef.current.loadVideoById(videoId);
      } else {
        pendingVideoId.current = videoId;
      }
    };
    if (slate?.classList.contains('visible')) {
      doLoad();
    } else {
      slateInHandler.current = (e: TransitionEvent) => {
        if (e.propertyName !== 'opacity' || !slate?.classList.contains('visible')) return;
        slate?.removeEventListener('transitionend', slateInHandler.current!);
        slateInHandler.current = null;
        doLoad();
      };
      slate?.addEventListener('transitionend', slateInHandler.current);
    }
  }, [showSlate]);

  // ── QR loader ─────────────────────────────────────────────────────────────
  const loadSlateQR = useCallback(() => {
    if (slateQrLoaded.current || !sessionId) return;
    const reqUrl = `${location.origin}/request?s=${encodeURIComponent(sessionId)}`;
    document.querySelectorAll('.scq-url').forEach((el: Element) => { (el as HTMLElement).textContent = reqUrl; });
    fetch(`/api/qr?s=${encodeURIComponent(sessionId)}&data=${encodeURIComponent(reqUrl)}`)
      .then(r => r.ok ? r.json() : null)
      .then((d: { dataUrl?: string } | null) => {
        if (d?.dataUrl) {
          document.querySelectorAll<HTMLImageElement>('.scq-img').forEach(el => { el.src = d.dataUrl!; });
          slateQrLoaded.current = true;
        }
      }).catch(() => {});
  }, [sessionId]);

  const applySlateQR = useCallback(() => {
    const crowd = requestModeRef.current === 'crowd';
    document.getElementById('idle')?.classList.toggle('crowd', crowd);
    document.getElementById('singer-slate')?.classList.toggle('crowd', crowd);
    if (crowd) loadSlateQR();
  }, [loadSlateQR]);

  // ── Standby display update ────────────────────────────────────────────────
  const updateStandbyDisplay = useCallback((msg: StateMessage) => {
    const titleEl    = document.getElementById('standby-title-el');
    const subtitleEl = document.getElementById('standby-subtitle-el');
    const bgEl       = document.getElementById('standby-bg');
    if (titleEl) {
      titleEl.textContent = msg.standbyTitle || 'Karaoke Browser';
      titleEl.style.color = msg.standbyTitleColor || '#ffffff';
      const tf = parseFont(msg.standbyTitleFont);
      titleEl.style.fontFamily = tf.family;
      titleEl.style.fontWeight = tf.weight;
      titleEl.style.fontSize = (msg.standbyTitleSize ?? 0) > 0 ? `${msg.standbyTitleSize}px` : '';
      const tSz = msg.standbyTitleOutlineSize ?? 20;
      (titleEl.style as unknown as Record<string, string>).webkitTextStroke = tSz > 0 ? `${tSz}px ${msg.standbyTitleOutline || '#000000'}` : '';
      const root = document.documentElement;
      root.style.setProperty('--scq-heading-color', msg.standbyTitleColor || '#ffffff');
      root.style.setProperty('--scq-heading-stroke', tSz > 0 ? `${Math.ceil(tSz / 2)}px ${msg.standbyTitleOutline || '#000000'}` : '0px transparent');
    }
    if (subtitleEl) {
      subtitleEl.textContent = msg.standbySubtitle ?? 'Your karaoke night command center';
      subtitleEl.hidden = msg.standbySubtitle === '';
      subtitleEl.style.color = msg.standbySubtitleColor || '#ffffff';
      const sf = parseFont(msg.standbySubtitleFont);
      subtitleEl.style.fontFamily = sf.family;
      subtitleEl.style.fontWeight = sf.weight;
      subtitleEl.style.fontSize = (msg.standbySubtitleSize ?? 0) > 0 ? `${msg.standbySubtitleSize}px` : '';
      const sSz = msg.standbySubtitleOutlineSize ?? 8;
      (subtitleEl.style as unknown as Record<string, string>).webkitTextStroke = sSz > 0 ? `${sSz}px ${msg.standbySubtitleOutline || '#000000'}` : '';
      const root = document.documentElement;
      root.style.setProperty('--scq-sub-color', msg.standbySubtitleColor || '#ffffff');
      root.style.setProperty('--scq-sub-stroke', sSz > 0 ? `${Math.ceil(sSz / 2)}px ${msg.standbySubtitleOutline || '#000000'}` : '0px transparent');
    }
    if (bgEl && Array.isArray(msg.standbyColors)) {
      const defs = ['#4cc9f0', '#4361ee', '#7c3aed', '#f72585', '#ff6b35', '#ffd166', '#06d6a0', '#3a0ca3'];
      msg.standbyColors.forEach((c: string, i: number) => {
        const val = c || defs[i] || defs[0];
        bgEl.style.setProperty(`--sc${i + 1}`, val);
        document.documentElement.style.setProperty(`--sc${i + 1}`, val);
      });
    }
  }, []);

  // ── WebSocket ──────────────────────────────────────────────────────────────
  const connect = useCallback(() => {
    if (!sessionId) return;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/ws?role=player&s=${encodeURIComponent(sessionId)}`);
    wsRef.current = ws;

    ws.onopen = () => {
      const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
        (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
      ws.send(JSON.stringify({ type: 'player-ios', isIOS: ios }));
    };

    ws.onmessage = (event: MessageEvent<string>) => {
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(event.data) as Record<string, unknown>; } catch { return; }

      if (msg['type'] === 'restart') {
        if (currentVideoId.current) loadVideo(currentVideoId.current);
        return;
      }
      if (msg['type'] === 'standby-skip') { standbyRef.current?.nextVideo?.(); return; }
      if (msg['type'] === 'standby-pause') { standbyRef.current?.pauseVideo?.(); return; }
      if (msg['type'] === 'standby-resume') { standbyRef.current?.playVideo?.(); return; }

      if (msg['type'] === 'state') {
        const state = msg as unknown as StateMessage;
        updateGateStatus(!!state.controllerConnected);

        if (state.requestMode !== undefined && state.requestMode !== requestModeRef.current) {
          requestModeRef.current = state.requestMode;
          applySlateQR();
        }

        if (typeof state.standbyVolume  === 'number') {
          standbyTargetVol.current = state.standbyVolume;
          if (userActivated.current && currentPlaylistId.current && !currentVideoId.current)
            fadeStandbyVolume(standbyTargetVol.current);
        }
        if (typeof state.videoVolume    === 'number') {
          videoTargetVol.current = state.videoVolume;
          if (ytRef.current && currentVideoId.current) ytRef.current.setVolume(videoTargetVol.current);
        }
        if (typeof state.fadeDuration   === 'number') fadeDurationMs.current = state.fadeDuration;

        const incomingPlaylist = state.standbyPlaylistId ?? null;
        if (incomingPlaylist !== currentPlaylistId.current) {
          if (incomingPlaylist) loadStandbyPlaylist(incomingPlaylist);
          else stopStandby();
        }

        playerModeRef.current = state.playerMode || 'karaoke';
        updateStandbyDisplay(state);

        if (playerModeRef.current === 'standby') {
          if (currentVideoId.current) {
            ytRef.current?.stopVideo?.();
            currentVideoId.current = null;
            embedFailed.current = false;
            shouldPauseOnPlay.current = false;
            showingSlate.current = false;
            hideSlate(null);
            const errEl = document.getElementById('embed-error');
            if (errEl) errEl.style.display = 'none';
          }
          const idleEl = document.getElementById('idle');
          if (!idleEl?.style.display || idleEl.style.display === 'none') showIdle();

        } else if (state.nowPlaying) {
          currentTitle.current  = state.nowPlaying.title  || '';
          currentSinger.current = state.nowPlaying.singer || '';
          if (state.nowPlaying.videoId !== currentVideoId.current) {
            loadVideo(state.nowPlaying.videoId);
          } else if (!embedFailed.current) {
            if (showingSlate.current && !state.paused) {
              hideSlate(() => { ytRef.current?.playVideo?.(); });
            } else if (!showingSlate.current) {
              if (state.paused) ytRef.current?.pauseVideo?.();
              else ytRef.current?.playVideo?.();
            }
          }
        } else {
          showIdle();
        }
      }
    };

    ws.onclose = (event: CloseEvent) => {
      if (event.code === 4410) {
        setDisplaced(true);
        return;
      }
      wsTimer.current = setTimeout(connect, 3000);
    };
  }, [sessionId, loadVideo, updateGateStatus, applySlateQR, fadeStandbyVolume, loadStandbyPlaylist, stopStandby, updateStandbyDisplay, hideSlate, showIdle]);

  // ── YouTube IFrame API injection ──────────────────────────────────────────
  useEffect(() => {
    if (!sessionId) return;

    // Inject YT script if not already present
    if (!document.querySelector('script[src*="youtube.com/iframe_api"]')) {
      const s = document.createElement('script');
      s.src = 'https://www.youtube.com/iframe_api';
      document.head.appendChild(s);
    }

    window.onYouTubeIframeAPIReady = () => {
      ytRef.current = new window.YT.Player('yt-player', {
        width: '100%', height: '100%',
        playerVars: { autoplay: 1, controls: 0, rel: 0, modestbranding: 1, iv_load_policy: 3, showinfo: 0, cc_load_policy: 0, fs: 0, disablekb: 1, playsinline: 1 },
        events: {
          onReady: () => {
            // Mute via API rather than playerVar so iOS doesn't enter "muted-embed" mode,
            // which causes Error 153 on some videos. unMute() is called in handleGateTap.
            ytRef.current?.mute();
            if (pendingVideoId.current && userActivated.current) {
              const vid = pendingVideoId.current; pendingVideoId.current = null; loadVideo(vid);
            }
          },
          onStateChange: (e: { data: number }) => {
            if (e.data === window.YT.PlayerState.PLAYING && shouldPauseOnPlay.current) {
              const vid = ytRef.current?.getVideoData?.().video_id;
              if (vid && vid !== currentVideoId.current) return;
              shouldPauseOnPlay.current = false;
              ytRef.current?.pauseVideo();
              wsRef.current?.send(JSON.stringify({ type: 'pause' }));
            }
            if (e.data === window.YT.PlayerState.ENDED && currentVideoId.current) {
              wsRef.current?.send(JSON.stringify({ type: 'video-ended' }));
            }
          },
          onError: (e: { data: number }) => {
            if (e.data === 100 || e.data === 101 || e.data === 150) {
              if (currentVideoId.current) showEmbedError(currentVideoId.current);
              wsRef.current?.send(JSON.stringify({ type: 'video-error', code: e.data }));
            }
          },
        },
      });

      standbyRef.current = new window.YT.Player('standby-player', {
        width: '1', height: '1',
        playerVars: { autoplay: 1, controls: 0, loop: 1, fs: 0, disablekb: 1, playsinline: 1, rel: 0 },
        events: {
          onReady: () => {
            standbyRef.current?.mute();
            standbyRef.current?.setVolume(0);
            if (pendingPlaylistId.current) { const pid = pendingPlaylistId.current; pendingPlaylistId.current = null; loadStandbyPlaylist(pid); }
          },
          onStateChange: (e: { data: number }) => {
            if (e.data === 1) {
              const data = standbyRef.current?.getVideoData?.();
              if (data?.video_id && wsRef.current?.readyState === WebSocket.OPEN) {
                wsRef.current.send(JSON.stringify({ type: 'standby-track', videoId: data.video_id, title: data.title || '' }));
              }
            }
            if (e.data === 0 && currentPlaylistId.current) {
              standbyRef.current?.loadPlaylist({ listType: 'playlist', list: currentPlaylistId.current, index: 0 });
              standbyRef.current?.playVideo();
            }
          },
          onError: () => { /* skip */ },
        },
      });
    };

    connect();

    return () => {
      wsRef.current?.close();
      if (wsTimer.current) clearTimeout(wsTimer.current);
      if (hideSlateTimer.current) clearTimeout(hideSlateTimer.current);
      if (standbyFadeTimer.current) clearInterval(standbyFadeTimer.current);
      ytRef.current?.destroy?.();
      standbyRef.current?.destroy?.();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // ── Start gate tap ─────────────────────────────────────────────────────────
  const handleGateTap = () => {
    if (!controllerReady.current) return;
    if (!userActivated.current) {
      userActivated.current = true;
      // Unmute both players here — this callback runs inside a user-gesture context,
      // which is the only time iOS/Android allow unmuting / starting unmuted playback.
      ytRef.current?.unMute();
      ytRef.current?.setVolume(videoTargetVol.current);
      if (pendingVideoId.current) { const vid = pendingVideoId.current; pendingVideoId.current = null; loadVideo(vid); }
      if (pendingPlaylistId.current) { const pid = pendingPlaylistId.current; pendingPlaylistId.current = null; loadStandbyPlaylist(pid); }
      else if (currentPlaylistId.current) { standbyRef.current?.unMute(); fadeStandbyVolume(standbyTargetVol.current); }
    }
    setGateFading(true);
    setTimeout(() => setGateVisible(false), 450);
  };

  const toggleFullscreen = () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const el = document.documentElement as any, doc = document as any;
    if (!doc.fullscreenElement && !doc.webkitFullscreenElement) {
      (el.requestFullscreen ?? el.webkitRequestFullscreen)?.call(el)?.catch(() => {});
    } else {
      (doc.exitFullscreen ?? doc.webkitExitFullscreen)?.call(doc)?.catch(() => {});
    }
  };

  if (displaced) {
    return (
      <div id="displaced-banner">
        <span>⚠️ This player was replaced by another window.</span>
        <button id="displaced-reclaim-btn" onClick={() => { setDisplaced(false); connect(); }}>Take back control</button>
      </div>
    );
  }

  return (
    <>
      {/* Standby idle overlay */}
      <div id="idle">
        <div className="standby-bg" id="standby-bg" />
        <div className="slate-content">
          <div id="standby-title-el" className="standby-title">Karaoke Browser</div>
          <div id="standby-subtitle-el" className="standby-subtitle">Your karaoke night command center</div>
        </div>
        <div className="slate-crowd-qr">
          <div className="scq-logo">🎤</div>
          <h2 className="scq-heading">Make a Request!</h2>
          <p className="scq-sub">Scan the code to pick a karaoke song</p>
          <div className="scq-card"><img className="scq-img" src="" alt="Scan to request a song" /></div>
          <p className="scq-url"></p>
        </div>
      </div>

      {/* Main YT player target */}
      <div id="yt-player" />

      {/* Hidden standby audio player target */}
      <div id="standby-player" />

      {/* Embed error overlay */}
      <div id="embed-error">
        <img id="embed-thumb" src="" alt="" />
        <div id="embed-title" />
        <div id="embed-sub">Playing on YouTube &mdash; check the controller</div>
      </div>

      {/* Singer slate overlay */}
      <div id="singer-slate">
        <div className="slate-content">
          <div id="slate-eyebrow">Now Singing</div>
          <div id="slate-singer" />
          <div id="slate-title" />
        </div>
        <div className="slate-crowd-qr">
          <div className="scq-logo">🎤</div>
          <h2 className="scq-heading">Make a Request!</h2>
          <p className="scq-sub">Scan the code to pick a karaoke song</p>
          <div className="scq-card"><img className="scq-img" src="" alt="Scan to request a song" /></div>
          <p className="scq-url"></p>
        </div>
      </div>

      {/* Start gate */}
      {gateVisible && (
        <div id="start-gate" className={gateFading ? 'fading' : ''} onClick={handleGateTap}>
          <div id="start-gate-icon">🎤</div>
          <div id="start-gate-label" hidden={!controllerDot}>Tap to begin</div>
          <div id="gate-status">
            <div className="gate-badge">
              <div className="gate-dot on" />
              <span>Player</span>
            </div>
            <div className="gate-badge" id="gate-controller-badge">
              <div id="gate-controller-dot" className={`gate-dot ${controllerDot ? 'on' : ''}`} />
              <span>Controller</span>
            </div>
          </div>
          {!controllerDot && (
            <button id="gate-open-controller" onClick={e => { e.stopPropagation(); if (sessionId) window.open('/controller', '_blank'); }}>🎤 Open Controller</button>
          )}
        </div>
      )}

      {/* Fullscreen button — hidden on iOS Safari where the Fullscreen API is unsupported */}
      {(document.fullscreenEnabled || (document as Document & { webkitFullscreenEnabled?: boolean }).webkitFullscreenEnabled) && (
        <button id="fullscreen-btn" className={btnVisible ? 'visible' : ''} onClick={toggleFullscreen} title="Enter fullscreen">⛶</button>
      )}
    </>
  );
}
