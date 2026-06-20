'use strict';

const sessionId = new URLSearchParams(location.search).get('s');

const invalidSection = document.getElementById('invalid-section');
const formSection    = document.getElementById('form-section');
const successSection = document.getElementById('success-section');
const requestForm    = document.getElementById('request-form');
const nameInput      = document.getElementById('request-name');
const artistInput    = document.getElementById('request-artist');
const titleInput     = document.getElementById('request-title');
const submitBtn      = document.getElementById('submit-btn');
const wsError        = document.getElementById('ws-error');

let ws;

if (!sessionId) {
  invalidSection.classList.remove('hidden');
} else {
  formSection.classList.remove('hidden');
  connect();
}

// ── WebSocket ──────────────────────────────────────────────────────────────

function connect() {
  ws = new WebSocket(
    (location.protocol === 'https:' ? 'wss:' : 'ws:') +
    '//' + location.host +
    '/?s=' + encodeURIComponent(sessionId) + '&role=request'
  );

  ws.onopen = () => {
    submitBtn.disabled = false;
    wsError.classList.add('hidden');
  };

  ws.onclose = () => {
    submitBtn.disabled = true;
    wsError.classList.remove('hidden');
    // Reconnect so the button re-enables if the server comes back.
    setTimeout(connect, 3000);
  };
}

// ── Form submit ────────────────────────────────────────────────────────────

requestForm.addEventListener('submit', e => {
  e.preventDefault();

  const title = titleInput.value.trim();
  if (!title) { titleInput.focus(); return; }
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  ws.send(JSON.stringify({
    type:   'request',
    name:   nameInput.value.trim(),
    artist: artistInput.value.trim(),
    title,
  }));

  formSection.classList.add('hidden');
  successSection.classList.remove('hidden');

  setTimeout(() => {
    requestForm.reset();
    successSection.classList.add('hidden');
    formSection.classList.remove('hidden');
    nameInput.focus();
  }, 4000);
});
