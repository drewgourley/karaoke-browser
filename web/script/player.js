// Inject YouTube IFrame API
(function () {
  const s = document.createElement('script');
  s.src = 'https://www.youtube.com/iframe_api';
  document.head.appendChild(s);
})();

// \u2500\u2500 Session \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
const sessionId = window.name ? window.name.slice(0, -1) : null;
if (!sessionId) { location.replace('/?redirect=' + encodeURIComponent('/player/')); throw new Error('No session'); }

let ytPlayer = null;
let pendingVideoId = null;
let currentVideoId = null;
let currentTitle = '';
let currentSinger = '';
let embedFailed = false;
let shouldPauseOnPlay = false;
let showingSlate = false;
let userActivated = false;
let controllerReady = false;
let hideSlateTimer = null;
let requestMode   = null;
let slateQrLoaded = false;
let playerMode    = 'karaoke';

// ── Standby music player ───────────────────────────────────────────────────
let standbyPlayer     = null;
let pendingPlaylistId = null;
let currentPlaylistId = null;
let standbyFadeTimer  = null;
let standbyTargetVol  = 75;   // updated from state
let videoTargetVol    = 100;  // updated from state
let fadeDurationMs    = 1500; // updated from state

// ── Microphone ─────────────────────────────────────────────────────────────
let micContext    = null; // AudioContext
let micGain       = null; // GainNode
let micStream     = null; // MediaStream
let micTargetVol  = 80;   // 0-100, updated from state
let micMuted      = false; // updated from state

function applyMicGain() {
  if (micGain) micGain.gain.value = micMuted ? 0 : micTargetVol / 100;
}

async function initMic() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false },
    });
    const source = micContext.createMediaStreamSource(stream);
    micGain = micContext.createGain();
    applyMicGain();
    source.connect(micGain);
    micGain.connect(micContext.destination);
    micStream = stream;
    if (ws && ws.readyState === WebSocket.OPEN)
      ws.send(JSON.stringify({ type: 'mic-status', ready: true }));
  } catch (err) {
    console.warn('[Mic] getUserMedia failed:', err.name);
    if (ws && ws.readyState === WebSocket.OPEN)
      ws.send(JSON.stringify({ type: 'mic-status', ready: false, reason: err.name }));
  }
}

// ── Start gate — one tap unlocks autoplay for the session ──────────────────
document.getElementById('start-gate').addEventListener('click', () => {
  if (!controllerReady) return; // not tappable until a controller is connected
  const gate = document.getElementById('start-gate');
  if (!userActivated) {
    userActivated = true;
    if (pendingVideoId) {
      const vid = pendingVideoId;
      pendingVideoId = null;
      loadVideo(vid);
    }
    // Unlock standby: if player wasn't ready yet start it now, otherwise just unmute.
    if (pendingPlaylistId) {
      const pid = pendingPlaylistId;
      pendingPlaylistId = null;
      loadStandbyPlaylist(pid);
    } else if (currentPlaylistId) {
      fadeStandbyVolume(standbyTargetVol);
    }
    // Initialise microphone in user-gesture context so AudioContext can start.
    if (!micContext && (window.AudioContext || window.webkitAudioContext)) {
      micContext = new (window.AudioContext || window.webkitAudioContext)();
      initMic();
    }
  }
  // Dismiss the gate whether this is the first tap or a recovery tap.
  gate.classList.add('fading');
  setTimeout(() => { gate.style.display = 'none'; }, 450);
});

