// ── State ──────────────────────────────────────────────────────────────────
let state = { queue: [], nowPlaying: null };
let dragFrom = null;

// ── Session ──────────────────────────────────────────────────────────────
// Session ID is carried in window.name (set by the opener via window.open(url, id+'C')).
// It is never in the page URL, so it doesn't appear in the address bar or browser history.
const sessionId = window.name ? window.name.slice(0, -1) : null;
if (!sessionId) { location.replace('/?redirect=' + encodeURIComponent('/controller/')); throw new Error('No session'); }

document.getElementById('open-player-btn').addEventListener('click', () => {
  window.open('/player/', sessionId + 'P');
});

// ── Elements ───────────────────────────────────────────────────────────────
const dot           = document.getElementById('dot');
const statusText    = document.getElementById('status-text');
const openPlayerBtn = document.getElementById('open-player-btn');
const playerUpBadge = document.getElementById('player-up-badge');
const urlInput      = document.getElementById('url-input');
const titleInput    = document.getElementById('title-input');
const addBtn        = document.getElementById('add-btn');
const fetchBtn      = document.getElementById('fetch-btn');
const npEl          = document.getElementById('now-playing');
const requeueBtn    = document.getElementById('requeue-btn');
const queueEl       = document.getElementById('queue-list');
const qCount        = document.getElementById('q-count');
const clearBtn      = document.getElementById('clear-btn');
const reqList            = document.getElementById('request-list');
const reqCount           = document.getElementById('req-count');
const reqModeBtn         = document.getElementById('req-mode-btn');
const reqClearBlockedBtn = document.getElementById('req-clear-blocked-btn');
const reqBannedBadge     = document.getElementById('req-banned-badge');
const reqBannedCount     = document.getElementById('req-banned-count');
const requesterBadge     = document.getElementById('requester-badge');
const requesterBadgeText = document.getElementById('requester-badge-text');
const devicesModal       = document.getElementById('devices-modal');
const dmRequesterCount   = document.getElementById('dm-requester-count');
const dmBannedCount      = document.getElementById('dm-banned-count');
const dmBlockedCount     = document.getElementById('dm-blocked-count');
const dmResetBtn         = document.getElementById('dm-reset-btn');
const dmUnbanBtn         = document.getElementById('dm-unban-btn');
const dmUnblockBtn       = document.getElementById('dm-unblock-btn');
const reqLinkBtn         = document.getElementById('req-link-btn');
const kioskLinkBtn       = document.getElementById('kiosk-link-btn');
// ── WebSocket ──────────────────────────────────────────────────────────────
let ws;

function connect() {
  ws = new WebSocket((location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + '/?s=' + encodeURIComponent(sessionId) + '&role=controller');

  ws.onopen = () => {
    dot.className = 'dot on';
    statusText.textContent = 'Controller';
  };
  ws.onclose = () => {
    dot.className = 'dot off';
    statusText.textContent = 'Disconnected – reconnecting…';
    setTimeout(connect, 3000);
  };
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'mic-status') {
      micReady = msg.ready;
      renderMixer();
      return;
    }
    if (msg.type === 'state') {
      state = msg;
      render();
      openPlayerBtn.hidden = !!state.playerConnected;
      playerUpBadge.hidden  = !state.playerConnected;
      // Sync mode toggle pill position.
      if (reqModeBtn) reqModeBtn.dataset.mode = state.requestMode || 'kiosk';
      // Show "Unblock all" only when in crowd mode with waiting devices.
      if (reqClearBlockedBtn) {
        reqClearBlockedBtn.hidden = !(state.requestMode === 'crowd' && state.blockedCount > 0);
      }
      // Banned device badge.
      if (reqBannedBadge) {
        const bc = state.bannedCount || 0;
        reqBannedBadge.hidden = bc === 0;
        if (reqBannedCount) reqBannedCount.textContent = bc;
      }
      // Requester presence badge + request-link button.
      if (requesterBadge) {
        const rc = state.requesterCount || 0;
        requesterBadge.hidden = rc === 0;
        if (requesterBadgeText) {
          requesterBadgeText.textContent = state.requestMode === 'kiosk'
            ? 'Kiosk'
            : rc + ' Requester' + (rc === 1 ? '' : 'S');
        }
        if (reqLinkBtn)   reqLinkBtn.hidden   = state.requestMode !== 'crowd';
        if (kioskLinkBtn) kioskLinkBtn.hidden = state.requestMode === 'crowd';
      }
      renderDevicesModal();
    }
  };
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

// ── Devices modal ──────────────────────────────────────────────────────────
function renderDevicesModal() {
  const isCrowd = state.requestMode === 'crowd';
  const dmRequesterLabel = document.getElementById('dm-requester-label');
  const dmBannedSection  = document.getElementById('dm-banned-section');
  const dmBlockedSection = document.getElementById('dm-blocked-section');
  if (dmRequesterLabel) dmRequesterLabel.textContent = isCrowd ? 'Requestors' : 'Kiosks';
  if (dmBannedSection)  dmBannedSection.hidden  = !isCrowd;
  if (dmBlockedSection) dmBlockedSection.hidden = !isCrowd;
  if (dmRequesterCount) dmRequesterCount.textContent = state.requesterCount || 0;
  if (dmBannedCount)    dmBannedCount.textContent    = state.bannedCount    || 0;
  if (dmBlockedCount)   dmBlockedCount.textContent   = state.blockedCount   || 0;
  if (dmUnbanBtn)    dmUnbanBtn.disabled    = !(state.bannedCount  > 0);
  if (dmUnblockBtn)  dmUnblockBtn.disabled  = !(state.blockedCount > 0);
}

