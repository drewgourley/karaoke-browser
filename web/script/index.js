'use strict';

const createBtn     = document.getElementById('create-btn');
const createError   = document.getElementById('create-error');
const roomLinks     = document.getElementById('room-links');
const controllerBtn = document.getElementById('controller-btn');
const playerBtn     = document.getElementById('player-btn');
const newRoomBtn    = document.getElementById('new-room-btn');

let currentSessionId = null;

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
    createBtn.closest('.card').classList.add('hidden');
    roomLinks.classList.remove('hidden');
  } catch {
    createError.classList.remove('hidden');
    createBtn.disabled = false;
    createBtn.textContent = 'Start Karaoke Night';
  }
});

newRoomBtn.addEventListener('click', () => {
  currentSessionId = null;
  roomLinks.classList.add('hidden');
  createBtn.closest('.card').classList.remove('hidden');
  createBtn.disabled = false;
  createBtn.textContent = 'Start Karaoke Night';
});