window.onYouTubeIframeAPIReady = function () {
  ytPlayer = new YT.Player('yt-player', {
    width: '100%',
    height: '100%',
    playerVars: {
      autoplay: 1,
      controls: 0,
      rel: 0,
      modestbranding: 1,
      iv_load_policy: 3,
      showinfo: 0,
      cc_load_policy: 0,
      fs: 0,
      disablekb: 1,
      playsinline: 1,
    },
    events: {
      onReady: function () {
        if (pendingVideoId) {
          if (userActivated) {
            const vid = pendingVideoId;
            pendingVideoId = null;
            loadVideo(vid);
          }
        }
      },
      onStateChange: function (e) {
        if (e.data === YT.PlayerState.PLAYING && shouldPauseOnPlay) {
          // Only auto-pause when the actual video is playing, not an ad.
          // During an ad, getVideoData().video_id is empty or mismatched.
          const vid = ytPlayer.getVideoData && ytPlayer.getVideoData().video_id;
          if (vid && vid !== currentVideoId) return; // ad playing — ignore
          shouldPauseOnPlay = false;
          ytPlayer.pauseVideo();
          ws.send(JSON.stringify({ type: 'pause' }));
          showSlate();
        }
        if (e.data === YT.PlayerState.ENDED) {
          ws.send(JSON.stringify({ type: 'video-ended' }));
        }
      },
      onError: function (e) {
        console.warn('[YT] onError code:', e.data);
        if (e.data === 100 || e.data === 101 || e.data === 150) {
          showEmbedError(currentVideoId);
          ws.send(JSON.stringify({ type: 'video-error', code: e.data }));
        }
      },
    },
  });

  // Create the standby music player (audio-only, hidden off-screen).
  standbyPlayer = new YT.Player('standby-player', {
    width: '1',
    height: '1',
    playerVars: {
      autoplay: 1,  // must be 1 so the iframe gets allow="autoplay"; we silence it immediately in onReady
      controls: 0,
      loop: 1,
      fs: 0,
      disablekb: 1,
      playsinline: 1,
      rel: 0,
    },
    events: {
      onReady: function () {
        standbyPlayer.setVolume(0); // silence any initial autoplay attempt
        if (pendingPlaylistId) {
          const pid = pendingPlaylistId;
          pendingPlaylistId = null;
          loadStandbyPlaylist(pid); // loads silently; fades up when user activates
        }
      },
      onStateChange: function (e) {
        // PLAYING — report the current track to the controller mixer card.
        if (e.data === 1) {
          const data = standbyPlayer.getVideoData && standbyPlayer.getVideoData();
          if (data && data.video_id && ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'standby-track', videoId: data.video_id, title: data.title || '' }));
          }
        }
        // ENDED — restart the playlist to guarantee continuous looping.
        if (e.data === 0 && currentPlaylistId) {
          standbyPlayer.loadPlaylist({ listType: 'playlist', list: currentPlaylistId, index: 0 });
          standbyPlayer.playVideo();
        }
      },
      onError: function (e) {
        console.warn('[Standby] onError code:', e.data, '— skipping');
      },
    },
  });
};

function loadVideo(videoId) {
  if (!userActivated) {
    pendingVideoId = videoId;
    return;
  }
  embedFailed = false;
  shouldPauseOnPlay = true;
  showingSlate = false;
  hideSlate(null);
  const idle = document.getElementById('idle');
  idle.classList.remove('visible');
  idle.style.display = 'none';
  currentVideoId = videoId;
  document.getElementById('embed-error').style.display = 'none';
  if (ytPlayer && typeof ytPlayer.loadVideoById === 'function') {
    ytPlayer.setVolume(videoTargetVol);
    ytPlayer.loadVideoById(videoId);
  } else {
    pendingVideoId = videoId;
  }
}

function showSlate() {
  if (hideSlateTimer) { clearTimeout(hideSlateTimer); hideSlateTimer = null; }
  showingSlate = true;
  fadeStandbyVolume(standbyTargetVol);
  const slate = document.getElementById('singer-slate');
  document.getElementById('slate-eyebrow').textContent = currentSinger ? 'Now Singing' : 'Up Next';
  document.getElementById('slate-singer').textContent = currentSinger;
  document.getElementById('slate-singer').style.display = currentSinger ? '' : 'none';
  document.getElementById('slate-title').textContent = currentTitle;
  slate.style.display = slate.classList.contains('crowd') ? 'grid' : 'flex';
  requestAnimationFrame(() => requestAnimationFrame(() => slate.classList.add('visible')));
}

function hideSlate(callback) {
  if (hideSlateTimer) { clearTimeout(hideSlateTimer); hideSlateTimer = null; }
  fadeStandbyVolume(0);
  const slate = document.getElementById('singer-slate');
  slate.classList.remove('visible');
  hideSlateTimer = setTimeout(() => {
    hideSlateTimer = null;
    slate.style.display = 'none';
    showingSlate = false;
    if (callback) callback();
  }, 560);
}

// ── Crowd QR helpers ────────────────────────────────────────────────────────────

function loadSlateQR() {
  if (slateQrLoaded) return;
  const requestUrl = location.origin + '/request/?s=' + encodeURIComponent(sessionId);
  document.querySelectorAll('.scq-url').forEach(el => { el.textContent = requestUrl; });
  fetch('/api/qr?s=' + encodeURIComponent(sessionId) + '&data=' + encodeURIComponent(requestUrl))
    .then(r => r.ok ? r.json() : null)
    .then(d => {
      if (d && d.dataUrl) {
        document.querySelectorAll('.scq-img').forEach(el => { el.src = d.dataUrl; });
        slateQrLoaded = true;
      }
    })
    .catch(() => {});
}

