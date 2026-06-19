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
const newRoomBtn    = document.getElementById('new-room-btn');
const logoutBtn     = document.getElementById('logout-btn');

let currentSessionId = null;
let authMode = false; // true when AUTH_TOKEN is active on the server

// ── Boot: check auth status ────────────────────────────────────────────────

fetch('/api/auth-status')
  .then(r => r.json())
  .then(({ authRequired, authed }) => {
    authMode = authRequired;
    if (authRequired && !authed) {
      showLogin();
    } else {
      showCreate();
    }
  })
  .catch(() => showCreate()); // if the check fails, optimistically show create

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
  createBtn.disabled = false;
  createBtn.textContent = 'Start Karaoke Night';
}

function showRoomLinks() {
  createSection.classList.add('hidden');
  loginSection.classList.add('hidden');
  roomLinks.classList.remove('hidden');
  // In auth mode there's only one room — offer logout, not a new room.
  newRoomBtn.classList.toggle('hidden', authMode);
  logoutBtn.classList.toggle('hidden', !authMode);
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
      showCreate();
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
    const { sessionId } = await res.json();
    currentSessionId = sessionId;
    showRoomLinks();
  } catch {
    createError.classList.remove('hidden');
    createBtn.disabled = false;
    createBtn.textContent = 'Start Karaoke Night';
  }
});

// ── New room / Logout ──────────────────────────────────────────────────────

newRoomBtn.addEventListener('click', () => {
  currentSessionId = null;
  showCreate();
});

logoutBtn.addEventListener('click', () => {
  fetch('/api/logout', { method: 'POST' })
    .finally(() => {
      currentSessionId = null;
      showLogin();
    });
});