// ── Render ─────────────────────────────────────────────────────────────────
function thumb(videoId) {
  return 'https://img.youtube.com/vi/' + videoId + '/mqdefault.jpg';
}

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function render() {
  renderNP();
  renderQueue();
  renderRequests();
  renderMixer();
}

function renderNP() {
  const np = state.nowPlaying;
  requeueBtn.hidden   = !(np && !np.embedFailed && state.queue.length > 0);
  requeueBtn.disabled = !state.playerConnected;
  if (!np) {
    npEl.innerHTML = '<span class="np-idle">Nothing playing</span>';
    return;
  }

  if (np.embedFailed) {
    const dis = state.playerConnected ? '' : ' disabled';
    npEl.innerHTML =
      '<div class="embed-warn">' +
        '<div class="embed-warn-title">⚠️ ' + esc(np.title) + '</div>' +
        '<div class="embed-warn-msg">This video can\'t be embedded — it\'s playing on YouTube in the player window. Skip when the song is done.</div>' +
        '<div class="row" style="margin-top:0.25rem">' +
          '<a class="btn" href="' + esc(np.url) + '" target="_blank" rel="noopener noreferrer">Open in YouTube</a>' +
          '<button class="secondary" id="skip-btn"' + dis + '>⏭ Skip</button>' +
        '</div>' +
      '</div>';
    document.getElementById('skip-btn').addEventListener('click', () => send({ type: 'next' }));
    return;
  }

  const isPaused   = !!state.paused;
  const playerOn   = !!state.playerConnected;
  const dis        = playerOn ? '' : ' disabled';
  npEl.innerHTML =
    '<div class="np-wrap">' +
      '<img class="np-thumb" src="' + thumb(np.videoId) + '" alt="">' +
      '<div class="np-info">' +
        '<div class="np-title" title="' + esc(np.title) + '">' + esc(np.title) + '</div>' +
        (np.singer ? '<div class="np-singer">🎤 ' + esc(np.singer) + '</div>' : '') +
        '<div class="row">' +
          '<button class="secondary icon" id="restart-btn"' + dis + '>↺ Restart</button>' +
          '<button class="secondary icon" id="playpause-btn"' + dis + '>' + (!playerOn || isPaused ? '▶ Begin' : '⏸ Pause') + '</button>' +
          '<button class="secondary icon" id="skip-btn"' + dis + '>⏭ Skip</button>' +
        '</div>' +
      '</div>' +
    '</div>';
  document.getElementById('restart-btn').addEventListener('click', () => send({ type: 'restart' }));
  document.getElementById('playpause-btn').addEventListener('click', () => send({ type: isPaused ? 'resume' : 'pause' }));
  document.getElementById('skip-btn').addEventListener('click', () => send({ type: 'next' }));
}

