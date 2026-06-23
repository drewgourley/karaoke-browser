'use strict';

const loginSection  = document.getElementById('login-section');
const tokenForm     = document.getElementById('token-form');
const tokenInput    = document.getElementById('token-input');
const tokenError    = document.getElementById('token-error');
const createSection = document.getElementById('create-section');
const createBtn     = document.getElementById('create-btn');
const createError   = document.getElementById('create-error');
const roomLinks     = document.getElementById('room-links');
const controllerBtn = document.getElementById('controller-btn');
const playerBtn     = document.getElementById('player-btn');
const logoutBtn     = document.getElementById('logout-btn');
const newRoomBtn    = document.getElementById('new-room-btn');
const requestLinkRow  = document.getElementById('request-link-row');
const requestUrlInput = document.getElementById('request-url');
const copyRequestBtn  = document.getElementById('copy-request-btn');
const requestQrBtn    = document.getElementById('request-qr-btn');
const requestQrModal  = document.getElementById('request-qr-modal');
const requestQrImg    = document.getElementById('request-qr-img');
const requestQrClose  = document.getElementById('request-qr-close');
const requestLinkLabel = document.getElementById('request-link-label');
const reqModeToggle   = document.getElementById('req-mode-toggle');
const displayLinkRow   = document.getElementById('display-link-row');
const displayUrlInput  = document.getElementById('display-url-input');
const copyDisplayBtn   = document.getElementById('copy-display-btn');
const openDisplayLink  = document.getElementById('open-display-link');
const openRequestLink  = document.getElementById('open-request-link');
const displayQrBtn     = document.getElementById('display-qr-btn');
const displayQrModal   = document.getElementById('display-qr-modal');
const displayQrImg     = document.getElementById('display-qr-img');
const displayQrClose   = document.getElementById('display-qr-close');

let currentSessionId = null;
let authMode = false; // true when AUTH_TOKEN is active on the server
let currentMode = 'kiosk';

// ── Session persistence (localStorage) ──────────────────────────────────────
const LS_KEY = 'kk_session';
function saveSessionToStorage()  { try { localStorage.setItem(LS_KEY, JSON.stringify({ sessionId: currentSessionId, requestMode: currentMode })); } catch {} }
function clearSessionFromStorage() { try { localStorage.removeItem(LS_KEY); } catch {} }
function loadSessionFromStorage()  { try { return JSON.parse(localStorage.getItem(LS_KEY) || 'null'); } catch { return null; } }

async function tryRestoreOrShowCreate() {
  const stored = loadSessionFromStorage();
  if (!stored || !stored.sessionId) return showCreate();
  try {
    const r = await fetch('/api/session?s=' + encodeURIComponent(stored.sessionId));
    if (!r.ok) throw new Error('gone');
    const { sessionId, requestMode } = await r.json();
    currentSessionId = sessionId;
    currentMode = requestMode || 'kiosk';
    showRoomLinks();
  } catch {
    clearSessionFromStorage();
    showCreate();
  }
}

// ── Redirect helpers ──────────────────────────────────────────────────────

const redirectTarget = new URLSearchParams(location.search).get('redirect');

// Only allow same-site paths to prevent open-redirect abuse.
const SAFE_PREFIXES = ['/controller/', '/player/', '/request/'];
function isSafeRedirect(url) {
  return typeof url === 'string' && SAFE_PREFIXES.some(p => url.startsWith(p));
}

function doRedirect(sessionId, target) {
  const suffix = target.startsWith('/player') ? 'P' : 'C';
  window.name = sessionId + suffix;
  location.replace(target);
}

async function autoStartAndRedirect() {
  try {
    const res = await fetch('/api/session/create', { method: 'POST' });
    if (!res.ok) throw new Error();
    const { sessionId } = await res.json();
    currentSessionId = sessionId;
    doRedirect(sessionId, redirectTarget);
  } catch {
    showCreate();
  }
}

// ── Boot: check auth status ────────────────────────────────────────────────

fetch('/api/auth-status')
  .then(r => r.json())
  .then(({ authRequired, authed }) => {
    authMode = authRequired;
    if (authRequired && !authed) {
      showLogin();
    } else if (authRequired && isSafeRedirect(redirectTarget)) {
      // Auth mode + already authed + came from a protected page.
      // Session is deterministic in auth mode so it's safe to auto-proceed.
      autoStartAndRedirect();
    } else {
      tryRestoreOrShowCreate();
    }
  })
  .catch(() => tryRestoreOrShowCreate()); // if the check fails, optimistically show create