function applySlateQR() {
  const crowd  = requestMode === 'crowd';
  const idleEl = document.getElementById('idle');
  const slateEl = document.getElementById('singer-slate');
  idleEl.classList.toggle('crowd', crowd);
  slateEl.classList.toggle('crowd', crowd);
  // Update inline display for any currently-visible slate.
  if (idleEl.style.display  === 'flex' || idleEl.style.display  === 'grid')
    idleEl.style.display  = crowd ? 'grid' : 'flex';
  if (slateEl.style.display === 'flex' || slateEl.style.display === 'grid')
    slateEl.style.display = crowd ? 'grid' : 'flex';
  if (crowd) loadSlateQR();
}

function parseFont(v) {
  if (!v) return { family: '', weight: '' };
  const sep = v.indexOf('|');
  return sep === -1 ? { family: v, weight: '' } : { family: v.slice(0, sep), weight: v.slice(sep + 1) };
}

function updateStandbyDisplay(msg) {
  const titleEl    = document.getElementById('standby-title-el');
  const subtitleEl = document.getElementById('standby-subtitle-el');
  const bgEl       = document.getElementById('standby-bg');
  if (titleEl) {
    titleEl.textContent            = msg.standbyTitle        || 'Karaoke Browser';
    titleEl.style.color            = msg.standbyTitleColor   || '#ffffff';
    const tf = parseFont(msg.standbyTitleFont || '');
    titleEl.style.fontFamily       = tf.family;
    titleEl.style.fontWeight       = tf.weight;
    titleEl.style.fontSize         = (msg.standbyTitleSize > 0) ? msg.standbyTitleSize + 'px' : '';
    const tSz  = msg.standbyTitleOutlineSize ?? 20;
    const tCol = msg.standbyTitleOutline     || '#000000';
    titleEl.style.webkitTextStroke = tSz > 0 ? `${tSz}px ${tCol}` : '';
    const root = document.documentElement;
    root.style.setProperty('--scq-heading-color',  msg.standbyTitleColor || '#ffffff');
    root.style.setProperty('--scq-heading-stroke', tSz > 0 ? `${Math.ceil(tSz / 2)}px ${tCol}` : '0px transparent');
  }
  if (subtitleEl) {
    subtitleEl.textContent            = msg.standbySubtitle      || 'Your karaoke night command center';
    subtitleEl.hidden                 = msg.standbySubtitle === ''
    subtitleEl.style.color            = msg.standbySubtitleColor || '#ffffff';
    const sf = parseFont(msg.standbySubtitleFont || '');
    subtitleEl.style.fontFamily       = sf.family;
    subtitleEl.style.fontWeight       = sf.weight;
    subtitleEl.style.fontSize         = (msg.standbySubtitleSize > 0) ? msg.standbySubtitleSize + 'px' : '';
    const sSz  = msg.standbySubtitleOutlineSize ?? 8;
    const sCol = msg.standbySubtitleOutline      || '#000000';
    subtitleEl.style.webkitTextStroke = sSz > 0 ? `${sSz}px ${sCol}` : '';
    const root2 = document.documentElement;
    root2.style.setProperty('--scq-sub-color',  msg.standbySubtitleColor || '#ffffff');
    root2.style.setProperty('--scq-sub-stroke', sSz > 0 ? `${Math.ceil(sSz / 2)}px ${sCol}` : '0px transparent');
  }
  if (bgEl && Array.isArray(msg.standbyColors)) {
    const c = msg.standbyColors;
    const defs = ['#4cc9f0', '#4361ee', '#7c3aed', '#f72585', '#ff6b35', '#ffd166', '#06d6a0', '#3a0ca3'];
    for (let i = 1; i <= 8; i++) {
      const val = c[i - 1] || defs[i - 1];
      bgEl.style.setProperty(`--sc${i}`, val);
      document.documentElement.style.setProperty(`--sc${i}`, val);
    }
  }
}

function showEmbedError(videoId) {
  embedFailed = true;
  shouldPauseOnPlay = false;
  showingSlate = false;
  hideSlate(null);
  fadeStandbyVolume(standbyTargetVol);
  if (ytPlayer && typeof ytPlayer.stopVideo === 'function') ytPlayer.stopVideo();
  document.getElementById('embed-thumb').src =
    'https://img.youtube.com/vi/' + videoId + '/maxresdefault.jpg';
  document.getElementById('embed-title').textContent = currentTitle;
  document.getElementById('embed-error').style.display = 'flex';
}

