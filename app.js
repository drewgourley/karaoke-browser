'use strict';
require('dotenv').config();

const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const path = require('path');

const app = express();
app.set('trust proxy', 1); // trust X-Forwarded-* headers from reverse proxy
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const { randomBytes } = require('crypto');

// ── Sessions ──────────────────────────────────────────────────────────────────
// Map<sessionId, { queue, nowPlaying, paused, nextId, clients: Set<ws>, lastActivity }>

const sessions = new Map();
const SESSION_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours of inactivity

function createSession() {
  const id = randomBytes(20).toString('hex'); // 40-char hex, unguessable
  sessions.set(id, {
    queue: [],
    nowPlaying: null,
    paused: false,
    nextId: 1,
    clients: new Set(),
    lastActivity: Date.now(),
  });
  return id;
}

function getSession(id) {
  return sessions.get(id) || null;
}

function touchSession(session) {
  session.lastActivity = Date.now();
}

// Periodic cleanup: remove sessions idle longer than SESSION_TTL_MS with no active connections
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (session.clients.size === 0 && now - session.lastActivity > SESSION_TTL_MS) {
      sessions.delete(id);
    }
  }
}, 30 * 60 * 1000);

app.use(express.static(path.join(__dirname, 'web')));

// ── Helpers ──────────────────────────────────────────────────────────────────

function broadcast(session, data) {
  const msg = JSON.stringify(data);
  for (const client of session.clients) {
    if (client.readyState === 1) client.send(msg);
  }
}

function broadcastState(session) {
  broadcast(session, { type: 'state', queue: session.queue, nowPlaying: session.nowPlaying, paused: session.paused });
}

/** Extract a YouTube video ID from common URL formats. */
function extractVideoId(url) {
  if (typeof url !== 'string') return null;
  const patterns = [
    /[?&]v=([A-Za-z0-9_-]{11})/,
    /youtu\.be\/([A-Za-z0-9_-]{11})/,
    /\/embed\/([A-Za-z0-9_-]{11})/,
    /\/shorts\/([A-Za-z0-9_-]{11})/,
  ];
  for (const re of patterns) {
    const m = url.match(re);
    if (m) return m[1];
  }
  return null;
}

/** Sanitise a display string to a reasonable length. */
function sanitiseTitle(str) {
  if (typeof str !== 'string') return '';
  return str.trim().slice(0, 200);
}

/**
 * Extract "Title - Artist" from messy YouTube titles by splitting on the first
 * common separator and stripping parenthetical/bracket junk from the right side.
 * Returns the original string unchanged when no separator is found.
 */
function cleanTitle(str) {
  const s = sanitiseTitle(str);
  if (!s) return s;
  // Match the first separator that has whitespace on both sides
  const sep = s.match(/\s+(\u2013|\u2014|\||-{1,2}|\/\/)\s+/);
  if (!sep) return s;
  const left  = s.slice(0, sep.index).trim();
  const after = s.slice(sep.index + sep[0].length);
  // From the right portion, stop at the next separator or any opening paren/bracket
  const right = after
    .split(/\s+(?:\u2013|\u2014|\||-{1,2}|\/\/)\s+/)[0]
    .replace(/\s*[\(\[\uff08\u3010].*$/, '')
    .trim();
  if (!left || !right) return s;
  return `${left} ${sep[1]} ${right}`;
}

/** Decode common HTML entities that appear in og:title / page titles. */
function decodeEntities(str) {
  return str
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'");
}

function playNext(session) {
  session.paused = false;
  session.nowPlaying = session.queue.length > 0 ? session.queue.shift() : null;
  broadcastState(session);
}

// ── REST – session ────────────────────────────────────────────────────────────

app.post('/api/session/create', (req, res) => {
  const id = createSession();
  res.json({ sessionId: id });
});

// ── REST – title lookup ───────────────────────────────────────────────────────

app.get('/api/title', async (req, res) => {
  const rawUrl = req.query.url;
  const videoId = extractVideoId(rawUrl);
  if (!videoId) return res.json({ title: null });

  // Try oEmbed first – fast, but returns 401 when embedding is disabled
  try {
    const oembedUrl =
      `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&format=json`;
    const r = await fetch(oembedUrl, { signal: AbortSignal.timeout(5000) });
    if (r.ok) {
      const data = await r.json();
      if (data.title) return res.json({ title: cleanTitle(decodeEntities(data.title)) });
    }
  } catch { /* fall through to page scrape */ }

  // Fallback: scrape og:title from the watch page (works for all videos)
  try {
    const r = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const html = await r.text();

    const ogMatch = html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/);
    if (ogMatch) return res.json({ title: cleanTitle(decodeEntities(ogMatch[1])) });

    const titleMatch = html.match(/<title>([^<]+)<\/title>/);
    if (titleMatch) {
      const t = decodeEntities(titleMatch[1]).replace(/ - YouTube$/, '').trim();
      return res.json({ title: cleanTitle(t) });
    }
  } catch { /* ignore */ }

  res.json({ title: null });
});

// ── REST – YouTube search (embeddable videos only) ────────────────────────────

app.get('/api/search', async (req, res) => {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'YouTube API key not configured — add YOUTUBE_API_KEY to .env' });

  const raw = req.query.q;
  if (!raw || typeof raw !== 'string') return res.json({ results: [] });
  const q = sanitiseTitle(raw).slice(0, 150);
  if (!q) return res.json({ results: [] });

  try {
    // Step 1: search
    const searchUrl = 'https://www.googleapis.com/youtube/v3/search?part=snippet' +
      '&type=video&maxResults=15' +
      '&q=' + encodeURIComponent(q) +
      '&key=' + encodeURIComponent(apiKey);
    const sr = await fetch(searchUrl, { signal: AbortSignal.timeout(8000) });
    if (sr.status === 403) return res.status(429).json({ error: 'YouTube API quota exceeded or key invalid' });
    if (!sr.ok) throw new Error(`Search HTTP ${sr.status}`);
    const sd = await sr.json();

    const items = sd.items || [];
    if (items.length === 0) return res.json({ results: [] });

    // Step 2: filter by embeddable status
    const ids = items.map(i => i.id.videoId).filter(Boolean).join(',');
    const vidUrl = 'https://www.googleapis.com/youtube/v3/videos?part=status' +
      '&id=' + encodeURIComponent(ids) +
      '&key=' + encodeURIComponent(apiKey);
    const vr = await fetch(vidUrl, { signal: AbortSignal.timeout(8000) });
    if (!vr.ok) throw new Error(`Videos HTTP ${vr.status}`);
    const vd = await vr.json();

    const embeddable = new Set(
      (vd.items || []).filter(v => v.status?.embeddable).map(v => v.id)
    );

    const results = items
      .filter(i => embeddable.has(i.id.videoId))
      .map(i => ({
        videoId: i.id.videoId,
        title:   cleanTitle(decodeEntities(i.snippet.title)),
        channel: sanitiseTitle(decodeEntities(i.snippet.channelTitle)),
        thumb:   i.snippet.thumbnails?.medium?.url || i.snippet.thumbnails?.default?.url || '',
        url:     'https://www.youtube.com/watch?v=' + i.id.videoId,
      }));

    res.json({ results });
  } catch (e) {
    console.error('Search error:', e.message);
    res.status(500).json({ error: 'Search failed — check server logs' });
  }
}); 