function renderQueue() {
  qCount.textContent = state.queue.length;
  if (state.queue.length === 0) {
    queueEl.innerHTML = '<li class="empty">Queue is empty</li>';
    return;
  }

  queueEl.innerHTML = state.queue.map((item, i) =>
    '<li class="qi" draggable="true" data-i="' + i + '">' +
      '<span class="qi-num">' + (i + 1) + '</span>' +
      '<img class="qi-thumb" src="' + thumb(item.videoId) + '" alt="">' +
      '<div class="qi-info">' +
        '<span class="qi-title" title="' + esc(item.title) + '">' + esc(item.title) + '</span>' +
        (item.singer ? '<span class="qi-singer">🎤 ' + esc(item.singer) + '</span>' : '') +
      '</div>' +
      '<div class="qi-actions">' +
        (i > 0 ? '<button class="ghost" data-action="up" data-i="' + i + '" title="Move up">↑</button>' : '<span class="qi-spacer"></span>') +
        (i < state.queue.length - 1 ? '<button class="ghost" data-action="down" data-i="' + i + '" title="Move down">↓</button>' : '<span class="qi-spacer"></span>') +
        '<button class="ghost" data-action="play" data-i="' + i + '" title="Play now">▶</button>' +
        '<button class="ghost" data-action="remove" data-i="' + i + '" title="Remove">✕</button>' +
      '</div>' +
    '</li>'
  ).join('');

  // Button clicks
  queueEl.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.i);
      if (btn.dataset.action === 'up')     send({ type: 'reorder', from: idx, to: idx - 1 });
      if (btn.dataset.action === 'down')   send({ type: 'reorder', from: idx, to: idx + 1 });
      if (btn.dataset.action === 'play')   send({ type: 'play-index', index: idx });
      if (btn.dataset.action === 'remove') send({ type: 'remove',     index: idx });
    });
  });

  // Drag-to-reorder
  queueEl.querySelectorAll('.qi').forEach(li => {
    li.addEventListener('dragstart', (e) => {
      dragFrom = parseInt(li.dataset.i);
      li.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    li.addEventListener('dragend', () => li.classList.remove('dragging'));
    li.addEventListener('dragover', (e) => {
      e.preventDefault();
      li.classList.add('drag-over');
    });
    li.addEventListener('dragleave', () => li.classList.remove('drag-over'));
    li.addEventListener('drop', (e) => {
      e.preventDefault();
      li.classList.remove('drag-over');
      const to = parseInt(li.dataset.i);
      if (dragFrom !== null && dragFrom !== to) {
        send({ type: 'reorder', from: dragFrom, to });
      }
      dragFrom = null;
    });
  });
}
// ── Requests ──────────────────────────────────────────────────────────────
let pendingRequestName = null;
let pendingGrantId    = null;

function renderRequests() {
  const requests = state.requests || [];
  reqCount.textContent = requests.length;
  if (requests.length === 0) {
    reqList.innerHTML = '<li class="empty">No requests yet</li>';
    return;
  }
  reqList.innerHTML = requests.map((req, i) =>
    '<li class="req-item' + (req.id === pendingGrantId ? ' req-granting' : '') + '">' +
      '<div class="req-meta">' +
        (req.name   ? '<span class="req-name">🎤 ' + esc(req.name)   + '</span>' : '') +
        (req.artist ? '<span class="req-artist">'           + esc(req.artist) + '</span>' : '') +
        '<span class="req-title">'                          + esc(req.title)  + '</span>' +
      '</div>' +
      '<div class="req-actions">' +
        '<button class="req-grant-btn' + (req.id === pendingGrantId ? ' req-grant-btn--active' : '') + '" data-i="' + i + '">Grant</button>' +
        '<button class="ghost req-dismiss-btn" data-i="' + i + '" title="Dismiss request">✕</button>' +
        (state.requestMode !== 'kiosk' ? '<button class="ghost req-ban-btn" data-i="' + i + '" title="Ban this device — blocks any further requests from them">🔨</button>' : '') +
      '</div>' +
    '</li>'
  ).join('');

  reqList.querySelectorAll('.req-grant-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const req = (state.requests || [])[parseInt(btn.dataset.i)];
      if (!req) return;
      // Mark as being granted
      pendingGrantId = req.id;
      renderRequests();
      // Switch to search tab
      tabSearch.classList.add('active');
      tabUrl.classList.remove('active');
      panelSearch.style.display = '';
      panelUrl.style.display = 'none';
      // Pre-fill query and store singer name for the modal
      searchInput.value = [req.artist, req.title].filter(Boolean).join(' ');
      pendingRequestName = req.name || null;
      searchBtn.click();
    });
  });

  reqList.querySelectorAll('.req-dismiss-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const req = (state.requests || [])[parseInt(btn.dataset.i)];
      if (!req) return;
      send({ type: 'dismiss-request', id: req.id });
    });
  });

  reqList.querySelectorAll('.req-ban-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const req = (state.requests || [])[parseInt(btn.dataset.i)];
      if (!req) return;
      send({ type: 'ban-device', id: req.id });
    });
  });
}
// ── Add Song ───────────────────────────────────────────────────────────────
function addSong() {
  const url   = urlInput.value.trim();
  const title = titleInput.value.trim();
  if (!url) { urlInput.focus(); return; }
  urlInput.value   = '';
  titleInput.value = '';
  showSingerModal(url, title || url);
}

addBtn.addEventListener('click', addSong);
urlInput.addEventListener('keydown',   e => { if (e.key === 'Enter') addSong(); });
titleInput.addEventListener('keydown', e => { if (e.key === 'Enter') addSong(); });

// Auto-fetch title on paste
urlInput.addEventListener('paste', () => {
  setTimeout(() => fetchTitle(urlInput.value.trim()), 80);
});

async function fetchTitle(url) {
  if (!url) return;
  fetchBtn.disabled = true;
  fetchBtn.textContent = '…';
  try {
    const res  = await fetch('/api/title?url=' + encodeURIComponent(url));
    const data = await res.json();
    if (data.title) titleInput.value = data.title;
  } catch { /* ignore */ }
  fetchBtn.disabled = false;
  fetchBtn.textContent = 'Fetch Title';
}

fetchBtn.addEventListener('click', () => fetchTitle(urlInput.value.trim()));

// ── Search ────────────────────────────────────────────────────────────────
const tabSearch     = document.getElementById('tab-search');
const tabUrl        = document.getElementById('tab-url');
const panelSearch   = document.getElementById('panel-search');
const panelUrl      = document.getElementById('panel-url');
const searchInput   = document.getElementById('search-input');
const karaokeCheck  = document.getElementById('karaoke-check');
const searchBtn     = document.getElementById('search-btn');
const searchResults = document.getElementById('search-results');
let lastSearchResults = [];

tabSearch.addEventListener('click', () => {
  tabSearch.classList.add('active');    tabUrl.classList.remove('active');
  panelSearch.style.display = '';       panelUrl.style.display = 'none';
  searchInput.focus();
});
tabUrl.addEventListener('click', () => {
  tabUrl.classList.add('active');       tabSearch.classList.remove('active');
  panelUrl.style.display = '';          panelSearch.style.display = 'none';
  urlInput.focus();
});

