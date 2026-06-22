'use strict';

// ── Device token ───────────────────────────────────────────────────────────
// A persistent random identifier stored in localStorage. In crowd mode the
// server uses this to enforce one-pending-request-per-device. Clearing
// localStorage resets the token (intentional escape hatch for the user).
function getDeviceToken() {
  let t = localStorage.getItem('kp_device');
  if (!t) {
    const arr = new Uint8Array(20);
    crypto.getRandomValues(arr);
    t = Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
    localStorage.setItem('kp_device', t);
  }
  return t;
}
const deviceToken = getDeviceToken();

// ── DOM refs ───────────────────────────────────────────────────────────────
const sessionId      = new URLSearchParams(location.search).get('s');
const invalidSection = document.getElementById('invalid-section');
const formSection    = document.getElementById('form-section');
const blockedSection = document.getElementById('blocked-section');
const bannedSection  = document.getElementById('banned-section');
const slotSection    = document.getElementById('slot-section');
const successSection = document.getElementById('success-section');
const requestForm    = document.getElementById('request-form');
const nameInput      = document.getElementById('request-name');
const artistInput    = document.getElementById('request-artist');
const titleInput     = document.getElementById('request-title');
const submitBtn      = document.getElementById('submit-btn');
const wsError        = document.getElementById('ws-error');

let ws;
let currentMode     = 'kiosk'; // updated from server state messages
let isBlocked       = false;   // crowd-mode: waiting for this device to be cleared
let postSubmitTimer = null;

if (!sessionId) {
  invalidSection.classList.remove('hidden');
} else {
  formSection.classList.remove('hidden');
  connect();
}

// Retry after kiosk slot-taken screen.
const slotRetryBtn = document.getElementById('slot-retry-btn');
if (slotRetryBtn) {
  slotRetryBtn.addEventListener('click', () => {
    slotSection.classList.add('hidden');
    connect();
  });
}

// ── UI state helpers ───────────────────────────────────────────────────────

function showForm() {
  formSection.classList.remove('hidden');
  blockedSection.classList.add('hidden');
  successSection.classList.add('hidden');
  bannedSection.classList.add('hidden');
  slotSection.classList.add('hidden');
}

function showBlocked() {
  formSection.classList.add('hidden');
  blockedSection.classList.remove('hidden');
  successSection.classList.add('hidden');
  bannedSection.classList.add('hidden');
  slotSection.classList.add('hidden');
}

function showSuccess() {
  formSection.classList.add('hidden');
  blockedSection.classList.add('hidden');
  successSection.classList.remove('hidden');
  bannedSection.classList.add('hidden');
  slotSection.classList.add('hidden');
}

function showBanned() {
  formSection.classList.add('hidden');
  blockedSection.classList.add('hidden');
  successSection.classList.add('hidden');
  bannedSection.classList.remove('hidden');
  slotSection.classList.add('hidden');
  submitBtn.disabled = true;
}

function showSlotTaken() {
  formSection.classList.add('hidden');
  blockedSection.classList.add('hidden');
  successSection.classList.add('hidden');
  bannedSection.classList.add('hidden');
  slotSection.classList.remove('hidden');
  submitBtn.disabled = true;
}

// ── WebSocket ──────────────────────────────────────────────────────────────

function connect() {
  ws = new WebSocket(
    (location.protocol === 'https:' ? 'wss:' : 'ws:') +
    '//' + location.host +
    '/?s=' + encodeURIComponent(sessionId) + '&role=request'
  );

  ws.onopen = () => {
    wsError.classList.add('hidden');
    // Announce device token so the server can send back our current blocked status.
    ws.send(JSON.stringify({ type: 'hello', deviceToken }));
    if (!isBlocked) submitBtn.disabled = false;
  };

  ws.onclose = (ev) => {
    if (ev.code === 4409) {
      // Kiosk slot is occupied by another device — don't auto-reconnect.
      showSlotTaken();
      return;
    }
    submitBtn.disabled = true;
    wsError.classList.remove('hidden');
    setTimeout(connect, 3000);
  };

  ws.onmessage = (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }

    if (msg.type === 'device-status') {
      // Server's authoritative answer to our hello (or a re-assertion).
      currentMode = msg.mode || 'kiosk';
      if (msg.banned) {
        showBanned();
        return;
      }
      isBlocked = !!msg.blocked;
      if (isBlocked) {
        submitBtn.disabled = true;
        showBlocked();
      } else {
        submitBtn.disabled = (ws.readyState !== WebSocket.OPEN);
        if (blockedSection.classList.contains('hidden') &&
            successSection.classList.contains('hidden')) {
          showForm();
        }
      }

    } else if (msg.type === 'device-banned') {
      if (msg.token === deviceToken) {
        clearTimeout(postSubmitTimer);
        showBanned();
      }

    } else if (msg.type === 'device-cleared') {
      // This device's token was unblocked (controller processed our request).
      if (msg.token === deviceToken) {
        isBlocked = false;
        clearTimeout(postSubmitTimer);
        requestForm.reset();
        showForm();
        submitBtn.disabled = (ws.readyState !== WebSocket.OPEN);
        nameInput.focus();
      }

    } else if (msg.type === 'state') {
      // Keep mode in sync. If the controller switches back to kiosk while we're
      // showing the blocked screen, release the device immediately.
      const incoming = msg.requestMode || 'kiosk';
      if (incoming !== currentMode) {
        currentMode = incoming;
        if (currentMode === 'kiosk' && isBlocked) {
          isBlocked = false;
          requestForm.reset();
          showForm();
          submitBtn.disabled = (ws.readyState !== WebSocket.OPEN);
        }
      }
    }
  };
}

// ── Form submit ────────────────────────────────────────────────────────────

requestForm.addEventListener('submit', e => {
  e.preventDefault();

  const title = titleInput.value.trim();
  if (!title) { titleInput.focus(); return; }
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  ws.send(JSON.stringify({
    type:        'request',
    name:        nameInput.value.trim(),
    artist:      artistInput.value.trim(),
    title,
    deviceToken, // always included; server only acts on it in crowd mode
  }));

  if (currentMode === 'crowd') {
    // Optimistically enter the blocked state. The server will re-assert
    // via device-status if something goes wrong.
    isBlocked = true;
    submitBtn.disabled = true;
    showBlocked();
  } else {
    // Kiosk mode: brief success flash, then reset.
    showSuccess();
    postSubmitTimer = setTimeout(() => {
      requestForm.reset();
      showForm();
      nameInput.focus();
    }, 4000);
  }
});