// ── WebSocket ─────────────────────────────────────────────────────────────────

wss.on('connection', (ws, req) => {
  const wsUrl = new URL(req.url, 'http://localhost');
  const sessionId = wsUrl.searchParams.get('s');
  const session = sessionId ? getSession(sessionId) : null;
  if (!session) {
    ws.close(4004, 'Session not found');
    return;
  }

  touchSession(session);
  session.clients.add(ws);

  // Sync new client immediately
  ws.send(JSON.stringify({ type: 'state', queue: session.queue, nowPlaying: session.nowPlaying, paused: session.paused }));

  ws.on('close', () => {
    session.clients.delete(ws);
  });

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    touchSession(session);

    switch (msg.type) {
      case 'add': {
        const videoId = extractVideoId(msg.url);
        if (!videoId) return;
        const item = {
          id: session.nextId++,
          videoId,
          url: `https://www.youtube.com/watch?v=${videoId}`,
          title: cleanTitle(msg.title) || `Video ${videoId}`,
          singer: sanitiseTitle(msg.singer || ''),
        };
        session.queue.push(item);
        if (!session.nowPlaying) playNext(session);
        else broadcastState(session);
        break;
      }

      case 'play-index': {
        const idx = Number(msg.index);
        if (Number.isInteger(idx) && idx >= 0 && idx < session.queue.length) {
          session.paused = false;
          session.nowPlaying = session.queue.splice(idx, 1)[0];
          broadcastState(session);
        }
        break;
      }

      case 'next':
        playNext(session);
        break;

      case 'remove': {
        const idx = Number(msg.index);
        if (Number.isInteger(idx) && idx >= 0 && idx < session.queue.length) {
          session.queue.splice(idx, 1);
          broadcastState(session);
        }
        break;
      }

      case 'reorder': {
        const from = Number(msg.from);
        const to = Number(msg.to);
        if (
          Number.isInteger(from) && Number.isInteger(to) &&
          from >= 0 && from < session.queue.length &&
          to >= 0 && to < session.queue.length &&
          from !== to
        ) {
          const [item] = session.queue.splice(from, 1);
          session.queue.splice(to, 0, item);
          broadcastState(session);
        }
        break;
      }

      case 'restart':
        if (session.nowPlaying) {
          session.paused = false;
          broadcast(session, { type: 'restart' });
        }
        break;

      case 'video-ended':
        playNext(session);
        break;

      case 'pause':
        if (session.nowPlaying) { session.paused = true; broadcastState(session); }
        break;

      case 'resume':
        if (session.nowPlaying) { session.paused = false; broadcastState(session); }
        break;

      case 'video-error':
        if (session.nowPlaying) { session.nowPlaying.embedFailed = true; broadcastState(session); }
        break;
    }
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3444;
server.listen(PORT, () => {
  console.log(`\nKaraoke Browser running at http://localhost:${PORT}`);
  console.log(`  Create a room at: http://localhost:${PORT}/\n`);
});