searchInput.addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });
searchBtn.addEventListener('click', doSearch);

async function doSearch() {
  const q = searchInput.value.trim();
  if (!q) { searchInput.focus(); return; }
  const query = karaokeCheck.checked ? q + ' karaoke' : q;

  searchBtn.disabled = true;
  searchBtn.textContent = '…';
  searchResults.innerHTML = '<div class="empty">Searching…</div>';
  lastSearchResults = [];

  try {
    const r    = await fetch('/api/search?q=' + encodeURIComponent(query));
    const data = await r.json();
    if (data.error) {
      searchResults.innerHTML = '<div class="empty">' + esc(data.error) + '</div>';
      return;
    }
    lastSearchResults = data.results || [];
    renderSearchResults();
  } catch {
    searchResults.innerHTML = '<div class="empty">Search failed — check server logs</div>';
  } finally {
    searchBtn.disabled = false;
    searchBtn.textContent = 'Search';
  }
}

function renderSearchResults() {
  if (lastSearchResults.length === 0) {
    searchResults.innerHTML = '<div class="empty">No embeddable results — try different keywords</div>';
    return;
  }
  searchResults.innerHTML = lastSearchResults.map((item, i) =>
    '<div class="sr-item">' +
      '<img class="sr-thumb" src="' + esc(item.thumb) + '" alt="" loading="lazy">' +
      '<div class="sr-info">' +
        '<div class="sr-title" title="' + esc(item.title) + '">' + esc(item.title) + '</div>' +
        '<div class="sr-channel">' + esc(item.channel) + '</div>' +
      '</div>' +
      '<button class="secondary sr-add-btn" data-idx="' + i + '">+ Add</button>' +
    '</div>'
  ).join('');
  searchResults.querySelectorAll('.sr-add-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const item = lastSearchResults[parseInt(btn.dataset.idx)];
      if (!item) return;
      showSingerModal(item.url, item.title, () => {
        btn.textContent = '✓ Added';
        btn.disabled = true;
      });
    });
  });
}

// ── Singer modal ────────────────────────────────────────────────────────────
const singerModal  = document.getElementById('singer-modal');
const singerInput  = document.getElementById('singer-input');
const modalSongEl  = document.getElementById('modal-song');
const modalConfirm = document.getElementById('modal-confirm');
const modalSkip    = document.getElementById('modal-skip');
let pendingAdd = null; // { url, title, onConfirm }

function showSingerModal(url, title, onConfirm) {
  pendingAdd = { url, title, onConfirm };
  modalSongEl.textContent = title;
  singerInput.value = pendingRequestName || '';
  pendingRequestName = null;
  singerModal.style.display = 'flex';
  setTimeout(() => singerInput.focus(), 50);
}

function confirmModal() {
  if (!pendingAdd) return;
  const { url, title, onConfirm } = pendingAdd;
  const singer = singerInput.value.trim();
  send({ type: 'add', url, title, singer: singer || undefined });
  // Auto-dismiss the request that was being granted.
  if (pendingGrantId !== null) {
    send({ type: 'dismiss-request', id: pendingGrantId });
    pendingGrantId = null;
  }
  if (onConfirm) onConfirm();
  pendingAdd = null;
  singerModal.style.display = 'none';
}

function closeModal() {
  pendingAdd = null;
  // Un-highlight the request if the user cancels.
  if (pendingGrantId !== null) {
    pendingGrantId = null;
    renderRequests();
  }
  singerModal.style.display = 'none';
}

modalConfirm.addEventListener('click', confirmModal);
modalSkip.addEventListener('click', closeModal);
singerInput.addEventListener('keydown', e => {
  if (e.key === 'Enter')  confirmModal();
  if (e.key === 'Escape') closeModal();
});
singerModal.addEventListener('click', e => { if (e.target === singerModal) closeModal(); });

// ── Clear queue ────────────────────────────────────────────────────────────
clearBtn.addEventListener('click', () => {
  if (state.queue.length === 0) return;
  if (!confirm('Clear the entire queue?')) return;
  // Remove from end to front so indices stay valid
  for (let i = state.queue.length - 1; i >= 0; i--) {
    send({ type: 'remove', index: i });
  }
});

reqModeBtn.addEventListener('click', () => {
  const newMode = state.requestMode === 'crowd' ? 'kiosk' : 'crowd';
  send({ type: 'set-request-mode', mode: newMode });
});

reqClearBlockedBtn.addEventListener('click', () => {
  send({ type: 'clear-blocked-devices' });
});

// ── Display page modal ─────────────────────────────────────────────────────
const reqLinkModal    = document.getElementById('req-link-modal');
const reqLinkUrlInput = document.getElementById('req-link-url-input');
const reqLinkQrImg    = document.getElementById('req-link-qr');
const reqLinkCopyBtn  = document.getElementById('req-link-copy');
const reqLinkCloseBtn = document.getElementById('req-link-close');
const reqLinkOpenBtn  = document.getElementById('req-link-open');

