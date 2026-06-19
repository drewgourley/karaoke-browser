// Inject YouTube IFrame API
(function () {
  const s = document.createElement('script');
  s.src = 'https://www.youtube.com/iframe_api';
  document.head.appendChild(s);
})();

let ytPlayer = null;
let pendingVideoId = null;
let currentVideoId = null;
let currentTitle = '';
let currentSinger = '';
let embedFailed = false;
let shouldPauseOnPlay = false;
let showingSlate = false;
let userActivated = false;
let hideSlateTimer = null;

// ── Start gate — one tap unlocks autoplay for the session ──────────────────
document.getElementById('start-gate').addEventListener('click', () => {
  userActivated = true;
  const gate = document.getElementById('start-gate');
  gate.classList.add('fading');
  setTimeout(() => { gate.style.display = 'none'; }, 450);
  if (pendingVideoId) {
    const vid = pendingVideoId;
    pendingVideoId = null;
    loadVideo(vid);
  }
});

window.onYouTubeIframeAPIReady = function () {
  ytPlayer = new YT.Player('yt-player', {
    width: '100%',
    height: '100%',
    playerVars: {
      autoplay: 1,
      controls: 0,       // no control bar
      rel: 0,            // no related videos
      modestbranding: 1, // minimal branding
      iv_load_policy: 3, // no annotations
      showinfo: 0,       // no title overlay (legacy, still effective)
      cc_load_policy: 0, // no auto-generated captions
      fs: 0,             // no fullscreen button
      disablekb: 1,      // no keyboard shortcuts
      playsinline: 1,
    },
    events: {
      onReady: function () {
        if (pendingVideoId) {
          loadVideo(pendingVideoId);
          pendingVideoId = null;
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
        // 100 = removed/private; 101/150 = embedding disabled by owner/environment
        if (e.data === 100 || e.data === 101 || e.data === 150) {
          showEmbedError(currentVideoId);
          ws.send(JSON.stringify({ type: 'video-error', code: e.data }));
        }
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
    ytPlayer.loadVideoById(videoId);
  } else {
    pendingVideoId = videoId;
  }
}

function showSlate() {
  // Cancel any pending hideSlate timer so it can't clobber this slate.
  if (hideSlateTimer) { clearTimeout(hideSlateTimer); hideSlateTimer = null; }
  showingSlate = true;
  const slate = document.getElementById('singer-slate');
  document.getElementById('slate-eyebrow').textContent = currentSinger ? 'Now Singing' : 'Up Next';
  document.getElementById('slate-singer').textContent = currentSinger;
  document.getElementById('slate-singer').style.display = currentSinger ? '' : 'none';
  document.getElementById('slate-title').textContent = currentTitle;
  slate.style.display = 'flex';
  requestAnimationFrame(() => requestAnimationFrame(() => slate.classList.add('visible')));
}

function hideSlate(callback) {
  if (hideSlateTimer) { clearTimeout(hideSlateTimer); hideSlateTimer = null; }
  const slate = document.getElementById('singer-slate');
  slate.classList.remove('visible');
  hideSlateTimer = setTimeout(() => {
    hideSlateTimer = null;
    slate.style.display = 'none';
    showingSlate = false;
    if (callback) callback();
  }, 560);
}

function showEmbedError(videoId) {
  embedFailed = true;
  shouldPauseOnPlay = false;
  showingSlate = false;
  hideSlate(null);
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
  const idle = document.getElementById('idle');
  idle.style.display = 'flex';
  requestAnimationFrame(() => requestAnimationFrame(() => idle.classList.add('visible')));
  document.getElementById('embed-error').style.display = 'none';
  if (ytPlayer && typeof ytPlayer.stopVideo === 'function') {
    ytPlayer.stopVideo();
  }
}

// ── WebSocket ──────────────────────────────────────────────────────────────

let ws;

function connect() {
  ws = new WebSocket((location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host);

  ws.onmessage = function (event) {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }

    if (msg.type === 'restart') {
      if (currentVideoId) loadVideo(currentVideoId);
      return;
    }

    if (msg.type === 'state') {
      if (msg.nowPlaying) {
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
}

connect();

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
    btn.textContent = fs ? '⊡' : '⛶';
    btn.title = fs ? 'Exit fullscreen' : 'Enter fullscreen';
  });
}());
