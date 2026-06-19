'use strict';

const loginSection = document.getElementById('login-section');
const linksSection = document.getElementById('links-section');
const tokenForm    = document.getElementById('token-form');
const tokenInput   = document.getElementById('token-input');
const errorMsg     = document.getElementById('error-msg');
const logoutBtn    = document.getElementById('logout-btn');

// Was a ?token= present when this page loaded? (used to detect a failed attempt)
const hadTokenParam = new URLSearchParams(location.search).has('token');

function showLogin(withError) {
  linksSection.classList.add('hidden');
  loginSection.classList.remove('hidden');
  errorMsg.classList.toggle('hidden', !withError);
  if (!withError) tokenInput.value = '';
}

function showLinks() {
  loginSection.classList.add('hidden');
  linksSection.classList.remove('hidden');
  // Clean ?token= from the URL bar without reloading
  if (hadTokenParam) history.replaceState(null, '', '/');
}

// Check authentication status on load
fetch('/api/auth-status')
  .then(r => r.json())
  .then(({ authed }) => {
    if (authed) {
      showLinks();
    } else {
      // If we just tried a token (via ?token=) and it failed, show the error
      showLogin(hadTokenParam);
    }
  })
  .catch(() => showLogin(false));

// Token form: redirect to /?token=<value> so the server can set the HttpOnly cookie
tokenForm.addEventListener('submit', e => {
  e.preventDefault();
  const token = tokenInput.value.trim();
  if (!token) return;
  location.href = '/?token=' + encodeURIComponent(token);
});

// Logout: expire the auth cookie then return to login form
logoutBtn.addEventListener('click', () => {
  fetch('/api/logout', { method: 'POST' })
    .then(() => showLogin(false))
    .catch(() => showLogin(false));
});
