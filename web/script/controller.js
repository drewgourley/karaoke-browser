// ── State ──────────────────────────────────────────────────────────────────
let state = { queue: [], nowPlaying: null };
let dragFrom = null;

// ── Session ──────────────────────────────────────────────────────────────
// Session ID is carried in window.name (set by the opener via window.open(url, id+'C')).
// It is never in the page URL, so it doesn't appear in the address bar or browser history.
const sessionId = window.name ? window.name.slice(0, -1) : null;
if (!sessionId) { location.replace('/'); throw new Error('No session'); }

document.getElementById('open-player-btn').addEventListener('click', () => {
  window.open('/player/', sessionId + 'P');
});

// ── Elements ───────────────────────────────────────────────────────────────
const dot        = document.getElementById('dot');
const statusText = document.getElementById('status-text');
const urlInput   = document.getElementById('url-input');
const titleInput = document.getElementById('title-input');
const addBtn     = document.getElementById('add-btn');
const fetchBtn   = document.getElementById('fetch-btn');
const npEl       = document.getElementById('now-playing');
const queueEl    = document.getElementById('queue-list');
const qCount     = document.getElementById('q-count');
const clearBtn   = document.getElementById('clear-btn');

// ── WebSocket ──────────────────────────────────────────────────────────────
let ws;

function connect() {
  ws = new WebSocket((location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + '/?s=' + encodeURIComponent(sessionId));

  ws.onopen = () => {
    dot.className = 'dot on';
    statusText.textContent = 'KC Connected';
  };
  ws.onclose = () => {
    dot.className = 'dot off';
    statusText.textContent = 'KC Disconnected – reconnecting…';
    setTimeout(connect, 3000);
  };
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'state') { state = msg; render(); }
  };
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
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
}

function renderNP() {
  const np = state.nowPlaying;
  if (!np) {
    npEl.innerHTML = '<span class="np-idle">Nothing playing</span>';
    return;
  }

  if (np.embedFailed) {
    npEl.innerHTML =
      '<div class="embed-warn">' +
        '<div class="embed-warn-title">⚠️ ' + esc(np.title) + '</div>' +
        '<div class="embed-warn-msg">This video can\'t be embedded — it\'s playing on YouTube in the player window. Skip when the song is done.</div>' +
        '<div class="row" style="margin-top:0.25rem">' +
          '<a class="btn" href="' + esc(np.url) + '" target="_blank" rel="noopener noreferrer">Open in YouTube</a>' +
          '<button class="secondary" id="skip-btn">⏭ Skip</button>' +
        '</div>' +
      '</div>';
    document.getElementById('skip-btn').addEventListener('click', () => send({ type: 'next' }));
    return;
  }

  const isPaused = !!state.paused;
  npEl.innerHTML =
    '<div class="np-wrap">' +
      '<img class="np-thumb" src="' + thumb(np.videoId) + '" alt="">' +
      '<div class="np-info">' +
        '<div class="np-title" title="' + esc(np.title) + '">' + esc(np.title) + '</div>' +
        (np.singer ? '<div class="np-singer">🎤 ' + esc(np.singer) + '</div>' : '') +
        '<div class="row">' +
          '<button class="secondary icon" id="restart-btn">↺ Restart</button>' +
          '<button class="secondary icon" id="playpause-btn">' + (isPaused ? '▶ Begin' : '⏸ Pause') + '</button>' +
          '<button class="secondary icon" id="skip-btn">⏭ Skip</button>' +
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
  singerInput.value = '';
  singerModal.style.display = 'flex';
  setTimeout(() => singerInput.focus(), 50);
}

function confirmModal() {
  if (!pendingAdd) return;
  const { url, title, onConfirm } = pendingAdd;
  const singer = singerInput.value.trim();
  send({ type: 'add', url, title, singer: singer || undefined });
  if (onConfirm) onConfirm();
  pendingAdd = null;
  singerModal.style.display = 'none';
}

function closeModal() {
  pendingAdd = null;
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

// ── Init ───────────────────────────────────────────────────────────────────
connect();
