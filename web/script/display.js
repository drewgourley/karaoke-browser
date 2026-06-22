'use strict';

// ── Fullscreen button ────────────────────────────────────────────────────────────
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

// ── QR display ─────────────────────────────────────────────────────────────
const sessionId = new URLSearchParams(location.search).get('s');
const displayPage = document.getElementById('display-page');
const errorPage   = document.getElementById('error-page');
const qrImg       = document.getElementById('qr-img');
const urlPill     = document.getElementById('url-pill');

function showError() {
  displayPage.hidden = true;
  errorPage.hidden   = false;
}

if (!sessionId) {
  showError();
} else {
  const requestUrl = location.origin + '/request/?s=' + encodeURIComponent(sessionId);
  urlPill.textContent = requestUrl;

  fetch('/api/qr?s=' + encodeURIComponent(sessionId) + '&data=' + encodeURIComponent(requestUrl))
    .then(r => {
      if (!r.ok) { showError(); return null; }
      return r.json();
    })
    .then(d => {
      if (!d) return;
      if (d.dataUrl) {
        qrImg.src = d.dataUrl;
      } else {
        showError();
      }
    })
    .catch(() => showError());
}