// ── Views ──────────────────────────────────────────────────────────────────

function showLogin(withError = false) {
  loginSection.classList.remove('hidden');
  createSection.classList.add('hidden');
  roomLinks.classList.add('hidden');
  tokenError.classList.toggle('hidden', !withError);
  if (!withError) tokenInput.value = '';
  tokenInput.focus();
}

function showCreate() {
  loginSection.classList.add('hidden');
  createSection.classList.remove('hidden');
  roomLinks.classList.add('hidden');
  newRoomBtn.classList.add('hidden');
  createBtn.disabled = false;
  createBtn.textContent = 'Start Karaoke Night';
}

function updateLinkLabel(mode) {
  if (!requestLinkLabel) return;
  requestLinkLabel.textContent = mode === 'kiosk'
    ? '🔗 Use this link to open the song request form'
    : '🔗 Share this link so guests can request songs';
  // In kiosk mode show the QR button; crowd mode hides it (display page QR serves that purpose).
  if (requestQrBtn) requestQrBtn.classList.toggle('hidden', mode === 'crowd');
  // Show the crowd display link only in crowd mode.
  if (displayLinkRow) {
    displayLinkRow.classList.toggle('hidden', mode !== 'crowd');
    if (displayQrBtn) displayQrBtn.classList.toggle('hidden', mode !== 'crowd');
    if (mode !== 'crowd') {
      if (displayQrImg) { displayQrImg.src = ''; }
    }
    if (mode === 'crowd' && currentSessionId) {
      const url = location.origin + '/display/?s=' + encodeURIComponent(currentSessionId);
      if (displayUrlInput)  displayUrlInput.value = url;
      if (openDisplayLink)  openDisplayLink.href  = url;
      if (displayQrImg && !displayQrImg.src.startsWith('data:')) {
        fetch('/api/qr?s=' + encodeURIComponent(currentSessionId) + '&data=' + encodeURIComponent(url))
          .then(r => r.json())
          .then(({ dataUrl }) => { if (dataUrl) { displayQrImg.src = dataUrl; } })
          .catch(() => {});
      }
    }
  }
}

function showRoomLinks() {
  createSection.classList.add('hidden');
  loginSection.classList.add('hidden');
  roomLinks.classList.remove('hidden');
  saveSessionToStorage();
  // In auth mode there's only one room — offer logout, not a new room.
  logoutBtn.classList.toggle('hidden', !authMode);
  newRoomBtn.classList.toggle('hidden', authMode);
  // Populate and reveal the request share link.
  const requestUrl = location.origin + '/request/?s=' + encodeURIComponent(currentSessionId);
  requestUrlInput.value = requestUrl;
  if (openRequestLink) openRequestLink.href = requestUrl;
  requestLinkRow.classList.remove('hidden');
  // Set mode toggle to reflect current session mode.
  if (reqModeToggle) reqModeToggle.dataset.mode = currentMode;
  updateLinkLabel(currentMode);
  connectIngressWs();
  // Fetch and cache the request QR code into the modal img.
  fetch('/api/qr?s=' + encodeURIComponent(currentSessionId) + '&data=' + encodeURIComponent(requestUrl))
    .then(r => r.json())
    .then(({ dataUrl }) => { if (dataUrl && requestQrImg) requestQrImg.src = dataUrl; })
    .catch(() => { /* QR is optional; silently skip on failure */ });
}

// ── Login ──────────────────────────────────────────────────────────────────

// Hash the password client-side with SHA-256, then POST the hash to /api/login.
// The raw password never leaves the browser.
tokenForm.addEventListener('submit', async e => {
  e.preventDefault();
  const password = tokenInput.value.trim();
  if (!password) return;

  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(password));
  const hash = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');

  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hash }),
    });
    if (res.ok) {
      if (isSafeRedirect(redirectTarget)) {
        autoStartAndRedirect();
      } else {
        showCreate();
      }
    } else {
      showLogin(true);
    }
  } catch {
    showLogin(true);
  }
});

// ── Create room ────────────────────────────────────────────────────────────

controllerBtn.addEventListener('click', () => {
  if (currentSessionId) window.open('/controller/', currentSessionId + 'C');
});
playerBtn.addEventListener('click', () => {
  if (currentSessionId) window.open('/player/', currentSessionId + 'P');
});