function showIdle() {
  currentVideoId = null;
  embedFailed = false;
  shouldPauseOnPlay = false;
  showingSlate = false;
  hideSlate(null);
  // If the controller was lost during a track, surface the gate now that
  // we're between songs and it's safe to show it.
  if (userActivated && !controllerReady) {
    const gate = document.getElementById('start-gate');
    if (gate && gate.style.display === 'none') {
      gate.style.display = 'flex';
      gate.classList.remove('fading');
    }
  }
  if (userActivated) {
    if (pendingPlaylistId) {
      const pid = pendingPlaylistId;
      pendingPlaylistId = null;
      loadStandbyPlaylist(pid);
    } else {
      fadeStandbyVolume(standbyTargetVol);
    }
  }
  const idle = document.getElementById('idle');
  idle.style.display = idle.classList.contains('crowd') ? 'grid' : 'flex';
  requestAnimationFrame(() => requestAnimationFrame(() => idle.classList.add('visible')));
  document.getElementById('embed-error').style.display = 'none';
  if (ytPlayer && typeof ytPlayer.stopVideo === 'function') {
    ytPlayer.stopVideo();
  }
}

// ── Standby music helpers ─────────────────────────────────────────────────────

function fadeStandbyVolume(target) {
  if (!standbyPlayer || typeof standbyPlayer.setVolume !== 'function') return;
  if (standbyFadeTimer) { clearInterval(standbyFadeTimer); standbyFadeTimer = null; }
  const start = standbyPlayer.getVolume ? standbyPlayer.getVolume() : 0;
  const steps = 30;
  const stepMs = Math.max(16, fadeDurationMs / steps);
  let step = 0;
  standbyFadeTimer = setInterval(() => {
    step++;
    const v = Math.round(start + (target - start) * (step / steps));
    standbyPlayer.setVolume(Math.max(0, Math.min(100, v)));
    if (step >= steps) { clearInterval(standbyFadeTimer); standbyFadeTimer = null; }
  }, stepMs);
}

function loadStandbyPlaylist(id) {
  if (!standbyPlayer || typeof standbyPlayer.loadPlaylist !== 'function') {
    pendingPlaylistId = id;
    return;
  }
  currentPlaylistId = id;
  pendingPlaylistId = null;
  standbyPlayer.setVolume(0);
  standbyPlayer.loadPlaylist({ listType: 'playlist', list: id, index: 0 });
  standbyPlayer.playVideo();
  // Only make audible once the user has activated the player.
  if (userActivated) fadeStandbyVolume(standbyTargetVol);
}

function stopStandby() {
  if (standbyFadeTimer) { clearInterval(standbyFadeTimer); standbyFadeTimer = null; }
  currentPlaylistId = null;
  pendingPlaylistId = null;
  if (standbyPlayer && typeof standbyPlayer.stopVideo === 'function') {
    standbyPlayer.setVolume(0);
    standbyPlayer.stopVideo();
  }
}

// ── Gate status ──────────────────────────────────────────────────────────────

function updateGateStatus(controllerConnected) {
  const gate    = document.getElementById('start-gate');
  const dot     = document.getElementById('gate-controller-dot');
  const openBtn = document.getElementById('gate-open-controller');
  const label   = document.getElementById('start-gate-label');

  controllerReady = !!controllerConnected;
  dot.className   = 'gate-dot' + (controllerConnected ? ' on' : ' off');
  openBtn.hidden  = !!controllerConnected;
  label.hidden    = !controllerConnected;
  gate.classList.toggle('gate-ready', !!controllerConnected);

  if (userActivated) {
    if (!controllerConnected && gate.style.display === 'none') {
      // Controller dropped after gate was dismissed. Only bring it back if
      // we're between tracks — don't interrupt a live karaoke song.
      if (!currentVideoId) {
        gate.style.display = 'flex';
        gate.classList.remove('fading');
      }
    } else if (controllerConnected && gate.style.display !== 'none') {
      // Controller reconnected — auto-dismiss the gate.
      gate.classList.add('fading');
      setTimeout(() => { gate.style.display = 'none'; }, 450);
    }
  }
}

// ── WebSocket ──────────────────────────────────────────────────────────────

let ws;

