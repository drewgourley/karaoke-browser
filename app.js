'use strict';
require('dotenv').config();

const express = require('express');
const helmet  = require('helmet');
const { WebSocketServer } = require('ws');
const http = require('http');
const path  = require('path');
const fs    = require('fs');
const QRCode = require('qrcode');

// ── Logger ──────────────────────────────────────────────────────────────
// Set LOG_LEVEL in .env to: error | warn | info (default) | debug
const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const LOG_COLORS = { error: '\x1b[31m', warn: '\x1b[33m', info: '\x1b[36m', debug: '\x1b[90m' };
const RESET = '\x1b[0m';
const logLevelNum = LOG_LEVELS[process.env.LOG_LEVEL] ?? LOG_LEVELS.info;
const useTTYColors = process.stdout.isTTY;

function log(level, ...args) {
  if (LOG_LEVELS[level] > logLevelNum) return;
  const ts = new Date().toISOString();
  const c = useTTYColors ? (LOG_COLORS[level] || '') : '';
  const r = useTTYColors ? RESET : '';
  console.log(`${c}[${ts}] ${level.toUpperCase().padEnd(5)}${r}`, ...args);
}

const logger = {
  error: (...a) => log('error', ...a),
  warn:  (...a) => log('warn',  ...a),
  info:  (...a) => log('info',  ...a),
  debug: (...a) => log('debug', ...a),
};

// Short-form session ID for display (first 8 hex chars).
function sid(id) { return id ? id.slice(0, 8) + '\u2026' : '(none)'; }

// ── Rate limiting ─────────────────────────────────────────────────────────────
// Lightweight in-memory rate limiter (single-process). For multi-instance
// deployments, back this with a shared store (e.g. Redis) instead.
function makeRateLimiter({ windowMs, max, message = 'Too many requests — try again later' }) {
  const hits = new Map(); // ip → { count, resetAt }
  setInterval(() => {
    const now = Date.now();
    for (const [ip, e] of hits) if (now >= e.resetAt) hits.delete(ip);
  }, windowMs).unref();
  return function rateLimiter(req, res, next) {
    const ip  = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    let e = hits.get(ip);
    if (!e || now >= e.resetAt) { e = { count: 0, resetAt: now + windowMs }; hits.set(ip, e); }
    if (++e.count > max) {
      logger.warn(`Rate limit  ip=${ip}  path=${req.path}`);
      return res.status(429).json({ error: message });
    }
    next();
  };
}

const MAX_SESSIONS         = Number(process.env.MAX_SESSIONS)         || 500;
const MAX_SESSION_REQUESTS = Number(process.env.MAX_SESSION_REQUESTS) || 100; // max pending requests per session inbox
const WS_REQ_RATE_MAX       = Number(process.env.WS_REQ_RATE_MAX)       || 10;  // max request messages per client per window
const WS_REQ_RATE_WINDOW_MS  = (Number(process.env.WS_REQ_RATE_WINDOW_MIN)  || 1) * 60_000;
const WS_CONN_RATE_MAX       = Number(process.env.WS_CONN_RATE_MAX)       || 60;  // max new WS connections per IP per window
const WS_CONN_RATE_WINDOW_MS = (Number(process.env.WS_CONN_RATE_WINDOW_MIN) || 1) * 60_000;

// Per-route HTTP rate limiters.
const createSessionLimiter = makeRateLimiter({
  windowMs: (Number(process.env.SESSION_RATE_WINDOW_MIN) || 15) * 60_000,
  max:       Number(process.env.SESSION_RATE_MAX)        || 10,
  message: 'Too many sessions created from this IP — try again later',
});
const titleLimiter = makeRateLimiter({
  windowMs: (Number(process.env.TITLE_RATE_WINDOW_MIN) || 1) * 60_000,
  max:       Number(process.env.TITLE_RATE_MAX)        || 30,
});
const qrLimiter = makeRateLimiter({
  windowMs: (Number(process.env.QR_RATE_WINDOW_MIN) || 1) * 60_000,
  max:       Number(process.env.QR_RATE_MAX)        || 20,
});
const searchLimiter = makeRateLimiter({
  windowMs: (Number(process.env.SEARCH_RATE_WINDOW_MIN) || 10) * 60_000,
  max:       Number(process.env.SEARCH_RATE_MAX)        || 20,
});