createBtn.addEventListener('click', async () => {
  createBtn.disabled = true;
  createBtn.textContent = 'Setting up\u2026';
  createError.classList.add('hidden');
  try {
    const res = await fetch('/api/session/create', { method: 'POST' });
    if (!res.ok) throw new Error('Server error');
    const { sessionId, requestMode } = await res.json();
    currentSessionId = sessionId;
    currentMode = requestMode || 'kiosk';
    if (isSafeRedirect(redirectTarget)) {
      doRedirect(sessionId, redirectTarget);
    } else {
      showRoomLinks();
    }
  } catch {
    createError.classList.remove('hidden');
    createBtn.disabled = false;
    createBtn.textContent = 'Start Karaoke Night';
  }
});

// ── New room / Logout ──────────────────────────────────────────────────────

logoutBtn.addEventListener('click', () => {
  clearSessionFromStorage();
  fetch('/api/logout', { method: 'POST' })
    .finally(() => {
      currentSessionId = null;
      showLogin();
    });
});

newRoomBtn.addEventListener('click', () => {
  clearSessionFromStorage();
  currentSessionId = null;
  showCreate();
});

// ── Copy request link ────────────────────────────────────────────────

copyRequestBtn.addEventListener('click', () => {
  navigator.clipboard.writeText(requestUrlInput.value).then(() => {
    const orig = copyRequestBtn.textContent;
    copyRequestBtn.textContent = 'Copied ✓';
    setTimeout(() => { copyRequestBtn.textContent = orig; }, 2000);
  }).catch(() => {
    requestUrlInput.select();
  });
});

copyDisplayBtn.addEventListener('click', () => {
  navigator.clipboard.writeText(displayUrlInput.value).then(() => {
    const orig = copyDisplayBtn.textContent;
    copyDisplayBtn.textContent = 'Copied ✓';
    setTimeout(() => { copyDisplayBtn.textContent = orig; }, 2000);
  }).catch(() => { displayUrlInput.select(); });
});

// ── Live mode sync via WebSocket ───────────────────────────────────────────
// Connects after a session is established so the toggle reflects controller
// changes without requiring a page refresh.
let ingressWs = null;
let ingressReconnectTimer = null;

function connectIngressWs() {
  if (!currentSessionId) return;
  clearTimeout(ingressReconnectTimer);
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ingressWs = new WebSocket(proto + '//' + location.host + '/?s=' + encodeURIComponent(currentSessionId) + '&role=ingress');
  ingressWs.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'state' && msg.requestMode && msg.requestMode !== currentMode) {
        currentMode = msg.requestMode;
        saveSessionToStorage();
        if (reqModeToggle) reqModeToggle.dataset.mode = currentMode;
        updateLinkLabel(currentMode);
      }
    } catch { /* ignore */ }
  };
  ingressWs.onclose = () => {
    ingressReconnectTimer = setTimeout(connectIngressWs, 3000);
  };
}

// ── Mode toggle ────────────────────────────────────────────────────────────
if (reqModeToggle) {
  reqModeToggle.addEventListener('click', async () => {
    if (!currentSessionId) return;
    const newMode = currentMode === 'crowd' ? 'kiosk' : 'crowd';
    try {
      const res = await fetch('/api/session/mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: currentSessionId, mode: newMode }),
      });
      if (!res.ok) return;
      currentMode = newMode;
      saveSessionToStorage();
      reqModeToggle.dataset.mode = newMode;
      updateLinkLabel(newMode);
    } catch { /* ignore */ }
  });
}

// ── Display QR modal ───────────────────────────────────────────────────────
function closeDisplayQrModal() { displayQrModal.classList.add('hidden'); }

if (displayQrBtn)   displayQrBtn.addEventListener('click', () => displayQrModal.classList.remove('hidden'));
if (displayQrClose) displayQrClose.addEventListener('click', closeDisplayQrModal);
if (displayQrModal) displayQrModal.addEventListener('click', e => { if (e.target === displayQrModal) closeDisplayQrModal(); });

// ── Request QR modal ───────────────────────────────────────────────────────
function closeRequestQrModal() { requestQrModal.classList.add('hidden'); }

if (requestQrBtn)   requestQrBtn.addEventListener('click', () => requestQrModal.classList.remove('hidden'));
if (requestQrClose) requestQrClose.addEventListener('click', closeRequestQrModal);
if (requestQrModal) requestQrModal.addEventListener('click', e => { if (e.target === requestQrModal) closeRequestQrModal(); });