function connect() {
  ws = new WebSocket((location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + '/?s=' + encodeURIComponent(sessionId) + '&role=player');

  ws.onmessage = function (event) {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }

    if (msg.type === 'restart') {
      if (currentVideoId) loadVideo(currentVideoId);
      return;
    }

    if (msg.type === 'standby-skip') {
      if (standbyPlayer && typeof standbyPlayer.nextVideo === 'function') standbyPlayer.nextVideo();
      return;
    }

    if (msg.type === 'standby-pause') {
      if (standbyPlayer && typeof standbyPlayer.pauseVideo === 'function') standbyPlayer.pauseVideo();
      return;
    }

    if (msg.type === 'standby-resume') {
      if (standbyPlayer && typeof standbyPlayer.playVideo === 'function') standbyPlayer.playVideo();
      return;
    }

    if (msg.type === 'state') {
      updateGateStatus(!!msg.controllerConnected);

      if (msg.requestMode !== undefined && msg.requestMode !== requestMode) {
        requestMode = msg.requestMode || null;
        applySlateQR();
      }

      // Sync mix settings from the mixer page.
      if (typeof msg.standbyVolume  === 'number') {
        standbyTargetVol = msg.standbyVolume;
        if (userActivated && currentPlaylistId && !currentVideoId) fadeStandbyVolume(standbyTargetVol);
      }
      if (typeof msg.videoVolume    === 'number') {
        videoTargetVol = msg.videoVolume;
        if (ytPlayer && typeof ytPlayer.setVolume === 'function' && currentVideoId) {
          ytPlayer.setVolume(videoTargetVol);
        }
      }
      if (typeof msg.fadeDuration   === 'number') fadeDurationMs   = msg.fadeDuration;

      // Sync mic settings.
      if (typeof msg.micVolume === 'number')  { micTargetVol = msg.micVolume; applyMicGain(); }
      if (typeof msg.micMuted  === 'boolean') { micMuted = msg.micMuted;      applyMicGain(); }

      // Sync standby playlist.
      const incomingPlaylist = msg.standbyPlaylistId || null;
      if (incomingPlaylist !== currentPlaylistId) {
        if (incomingPlaylist) loadStandbyPlaylist(incomingPlaylist);
        else stopStandby();
      }

      playerMode = msg.playerMode || 'karaoke';
      updateStandbyDisplay(msg);

      if (playerMode === 'standby') {
        // Locked to standby slate — stop any active karaoke video.
        if (currentVideoId) {
          if (ytPlayer && typeof ytPlayer.stopVideo === 'function') ytPlayer.stopVideo();
          currentVideoId    = null;
          embedFailed       = false;
          shouldPauseOnPlay = false;
          showingSlate      = false;
          hideSlate(null);
          document.getElementById('embed-error').style.display = 'none';
        }
        const idleEl = document.getElementById('idle');
        if (!idleEl.style.display || idleEl.style.display === 'none') showIdle();
      } else if (msg.nowPlaying) {
        currentTitle  = msg.nowPlaying.title  || '';
        currentSinger = msg.nowPlaying.singer || '';
        if (msg.nowPlaying.videoId !== currentVideoId) {
          loadVideo(msg.nowPlaying.videoId);
        } else if (!embedFailed) {
          if (showingSlate && !msg.paused) {
            hideSlate(() => {
              if (ytPlayer && typeof ytPlayer.playVideo === 'function') ytPlayer.playVideo();
            });
          } else if (!showingSlate && ytPlayer && typeof ytPlayer.pauseVideo === 'function') {
            if (msg.paused) ytPlayer.pauseVideo();
            else ytPlayer.playVideo();
          }
        }
      } else {
        showIdle();
      }
    }
  };

  ws.onclose = function () {
    setTimeout(connect, 3000);
  };

  ws.onopen = function () {
    // Report mic status on reconnect so the controller card stays accurate.
    if (micStream) {
      ws.send(JSON.stringify({ type: 'mic-status', ready: true }));
    }
  };
}

connect();

// ── Open Controller button ──────────────────────────────────────────────────────
document.getElementById('gate-open-controller').addEventListener('click', e => {
  e.stopPropagation(); // don't trigger the start-gate tap-to-begin
  window.open('/controller/', sessionId + 'C');
});

// ── Fullscreen button ──────────────────────────────────────────────────────
(function () {
  const btn = document.getElementById('fullscreen-btn');
  let hideTimer = null;

  function showBtn() {
    btn.classList.add('visible');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => btn.classList.remove('visible'), 3000);
  }

  document.addEventListener('mousemove', showBtn);
  showBtn(); // brief reveal on load so the button is discoverable

  btn.addEventListener('click', () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  });

  document.addEventListener('fullscreenchange', () => {
    const fs = !!document.fullscreenElement;
    btn.textContent = fs ? '✕' : '⛶';
    btn.title = fs ? 'Exit fullscreen' : 'Enter fullscreen';
  });
}());