// ── YouTube API key pool ───────────────────────────────────────────────────────────
// Comma-separated list in YOUTUBE_API_KEYS. Keys are used round-robin and
// retired automatically when the daily quota is hit (403); they revive at
// midnight UTC when Google resets quotas.
const YT_KEYS = (process.env.YOUTUBE_API_KEYS || '')
  .split(',').map(k => k.trim()).filter(Boolean);
if (!YT_KEYS.length) logger.warn('No YOUTUBE_API_KEYS configured — search will be unavailable');

const retiredKeys = new Map(); // key → revive-at timestamp
let keyIndex = 0;

function retireUntilMidnightUTC() {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
}

function getNextKey() {
  const now = Date.now();
  for (const [k, until] of retiredKeys) if (now >= until) retiredKeys.delete(k);
  const n = YT_KEYS.length;
  for (let i = 0; i < n; i++) {
    const key = YT_KEYS[(keyIndex + i) % n];
    if (!retiredKeys.has(key)) {
      keyIndex = (keyIndex + i + 1) % n;
      return key;
    }
  }
  return null; // all retired
}

function retireKey(key) {
  retiredKeys.set(key, retireUntilMidnightUTC());
  const remaining = YT_KEYS.filter(k => !retiredKeys.has(k)).length;
  if (remaining === 0) {
    logger.warn('All YouTube API keys exhausted — search unavailable until midnight UTC');
  } else {
    logger.warn(`YouTube key …${key.slice(-4)} quota exceeded — retired until midnight UTC (${remaining} key(s) remaining)`);
  }
}

// ── Search result cache ───────────────────────────────────────────────────────────
const SEARCH_CACHE_TTL_MS = (Number(process.env.SEARCH_CACHE_TTL_MIN) || 60) * 60_000;
const searchCache = new Map(); // normalised query → { results, ts }
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of searchCache) if (now - v.ts > SEARCH_CACHE_TTL_MS) searchCache.delete(k);
}, 10 * 60_000).unref();

const app = express();
app.set('trust proxy', 1); // trust X-Forwarded-* headers from reverse proxy
const server = http.createServer(app);

// ── WS connection rate limiter ────────────────────────────────────────────────
// Runs before the WebSocket handshake completes so a flood of upgrade requests
// from a single IP is rejected at the TCP level, not after socket creation.
const wsConnHits = new Map(); // ip → { count, resetAt }
setInterval(() => {
  const now = Date.now();
  for (const [ip, e] of wsConnHits) if (now >= e.resetAt) wsConnHits.delete(ip);
}, WS_CONN_RATE_WINDOW_MS).unref();

function checkWsConnLimit(ip) {
  const now = Date.now();
  let e = wsConnHits.get(ip);
  if (!e || now >= e.resetAt) { e = { count: 0, resetAt: now + WS_CONN_RATE_WINDOW_MS }; wsConnHits.set(ip, e); }
  return ++e.count <= WS_CONN_RATE_MAX;
}

const wss = new WebSocketServer({
  server,
  verifyClient: ({ req }, done) => {
    const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
    if (!checkWsConnLimit(ip)) {
      logger.warn(`WS conn rate limit  ip=${ip}`);
      done(false, 429, 'Too Many Requests');
      return;
    }
    done(true);
  },
});

const { randomBytes, createHash } = require('crypto');

const AUTH_TOKEN = process.env.AUTH_TOKEN || null;
// One-way hash of the token — this is what the cookie stores and what the
// client must prove knowledge of. The plaintext token never travels over the wire.
const AUTH_HASH = AUTH_TOKEN ? createHash('sha256').update(AUTH_TOKEN).digest('hex') : null;