reqLinkBtn.addEventListener('click', () => {
  const displayUrl = location.origin + '/display/?s=' + encodeURIComponent(sessionId);
  reqLinkUrlInput.value = displayUrl;
  if (reqLinkOpenBtn) reqLinkOpenBtn.href = displayUrl;
  reqLinkQrImg.src = '';
  reqLinkModal.hidden = false;
  fetch('/api/qr?s=' + encodeURIComponent(sessionId) + '&data=' + encodeURIComponent(displayUrl))
    .then(r => r.json())
    .then(d => { if (d.dataUrl) reqLinkQrImg.src = d.dataUrl; })
    .catch(() => {});
});

reqLinkCopyBtn.addEventListener('click', () => {
  navigator.clipboard.writeText(reqLinkUrlInput.value).then(() => {
    reqLinkCopyBtn.textContent = '✓ Copied!';
    setTimeout(() => { reqLinkCopyBtn.textContent = 'Copy'; }, 2000);
  }).catch(() => { reqLinkUrlInput.select(); });
});

reqLinkCloseBtn.addEventListener('click', () => { reqLinkModal.hidden = true; });
reqLinkModal.addEventListener('click', e => { if (e.target === reqLinkModal) reqLinkModal.hidden = true; });

// ── Kiosk link modal ────────────────────────────────────────────────────
const kioskLinkModal    = document.getElementById('kiosk-link-modal');
const kioskLinkUrlInput = document.getElementById('kiosk-link-url-input');
const kioskLinkQrImg    = document.getElementById('kiosk-link-qr');
const kioskLinkCopyBtn  = document.getElementById('kiosk-link-copy');
const kioskLinkCloseBtn = document.getElementById('kiosk-link-close');
const kioskLinkOpenBtn  = document.getElementById('kiosk-link-open');

kioskLinkBtn.addEventListener('click', () => {
  const requestUrl = location.origin + '/request/?s=' + encodeURIComponent(sessionId);
  kioskLinkUrlInput.value = requestUrl;
  if (kioskLinkOpenBtn) kioskLinkOpenBtn.href = requestUrl;
  kioskLinkQrImg.src = '';
  kioskLinkModal.hidden = false;
  fetch('/api/qr?s=' + encodeURIComponent(sessionId) + '&data=' + encodeURIComponent(requestUrl))
    .then(r => r.json())
    .then(d => { if (d.dataUrl) kioskLinkQrImg.src = d.dataUrl; })
    .catch(() => {});
});

kioskLinkCopyBtn.addEventListener('click', () => {
  navigator.clipboard.writeText(kioskLinkUrlInput.value).then(() => {
    kioskLinkCopyBtn.textContent = '✓ Copied!';
    setTimeout(() => { kioskLinkCopyBtn.textContent = 'Copy'; }, 2000);
  }).catch(() => { kioskLinkUrlInput.select(); });
});

kioskLinkCloseBtn.addEventListener('click', () => { kioskLinkModal.hidden = true; });
kioskLinkModal.addEventListener('click', e => { if (e.target === kioskLinkModal) kioskLinkModal.hidden = true; });

// ── Mixer panel ──────────────────────────────────────────────────────────
const mixerPanel        = document.getElementById('mixer-panel');
const mixerHandle       = document.getElementById('mixer-handle');
const mxStandbyVolSlider = document.getElementById('standby-vol-slider');
const mxStandbyVolValue  = document.getElementById('standby-vol-value');
const mxVideoVolSlider   = document.getElementById('video-vol-slider');
const mxVideoVolValue    = document.getElementById('video-vol-value');
const mxMicVolSlider     = document.getElementById('mic-vol-slider');
const mxMicVolValue      = document.getElementById('mic-vol-value');
const mxMicMuteBtn       = document.getElementById('mic-mute-btn');
const mxMicDot           = document.getElementById('mic-status-dot');
const mxMicHint          = document.getElementById('mic-hint');
const mxStandbyNPEl     = document.getElementById('standby-now-playing');
const mxTrackCard       = document.getElementById('standby-track-card');
const mxTrackListEl     = document.getElementById('standby-track-list');
const mxTrackCount      = document.getElementById('standby-track-count');
const mxClearStandbyBtn = document.getElementById('clear-standby-btn');
const mxTabSearch       = document.getElementById('mx-tab-search');
const mxTabUrl          = document.getElementById('mx-tab-url');
const mxPanelSearch     = document.getElementById('mx-panel-search');
const mxPanelUrl        = document.getElementById('mx-panel-url');
const mxUrlInput        = document.getElementById('mx-url-input');
const mxSetBtn          = document.getElementById('mx-set-btn');
const mxSearchInput     = document.getElementById('mx-search-input');
const mxSearchBtn       = document.getElementById('mx-search-btn');
const mxSearchStatus    = document.getElementById('mx-search-status');
const mxSearchResults   = document.getElementById('mx-search-results');

