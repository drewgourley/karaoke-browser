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

function applyTheme(t) {
  const root = document.documentElement;
  const defs  = ['#4cc9f0', '#4361ee', '#7c3aed', '#f72585', '#ff6b35', '#ffd166', '#06d6a0', '#3a0ca3'];
  (t.standbyColors || defs).forEach((c, i) => root.style.setProperty(`--sc${i + 1}`, c || defs[i]));
  root.style.setProperty('--scq-heading-color',  t.standbyTitleColor || '#ffffff');
  const tSz = t.standbyTitleOutlineSize ?? 20;
  root.style.setProperty('--scq-heading-stroke', tSz > 0 ? `${Math.ceil(tSz / 2)}px ${t.standbyTitleOutline || '#000000'}` : '0px transparent');
  root.style.setProperty('--scq-sub-color',  t.standbySubtitleColor || '#ffffff');
  const sSz = t.standbySubtitleOutlineSize ?? 8;
  root.style.setProperty('--scq-sub-stroke', sSz > 0 ? `${Math.ceil(sSz / 2)}px ${t.standbySubtitleOutline || '#000000'}` : '0px transparent');
}

if (!sessionId) {
  showError();
} else {
  const requestUrl = location.origin + '/request/?s=' + encodeURIComponent(sessionId);
  urlPill.textContent = requestUrl;

  // Fetch theme + QR in parallel.
  Promise.all([
    fetch('/api/standby-theme?s=' + encodeURIComponent(sessionId)).then(r => r.ok ? r.json() : null),
    fetch('/api/qr?s=' + encodeURIComponent(sessionId) + '&data=' + encodeURIComponent(requestUrl))
      .then(r => { if (!r.ok) { showError(); return null; } return r.json(); }),
  ]).then(([theme, qr]) => {
    if (theme) applyTheme(theme);
    if (qr && qr.dataUrl) {
      qrImg.src = qr.dataUrl;
    } else if (!qr) {
      showError();
    }
  }).catch(() => showError());
}