// ── Auth (optional) ───────────────────────────────────────────────────────────
// If AUTH_TOKEN is set in .env, HTML entry points are protected by a password.
// The browser hashes the password with SHA-256 and POSTs the hash to /api/login.
// The server sets an HttpOnly cookie containing the hash, which is validated on
// every subsequent HTML request and WebSocket handshake.
// When AUTH_TOKEN is absent, auth is disabled entirely.

function getCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

function authMiddleware(req, res, next) {
  if (!AUTH_HASH) return next();

  const p = req.path;
  const cookieToken = getCookie(req, 'kp_auth');

  // Root index and the audience request page are always accessible.
  if (p === '/' || p === '/index.html') return next();
  if (p === '/request/' || p === '/request/index.html') return next();

  // Only gate HTML entry points; CSS/JS assets load freely.
  if (!p.endsWith('/') && !p.endsWith('.html')) return next();

  if (cookieToken === AUTH_HASH) return next();

  // Kick the user back to the ingress point, preserving where they wanted to go.
  logger.debug(`Auth redirect ${req.path} → / for ${req.ip}`);
  res.redirect(302, '/?redirect=' + encodeURIComponent(req.originalUrl));
}

// ── Sessions ──────────────────────────────────────────────────────────────────
// Map<sessionId, { queue, nowPlaying, paused, nextId, clients: Set<ws>, lastActivity }>

const sessions = new Map();
const SESSION_TTL_MS = (Number(process.env.SESSION_TTL_HOURS) || 4) * 60 * 60 * 1000;

function createSession() {
  if (sessions.size >= MAX_SESSIONS) {
    logger.warn(`Session cap reached (${MAX_SESSIONS}) — rejecting new session`);
    return null;
  }
  const id = randomBytes(20).toString('hex'); // 40-char hex, unguessable
  sessions.set(id, {
    queue: [],
    nowPlaying: null,
    paused: false,
    nextId: 1,
    requests: [],
    nextRequestId: 1,
    clients: new Set(),
    lastActivity: Date.now(),
  });
  logger.info(`Session created: ${sid(id)}`);
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
  let expired = 0;
  for (const [id, session] of sessions) {
    if (session.clients.size === 0 && now - session.lastActivity > SESSION_TTL_MS) {
      sessions.delete(id);
      expired++;
      logger.debug(`Session expired: ${sid(id)}`);
    }
  }
  if (expired > 0 || logLevelNum >= LOG_LEVELS.debug) {
    logger.debug(`Session cleanup: removed ${expired}, active ${sessions.size}`);
  }
}, 30 * 60 * 1000);

app.use(helmet({
  // YouTube iframes don't send CORP headers, so COEP: require-corp would
  // block the player. Disable it; all other helmet defaults remain active.
  crossOriginEmbedderPolicy: false,
  contentSecurityPolicy: {
    directives: {
      defaultSrc:  ["'self'"],
      // player.js injects the YouTube IFrame API script dynamically
      scriptSrc:   ["'self'", 'https://www.youtube.com', 'https://s.ytimg.com'],
      // inline style="" attributes are used throughout the HTML
      styleSrc:    ["'self'", "'unsafe-inline'"],
      // QR codes are data: URIs; thumbnails come from YouTube's CDN
      imgSrc:      ["'self'", 'data:', 'https://img.youtube.com', 'https://i.ytimg.com', 'https://s.ytimg.com'],
      // YouTube player iframe
      frameSrc:    ['https://www.youtube.com'],
      // WebSocket connections back to this server
      connectSrc:  ["'self'", 'ws:', 'wss:'],
      objectSrc:   ["'none'"],
      baseUri:     ["'self'"],
    },
  },
}));
app.use(authMiddleware);
app.use(express.json({ limit: '4kb' }));
app.use(express.static(path.join(__dirname, 'web')));

// ── Helpers ──────────────────────────────────────────────────────────────────