const MX_HANDLE_H  = 40;
let micReady = null; // null=unknown, true=ready, false=denied/unavailable
let mxLoadedPlaylistId = null; // playlist whose tracks are currently rendered
const MX_DEFAULT_H = 320;
let mxOpenHeight   = parseInt(localStorage.getItem('kk_mixer_h') || '0') || MX_DEFAULT_H;
let mxOpen         = localStorage.getItem('kk_mixer_open') === 'true';
let mxDragStartY   = null;
let mxDragStartH   = null;
let mxDragged      = false;

function mxSetHeight(h) {
  mixerPanel.style.height = h + 'px';
  document.body.style.paddingBottom = h + 'px';
}

function mxApplyOpen() {
  mxSetHeight(mxOpen ? mxOpenHeight : MX_HANDLE_H);
}

function mxToggle() {
  mxOpen = !mxOpen;
  localStorage.setItem('kk_mixer_open', mxOpen);
  mxApplyOpen();
}

mxApplyOpen();

mixerHandle.addEventListener('mousedown', e => {
  if (e.button !== 0) return;
  mxDragged = false;
  mxDragStartY = e.clientY;
  mxDragStartH = mixerPanel.offsetHeight;
  document.body.style.userSelect = 'none';
  document.body.style.cursor = 'ns-resize';
  e.preventDefault();
});

document.addEventListener('mousemove', e => {
  if (mxDragStartY === null) return;
  const delta = mxDragStartY - e.clientY;
  if (Math.abs(delta) > 5) mxDragged = true;
  if (!mxDragged) return;
  const newH = Math.max(MX_HANDLE_H, Math.min(Math.floor(window.innerHeight * 0.8), mxDragStartH + delta));
  mxSetHeight(newH);
  if (newH > MX_HANDLE_H + 20) { mxOpen = true; mxOpenHeight = newH; }
});

document.addEventListener('mouseup', () => {
  if (mxDragStartY === null) return;
  const wasDrag = mxDragged;
  mxDragStartY = null;
  mxDragStartH = null;
  mxDragged = false;
  document.body.style.userSelect = '';
  document.body.style.cursor = '';
  if (!wasDrag) { mxToggle(); return; }
  const h = mixerPanel.offsetHeight;
  if (h <= MX_HANDLE_H + 30) {
    mxOpen = false;
    mxSetHeight(MX_HANDLE_H);
  } else {
    mxOpen = true;
    mxOpenHeight = h;
  }
  localStorage.setItem('kk_mixer_open', mxOpen);
  localStorage.setItem('kk_mixer_h', mxOpenHeight);
});

mixerHandle.addEventListener('touchstart', e => {
  const t = e.touches[0];
  mxDragged = false;
  mxDragStartY = t.clientY;
  mxDragStartH = mixerPanel.offsetHeight;
  e.preventDefault();
}, { passive: false });

document.addEventListener('touchmove', e => {
  if (mxDragStartY === null) return;
  const t = e.touches[0];
  const delta = mxDragStartY - t.clientY;
  if (Math.abs(delta) > 5) mxDragged = true;
  if (!mxDragged) return;
  const newH = Math.max(MX_HANDLE_H, Math.min(Math.floor(window.innerHeight * 0.8), mxDragStartH + delta));
  mxSetHeight(newH);
  if (newH > MX_HANDLE_H + 20) { mxOpen = true; mxOpenHeight = newH; }
  e.preventDefault();
}, { passive: false });

document.addEventListener('touchend', () => {
  if (mxDragStartY === null) return;
  const wasDrag = mxDragged;
  mxDragStartY = null;
  mxDragStartH = null;
  mxDragged = false;
  if (!wasDrag) { mxToggle(); return; }
  const h = mixerPanel.offsetHeight;
  if (h <= MX_HANDLE_H + 30) {
    mxOpen = false;
    mxSetHeight(MX_HANDLE_H);
  } else {
    mxOpen = true;
    mxOpenHeight = h;
  }
  localStorage.setItem('kk_mixer_open', mxOpen);
  localStorage.setItem('kk_mixer_h', mxOpenHeight);
});

// ── Mixer tabs ───────────────────────────────────────────────────────────
mxTabSearch.addEventListener('click', () => {
  mxTabSearch.classList.add('active');  mxTabUrl.classList.remove('active');
  mxPanelSearch.style.display = '';    mxPanelUrl.style.display = 'none';
  mxSearchInput.focus();
});
mxTabUrl.addEventListener('click', () => {
  mxTabUrl.classList.add('active');    mxTabSearch.classList.remove('active');
  mxPanelUrl.style.display = '';       mxPanelSearch.style.display = 'none';
  mxUrlInput.focus();
});