function broadcast(session, data) {
  const msg = JSON.stringify(data);
  for (const client of session.clients) {
    if (client.readyState === 1) client.send(msg);
  }
}

function hasPlayer(session) {
  for (const client of session.clients) {
    if (client.role === 'player' && client.readyState === 1) return true;
  }
  return false;
}

function hasController(session) {
  for (const client of session.clients) {
    if (client.role === 'controller' && client.readyState === 1) return true;
  }
  return false;
}

function broadcastState(session) {
  broadcast(session, {
    type: 'state',
    queue: session.queue,
    nowPlaying: session.nowPlaying,
    paused: session.paused,
    playerConnected: hasPlayer(session),
    controllerConnected: hasController(session),
    requests: session.requests,
  });
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

// ── REST – auth ───────────────────────────────────────────────────────────────

app.get('/api/auth-status', (req, res) => {
  res.json({
    authRequired: !!AUTH_HASH,
    authed: !AUTH_HASH || getCookie(req, 'kp_auth') === AUTH_HASH,
  });
});

app.post('/api/login', (req, res) => {
  if (!AUTH_HASH) return res.json({ ok: true }); // no auth configured
  const { hash } = req.body || {};
  if (typeof hash !== 'string' || hash !== AUTH_HASH) {
    logger.warn(`Login failed from ${req.ip}`);
    return res.status(401).json({ ok: false });
  }
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  const maxAge = 30 * 24 * 60 * 60; // 30 days — survives PWA relaunches
  res.setHeader('Set-Cookie',
    `kp_auth=${AUTH_HASH}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure ? '; Secure' : ''}`);
  logger.info(`Login success from ${req.ip}`);
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'kp_auth=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
  res.json({ ok: true });
});

// ── REST – session ────────────────────────────────────────────────────────────

app.post('/api/session/create', createSessionLimiter, (req, res) => {
  let id;
  if (AUTH_HASH) {
    // Auth mode: one fixed session for the whole server, keyed to the token hash.
    id = AUTH_HASH;
    if (!getSession(id)) {
      if (sessions.size >= MAX_SESSIONS) {
        return res.status(503).json({ error: 'Server is at capacity — try again later' });
      }
      sessions.set(id, {
        queue: [],
        nowPlaying: null,
        paused: false,
        nextId: 1,
        requests: [],
        nextRequestId: 1,
        clients: new Set(),
        lastActivity: Date.now(),
      });
      logger.info(`Session created (auth mode): ${sid(id)}`);
    } else {
      logger.debug(`Session resumed (auth mode): ${sid(id)}`);
    }
  } else {
    id = createSession();
    if (!id) return res.status(503).json({ error: 'Server is at capacity — try again later' });
  }
  res.json({ sessionId: id });
});

// ── REST – title lookup ───────────────────────────────────────────────────────

app.get('/api/title', titleLimiter, async (req, res) => {
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

app.get('/api/search', searchLimiter, async (req, res) => {
  if (!YT_KEYS.length) {
    return res.status(503).json({ error: 'No YouTube API keys configured — add YOUTUBE_API_KEYS to .env' });
  }

  const raw = req.query.q;
  if (!raw || typeof raw !== 'string') return res.json({ results: [] });
  const q = sanitiseTitle(raw).slice(0, 150);
  if (!q) return res.json({ results: [] });

  // Serve from cache when available.
  const cached = searchCache.get(q);
  if (cached && Date.now() - cached.ts <= SEARCH_CACHE_TTL_MS) {
    logger.debug(`Search cache hit  q="${q}"`);
    return res.json({ results: cached.results });
  }

  const apiKey = getNextKey();
  if (!apiKey) {
    return res.status(503).json({ error: 'YouTube API quota exhausted — try again after midnight UTC' });
  }

  logger.debug(`Search q="${q}"  key=…${apiKey.slice(-4)}`);
  try {
    // Step 1: search
    const searchUrl = 'https://www.googleapis.com/youtube/v3/search?part=snippet' +
      '&type=video&maxResults=15' +
      '&q=' + encodeURIComponent(q) +
      '&key=' + encodeURIComponent(apiKey);
    const sr = await fetch(searchUrl, { signal: AbortSignal.timeout(8000) });
    if (sr.status === 403) {
      retireKey(apiKey);
      return res.status(503).json({ error: 'YouTube API quota exceeded — key rotated, try your search again' });
    }
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

    searchCache.set(q, { results, ts: Date.now() });
    logger.debug(`Search complete  q="${q}"  results=${results.length}  cached=true`);

    res.json({ results });
  } catch (e) {
    logger.error('Search error:', e.message);
    res.status(500).json({ error: 'Search failed — check server logs' });
  }
});

// QR code for any URL (used by the index page to generate the request-link QR).
app.get('/api/qr', qrLimiter, async (req, res) => {
  const sessionId = req.query.s;
  if (!sessionId || !getSession(sessionId)) {
    return res.status(403).json({ error: 'Invalid session' });
  }
  const data = req.query.data;
  if (!data || typeof data !== 'string' || data.length > 2048) {
    return res.status(400).json({ error: 'Missing or invalid data param' });
  }
  try {
    const dataUrl = await QRCode.toDataURL(data, {
      width: 256,
      margin: 2,
      color: { dark: '#000000', light: '#ffffff' },
    });
    logger.debug(`QR generated for: ${data.slice(0, 80)}`);
    // Cache for 5 minutes — the URL is stable for the life of a session.
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.json({ dataUrl });
  } catch (e) {
    logger.error('QR generation error:', e.message);
    res.status(500).json({ error: 'QR generation failed' });
  }
}); 

// ── WebSocket ─────────────────────────────────────────────────────────────────

wss.on('connection', (ws, req) => {
  const wsUrl = new URL(req.url, 'http://localhost');
  const role = wsUrl.searchParams.get('role') || 'unknown';
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;

  // Audience request connections are authenticated by the unguessable session ID
  // in ?s= alone — same rationale as exempting /request/ from the HTML auth gate.
  if (AUTH_HASH && role !== 'request' && getCookie(req, 'kp_auth') !== AUTH_HASH) {
    logger.warn(`WS auth failed  role=${role} ip=${ip}`);
    ws.close(4001, 'Unauthorized');
    return;
  }

  const sessionId = wsUrl.searchParams.get('s');
  const session = sessionId ? getSession(sessionId) : null;
  if (!session) {
    logger.warn(`WS unknown session  role=${role} sid=${sid(sessionId)} ip=${ip}`);
    ws.close(4004, 'Session not found');
    return;
  }

  ws.role = role;
  logger.info(`WS connect    role=${role.padEnd(10)} session=${sid(sessionId)} ip=${ip}`);

  touchSession(session);
  session.clients.add(ws);

  // Broadcast to all clients (including the new one) so controllers immediately
  // learn about the updated playerConnected status.
  broadcastState(session);

  ws.on('close', (code) => {
    session.clients.delete(ws);
    logger.info(`WS disconnect role=${role.padEnd(10)} session=${sid(sessionId)} code=${code}`);
    // Let peers know when player or controller presence changes.
    if (ws.role === 'player' || ws.role === 'controller') broadcastState(session);
  });

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    touchSession(session);
    logger.debug(`WS msg        type=${String(msg.type).padEnd(14)} session=${sid(sessionId)}`);

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

      case 'request': {
        // Per-client flood guard: max 10 requests per minute per WebSocket connection.
        const _now = Date.now();
        if (!ws._reqWindowStart || _now - ws._reqWindowStart > WS_REQ_RATE_WINDOW_MS) {
          ws._reqWindowStart = _now;
          ws._reqCount = 0;
        }
        if (++ws._reqCount > WS_REQ_RATE_MAX) {
          logger.warn(`WS request flood  session=${sid(sessionId)}`);
          ws.close(4029, 'Rate limited');
          return;
        }
        // Per-session inbox cap: silently ignore once the inbox is full.
        if (session.requests.length >= MAX_SESSION_REQUESTS) return;
        const title  = sanitiseTitle(msg.title  || '').slice(0, 120);
        if (!title) return;
        const name   = sanitiseTitle(msg.name   || '').slice(0, 120);
        const artist = sanitiseTitle(msg.artist || '').slice(0, 120);
        session.requests.push({ id: session.nextRequestId++, name, artist, title });
        broadcastState(session);
        break;
      }

      case 'dismiss-request': {
        const idx = session.requests.findIndex(r => r.id === msg.id);
        if (idx !== -1) {
          session.requests.splice(idx, 1);
          broadcastState(session);
        }
        break;
      }
    }
  });
});