// ── Mixer render ─────────────────────────────────────────────────────────
function renderMixer() {
  if (document.activeElement !== mxStandbyVolSlider) {
    mxStandbyVolSlider.value = state.standbyVolume ?? 75;
    mxStandbyVolValue.textContent = mxStandbyVolSlider.value;
  }
  if (document.activeElement !== mxVideoVolSlider) {
    mxVideoVolSlider.value = state.videoVolume ?? 100;
    mxVideoVolValue.textContent = mxVideoVolSlider.value;
  }
  // Mic controls
  const micActive = micReady === true;
  mxMicVolSlider.disabled = !micActive;
  mxMicMuteBtn.disabled   = !micActive;
  if (document.activeElement !== mxMicVolSlider) {
    mxMicVolSlider.value = state.micVolume ?? 80;
    mxMicVolValue.textContent = mxMicVolSlider.value;
  }
  const muted = !!state.micMuted;
  mxMicMuteBtn.checked = !muted;
  mxMicDot.className = 'status-dot-sm' + (micActive && !muted ? ' on' : '');
  mxMicHint.textContent = micReady === null ? 'Awaiting player…'
    : micReady === false ? 'Permission denied or unavailable'
    : muted ? 'Muted' : 'Active';

  const active = !!state.standbyPlaylistId;
  mxLoadTracks(state.standbyPlaylistId || null);

  // Standby now-playing card (col 1)
  if (!active) {
    mxStandbyNPEl.innerHTML = '<span class="np-idle">No playlist set</span>';
  } else {
    const track = state.standbyTrack; // { videoId, title } or null
    const playlistLabel = state.standbyPlaylistTitle || state.standbyPlaylistId;
    let thumbHtml, cardTitle, singerHtml;
    if (track && track.videoId) {
      thumbHtml  = '<img class="np-thumb" src="https://img.youtube.com/vi/' + esc(track.videoId) + '/hqdefault.jpg" alt="">';
      cardTitle  = track.title || track.videoId;
      singerHtml = '🎵 ' + esc(playlistLabel || 'Standby Music');
    } else {
      const rawThumb = state.standbyPlaylistThumbnail || '';
      thumbHtml  = rawThumb
        ? '<img class="np-thumb" src="' + esc(rawThumb) + '" alt="">'
        : '<div class="np-thumb np-thumb-placeholder">🎵</div>';
      cardTitle  = playlistLabel;
      singerHtml = '🎵 Standby Music';
    }
    const standbyPaused = !!state.standbyPaused;
    const mxPlayerOn    = !!state.playerConnected;
    const mxDis         = mxPlayerOn ? '' : ' disabled';
    mxStandbyNPEl.innerHTML =
      '<div class="np-wrap">' +
        thumbHtml +
        '<div class="np-info">' +
          '<div class="np-title" title="' + esc(cardTitle) + '">' + esc(cardTitle) + '</div>' +
          '<div class="np-singer">' + singerHtml + '</div>' +
          '<div class="row">' +
            '<button class="secondary icon" id="standby-playpause-btn"' + mxDis + '>' + (!mxPlayerOn || standbyPaused ? '▶ Play' : '⏸ Pause') + '</button>' +
            '<button class="secondary icon" id="standby-skip-btn"' + mxDis + '>⏭ Skip</button>' +
          '</div>' +
        '</div>' +
      '</div>';
    document.getElementById('standby-playpause-btn')?.addEventListener('click', () => {
      send({ type: standbyPaused ? 'standby-resume' : 'standby-pause' });
    });
    document.getElementById('standby-skip-btn')?.addEventListener('click', () => {
      send({ type: 'standby-skip' });
    });
  }
}

// ── Mixer slider handlers ─────────────────────────────────────────────────
function mxMakeSlider(slider, valueEl, msgType, fmt) {
  let t = null;
  slider.addEventListener('input', () => {
    valueEl.textContent = fmt(slider.value);
    clearTimeout(t);
    t = setTimeout(() => send({ type: msgType, volume: Number(slider.value) }), 150);
  });
}
mxMakeSlider(mxStandbyVolSlider, mxStandbyVolValue, 'set-standby-volume', v => v);
mxMakeSlider(mxVideoVolSlider,   mxVideoVolValue,   'set-video-volume',   v => v);
mxMakeSlider(mxMicVolSlider,     mxMicVolValue,     'set-mic-volume',     v => v);

mxMicMuteBtn.addEventListener('change', () => send({ type: 'mic-mute', muted: !mxMicMuteBtn.checked }));

// ── Mixer set standby by URL ──────────────────────────────────────────────
mxSetBtn.addEventListener('click', () => {
  const url = mxUrlInput.value.trim();
  if (!url) { mxUrlInput.focus(); return; }
  if (state.standbyPlaylistId) send({ type: 'clear-standby' });
  send({ type: 'set-standby-playlist', url });
  mxUrlInput.value = '';
});
mxUrlInput.addEventListener('keydown', e => { if (e.key === 'Enter') mxSetBtn.click(); });

// ── Mixer clear standby ───────────────────────────────────────────────────
mxClearStandbyBtn.addEventListener('click', () => send({ type: 'clear-standby' }));
// ── Mixer playlist track list ────────────────────────────────────────────
function mxHighlightCurrentTrack() {
  const currentVid = state.standbyTrack?.videoId;
  mxTrackListEl.querySelectorAll('.qi[data-vid]').forEach(li => {
    li.classList.toggle('qi-current', li.dataset.vid === currentVid);
  });
}

async function mxLoadTracks(playlistId) {
  if (!playlistId) {
    mxTrackCard.hidden = true;
    mxLoadedPlaylistId = null;
    mxTrackCount.textContent = '0';
    return;
  }
  if (playlistId === mxLoadedPlaylistId) {
    mxHighlightCurrentTrack();
    return;
  }
  mxTrackCard.hidden = false;
  mxTrackListEl.innerHTML = '<li class="empty">Loading…</li>';
  try {
    const r = await fetch(
      '/api/mixer/playlist-items?id=' + encodeURIComponent(playlistId) +
      '&s=' + encodeURIComponent(sessionId)
    );
    const data = await r.json();
    if (data.error === 'not_configured') {
      mxTrackListEl.innerHTML = '<li class="empty">Requires a YouTube API key</li>';
      return;
    }
    if (data.error || !data.items) {
      mxTrackListEl.innerHTML = '<li class="empty">Could not load tracks</li>';
      return;
    }
    mxLoadedPlaylistId = playlistId;
    mxTrackCount.textContent = String(data.items.length);
    mxTrackListEl.innerHTML = data.items.length === 0
      ? '<li class="empty">No tracks found</li>'
      : data.items.map((item, i) =>
          '<li class="qi" data-vid="' + esc(item.videoId) + '">' +
            '<span class="qi-num">' + (i + 1) + '</span>' +
            '<img class="qi-thumb" src="' + esc(item.thumbnail || thumb(item.videoId)) + '" alt="" loading="lazy">' +
            '<div class="qi-info">' +
              '<span class="qi-title" title="' + esc(item.title) + '">' + esc(item.title) + '</span>' +
            '</div>' +
          '</li>'
        ).join('');
    mxHighlightCurrentTrack();
  } catch {
    mxTrackListEl.innerHTML = '<li class="empty">Failed to load tracks</li>';
  }
}
// ── Mixer playlist search ─────────────────────────────────────────────────
async function mxDoSearch() {
  const q = mxSearchInput.value.trim();
  if (!q) { mxSearchInput.focus(); return; }
  mxSearchBtn.disabled = true;
  mxSearchBtn.textContent = '…';
  mxSearchStatus.hidden = false;
  mxSearchStatus.className = 'mixer-search-status';
  mxSearchStatus.textContent = 'Searching…';
  mxSearchResults.innerHTML = '';
  try {
    const r    = await fetch('/api/mixer/search?q=' + encodeURIComponent(q));
    const data = await r.json();
    if (data.error === 'not_configured') {
      mxSearchStatus.textContent = 'Playlist search requires a YouTube API key — URL paste still works.';
      mxSearchStatus.className = 'mixer-search-status warn';
      return;
    }
    if (data.error) {
      mxSearchStatus.textContent = 'Search failed — try again.';
      mxSearchStatus.className = 'mixer-search-status warn';
      return;
    }
    const items = data.items || [];
    if (items.length === 0) {
      mxSearchStatus.textContent = 'No playlists found.';
      return;
    }
    mxSearchStatus.hidden = true;
    mxSearchResults.innerHTML = items.map(item =>
      '<div class="sr-item">' +
        '<img class="sr-thumb" src="' + esc(item.thumbnail) + '" alt="" loading="lazy">' +
        '<div class="sr-info">' +
          '<div class="sr-title" title="' + esc(item.title) + '">' + esc(item.title) + '</div>' +
          '<div class="sr-channel">' + esc(item.channelTitle) + '</div>' +
        '</div>' +
        '<button class="secondary btn-use" data-id="' + esc(item.playlistId) + '" data-title="' + esc(item.title) + '" data-thumb="' + esc(item.thumbnail) + '">Use</button>' +
      '</div>'
    ).join('');
  } catch {
    mxSearchStatus.textContent = 'Search failed — check your connection.';
    mxSearchStatus.className = 'mixer-search-status warn';
  } finally {
    mxSearchBtn.disabled = false;
    mxSearchBtn.textContent = 'Search';
  }
}
mxSearchBtn.addEventListener('click', mxDoSearch);
mxSearchInput.addEventListener('keydown', e => { if (e.key === 'Enter') mxDoSearch(); });

mxSearchResults.addEventListener('click', e => {
  const btn = e.target.closest('.btn-use');
  if (!btn) return;
  if (state.standbyPlaylistId) send({ type: 'clear-standby' });
  send({ type: 'set-standby-playlist', url: 'https://www.youtube.com/playlist?list=' + btn.dataset.id, title: btn.dataset.title, thumbnail: btn.dataset.thumb || undefined });
  btn.textContent = '✓ Set';
  btn.disabled = true;
  setTimeout(() => { btn.textContent = 'Use'; btn.disabled = false; }, 2000);
});

// ── Init ───────────────────────────────────────────────────────────────────
// Devices modal
requesterBadge.addEventListener('click', () => { renderDevicesModal(); devicesModal.hidden = false; });
document.getElementById('devices-modal-close').addEventListener('click', () => { devicesModal.hidden = true; });
devicesModal.addEventListener('click', e => { if (e.target === devicesModal) devicesModal.hidden = true; });
dmResetBtn.addEventListener('click',  () => send({ type: 'reset-requester-presence' }));
dmUnbanBtn.addEventListener('click',  () => send({ type: 'unban-all-devices' }));
dmUnblockBtn.addEventListener('click', () => send({ type: 'clear-blocked-devices' }));
requeueBtn.addEventListener('click', () => send({ type: 'requeue' }));
connect();