// ── Session persistence ───────────────────────────────────────────────────────────
// Queue, now-playing, and requests survive a server restart.
// The clients Set (live WebSocket objects) is not serialisable and is omitted.

const SESSION_FILE = path.join(__dirname, 'data', 'sessions.json');

async function saveSessionsToDisk() {
  const payload = [];
  for (const [id, s] of sessions) {
    payload.push({
      id,
      queue:         s.queue,
      nowPlaying:    s.nowPlaying,
      paused:        s.paused,
      nextId:        s.nextId,
      requests:      s.requests,
      nextRequestId: s.nextRequestId,
      lastActivity:  s.lastActivity,
    });
  }
  try {
    await fs.promises.mkdir(path.dirname(SESSION_FILE), { recursive: true });
    const tmp = SESSION_FILE + '.tmp';
    await fs.promises.writeFile(tmp, JSON.stringify(payload));
    await fs.promises.rename(tmp, SESSION_FILE); // atomic on most OSes
    logger.debug(`Sessions saved: ${payload.length}`);
  } catch (e) {
    logger.error('Failed to save sessions:', e.message);
  }
}

async function loadSessionsFromDisk() {
  try {
    const raw  = await fs.promises.readFile(SESSION_FILE, 'utf8');
    const list = JSON.parse(raw);
    const now  = Date.now();
    let loaded = 0;
    for (const s of (Array.isArray(list) ? list : [])) {
      if (!s.id || now - s.lastActivity > SESSION_TTL_MS) continue;
      sessions.set(s.id, {
        queue:         Array.isArray(s.queue)    ? s.queue    : [],
        nowPlaying:    s.nowPlaying              || null,
        paused:        !!s.paused,
        nextId:        s.nextId                  || 1,
        requests:      Array.isArray(s.requests) ? s.requests : [],
        nextRequestId: s.nextRequestId           || 1,
        clients:       new Set(),
        lastActivity:  s.lastActivity,
      });
      loaded++;
    }
    if (loaded > 0) logger.info(`Sessions loaded from disk: ${loaded}`);
  } catch (e) {
    if (e.code !== 'ENOENT') logger.warn('Could not load sessions from disk:', e.message);
    // ENOENT on first run is expected — no sessions to restore.
  }
}

// Auto-save every 60 seconds.
setInterval(saveSessionsToDisk, 60_000).unref();

// Save on graceful shutdown so in-flight sessions aren't lost.
function shutdown(signal) {
  logger.info(`${signal} received — saving sessions and exiting…`);
  saveSessionsToDisk().finally(() => process.exit(0));
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

// ── Start ─────────────────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3444;
loadSessionsFromDisk().then(() => {
  server.listen(PORT, () => {
    logger.info(`Karaoke Browser listening on port ${PORT}`);
    logger.info(`  Open: http://localhost:${PORT}/`);
    logger.info(`  Auth: ${AUTH_HASH ? 'enabled' : 'disabled'}`);
    logger.info(`  Keys: ${YT_KEYS.length} YouTube API key(s) configured`);
    logger.info(`  Log level: ${process.env.LOG_LEVEL || 'info'}`);
  });
});
