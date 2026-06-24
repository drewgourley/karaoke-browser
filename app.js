'use strict';
require('dotenv').config();

const express = require('express');
const helmet  = require('helmet');
const { WebSocketServer } = require('ws');
const http  = require('http');
const path  = require('path');
const Redis = require('ioredis');
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
const buttmLimiter = makeRateLimiter({
  windowMs: 60_000,
  max: 30,
});
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
// Redis-backed so all instances share the same cache. TTL is set per-key;
// no cleanup interval needed.
const SEARCH_CACHE_TTL_SECS = (Number(process.env.SEARCH_CACHE_TTL_MIN) || 60) * 60;

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

// TITLE_BROADCAST: if set, /api/title?s=SESSION&auth=TOKEN returns plain-text
// currently-playing title (falls back to this string when nothing is playing).
const TITLE_BROADCAST = process.env.TITLE_BROADCAST || null;

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
  if (p === '/display/' || p === '/display/index.html') return next();

  // Only gate HTML entry points; CSS/JS assets load freely.
  if (!p.endsWith('/') && !p.endsWith('.html')) return next();

  if (cookieToken === AUTH_HASH) return next();

  // Kick the user back to the ingress point, preserving where they wanted to go.
  logger.debug(`Auth redirect ${req.path} → / for ${req.ip}`);
  res.redirect(302, '/?redirect=' + encodeURIComponent(req.originalUrl));
}

// ── Redis ─────────────────────────────────────────────────────────────────────
// Two clients required: a command client and a dedicated subscriber connection.
// A subscribed ioredis client cannot issue normal commands.
const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const redis     = new Redis(REDIS_URL, { lazyConnect: true });
const subRedis  = new Redis(REDIS_URL, { lazyConnect: true });

redis.on('error',    err => logger.error('Redis error:',     err.message));
subRedis.on('error', err => logger.error('Redis sub error:', err.message));

// ── Redis key schema ──────────────────────────────────────────────────────────
const K = {
  session:        id => `kk:session:${id}`,
  presence:       id => `kk:presence:${id}`,
  sessions:       ()  => 'kk:sessions',
  search:         q   => `kk:search:${q}`,
  playlistSearch: q   => `kk:plsearch:${q}`,
  playlistItems:  id  => `kk:plitems:${id}`,
  channel:        id => `kk:state:${id}`,
};

// ── Sessions ──────────────────────────────────────────────────────────────────
const SESSION_TTL_SECS = (Number(process.env.SESSION_TTL_HOURS) || 4) * 60 * 60;

function newSessionData() {
  return {
    queue:                [],
    nowPlaying:           null,
    paused:               false,
    nextId:               1,
    requests:             [],
    nextRequestId:        1,
    requestMode:          'kiosk',   // 'kiosk' | 'crowd'
    blockedDevices:       [],        // device tokens awaiting processing (crowd mode)
    bannedDevices:        [],        // permanently banned device tokens for this session
    standbyPlaylistId:        null,  // YouTube playlist ID for standby music
    standbyPlaylistTitle:     null,  // display name (set from search)
    standbyPlaylistThumbnail: null,  // thumbnail URL (set from search)
    standbyTrack:             null,  // { videoId, title } — currently playing track
    standbyVolume:            75,    // 0–100: standby target volume
    videoVolume:          100,       // 0–100: karaoke video volume
    fadeDuration:         1500,      // ms: crossfade speed (500–5000)
    micVolume:            80,        // 0–100: microphone gain
    micMuted:             false,     // microphone muted
    standbyPaused:        false,     // standby music paused
    playerMode:           'karaoke',  // 'karaoke' | 'standby'
    standbyTitle:         'Karaoke Browser',
    standbySubtitle:      'Your karaoke night command center',
    standbyColors:        ['#4cc9f0', '#4361ee', '#7c3aed', '#f72585', '#ff6b35', '#ffd166', '#06d6a0', '#3a0ca3'],
    standbyTitleColor:    '#ffffff',
    standbyTitleOutline:  '#000000',
    standbyTitleFont:     '',
    standbyTitleSize:     0,
    standbyTitleOutlineSize: 20,
    standbySubtitleColor: '#ffffff',
    standbySubtitleOutline: '#000000',
    standbySubtitleFont:  '',
    standbySubtitleSize:  0,
    standbySubtitleOutlineSize: 8,
    lastActivity:         Date.now(),
  };
}

async function getSession(id) {
  if (!id) return null;
  const raw = await redis.get(K.session(id));
  return raw ? JSON.parse(raw) : null;
}

async function saveSession(id, session) {
  session.lastActivity = Date.now();
  await redis.pipeline()
    .set(K.session(id), JSON.stringify(session))
    .expire(K.session(id),  SESSION_TTL_SECS)
    .expire(K.presence(id), SESSION_TTL_SECS)
    .exec();
}

async function createSession() {
  const count = await redis.scard(K.sessions());
  if (count >= MAX_SESSIONS) {
    logger.warn(`Session cap reached (${MAX_SESSIONS}) — rejecting new session`);
    return null;
  }
  const id   = randomBytes(20).toString('hex');
  const data = newSessionData();
  await redis.pipeline()
    .set(K.session(id), JSON.stringify(data))
    .sadd(K.sessions(), id)
    .hset(K.presence(id), 'player', 0, 'controller', 0, 'request', 0)
    .expire(K.session(id),  SESSION_TTL_SECS)
    .expire(K.presence(id), SESSION_TTL_SECS)
    .exec();
  logger.info(`Session created: ${sid(id)}`);
  return id;
}

async function touchSession(sessionId) {
  await redis.pipeline()
    .expire(K.session(sessionId),  SESSION_TTL_SECS)
    .expire(K.presence(sessionId), SESSION_TTL_SECS)
    .exec();
}

async function markPresence(sessionId, role, delta) {
  await redis.hincrby(K.presence(sessionId), role, delta);
  await redis.expire(K.presence(sessionId), SESSION_TTL_SECS);
}

// Periodic cleanup: scan the session index and prune entries whose Redis key
// has already expired. Redis TTL handles actual expiry; this keeps the
// kk:sessions Set accurate for the MAX_SESSIONS cap check.
setInterval(async () => {
  try {
    const ids = await redis.smembers(K.sessions());
    if (!ids.length) return;
    const pipeline = redis.pipeline();
    for (const id of ids) pipeline.exists(K.session(id));
    const results = await pipeline.exec();
    const expired = ids.filter((_, i) => results[i][1] === 0);
    if (expired.length) {
      await redis.srem(K.sessions(), ...expired);
      logger.debug(`Session index: pruned ${expired.length} expired entries`);
    }
  } catch (e) {
    logger.error('Session index cleanup error:', e.message);
  }
}, 30 * 60_000).unref();

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
      styleSrc:    ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      // Google Fonts files are served from fonts.gstatic.com
      fontSrc:     ["'self'", 'https://fonts.gstatic.com'],
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

// ── Local client registry + pub/sub dispatch ───────────────────────────────────────
// localClients tracks sockets connected to THIS instance only. The pub/sub
// subscriber (wired in start()) forwards published messages to the relevant
// local sockets, achieving cross-instance broadcast.
const localClients = new Map(); // sessionId → Set<WebSocket>

function addLocalClient(sessionId, ws) {
  if (!localClients.has(sessionId)) localClients.set(sessionId, new Set());
  localClients.get(sessionId).add(ws);
}

function removeLocalClient(sessionId, ws) {
  const set = localClients.get(sessionId);
  if (!set) return false;
  const removed = set.delete(ws);
  if (set.size === 0) localClients.delete(sessionId);
  return removed;
}

// ── Per-session message serialization ────────────────────────────────────────
// The ws message handler is async, so two messages arriving close together
// (e.g. the add + dismiss-request pair the grant flow sends in the same tick)
// would both start before either finishes, causing a last-write-wins race.
// We serialise processing per session by chaining each handler onto the tail
// of the previous one. Map entries are garbage-collected when idle.
const sessionLocks = new Map(); // sessionId → Promise (tail of the chain)

function withSessionLock(sessionId, fn) {
  const previous = sessionLocks.get(sessionId) ?? Promise.resolve();
  const next = previous.then(fn).catch(err =>
    logger.error(`WS handler error session=${sid(sessionId)}:`, err.message)
  );
  // Replace with a tail that cleans itself up so the Map doesn't grow forever.
  sessionLocks.set(sessionId, next.then(() => {
    if (sessionLocks.get(sessionId) === next) sessionLocks.delete(sessionId);
  }));
}

// ── Role slot enforcement (distributed, Redis NX lease) ───────────────────────
// Only one controller and one player may be connected per session at a time,
// across all instances. A SET NX key with a TTL acts as a distributed lease.
// The holder refreshes the TTL on a heartbeat; if an instance crashes the slot
// auto-expires after SLOT_TTL_SECS and the next connection can claim it.
const SLOT_TTL_SECS     = 30;
const SLOT_HEARTBEAT_MS = 15_000;

const slotKey = (sessionId, role) => `kk:slot:${sessionId}:${role}`;

async function claimSlot(sessionId, role, connId) {
  const result = await redis.set(slotKey(sessionId, role), connId, 'NX', 'EX', SLOT_TTL_SECS);
  return result === 'OK';
}

async function releaseSlot(sessionId, role, connId) {
  if (connId) {
    // Only delete if we still own this slot — guards against stomping a
    // replacement connection's freshly-claimed slot (browser refresh race).
    await redis.eval(
      "if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end",
      1, slotKey(sessionId, role), connId
    );
  } else {
    await redis.del(slotKey(sessionId, role));
  }
}

async function refreshSlot(sessionId, role) {
  await redis.expire(slotKey(sessionId, role), SLOT_TTL_SECS);
}

async function publishRaw(sessionId, data) {
  await redis.publish(K.channel(sessionId), JSON.stringify(data));
}

async function broadcastState(sessionId) {
  const [session, presenceArr] = await Promise.all([
    getSession(sessionId),
    redis.hmget(K.presence(sessionId), 'player', 'controller', 'request'),
  ]);
  if (!session) return;

  // Self-heal: if this instance has a live open socket for a role, always count
  // it as connected regardless of Redis presence (guards against counter races
  // where markPresence(-1) fires just before markPresence(+1)).
  const localSet = localClients.get(sessionId);
  const liveLocal = { player: 0, controller: 0, request: 0 };
  if (localSet) {
    for (const c of localSet) {
      if (c.readyState === 1 && c.role in liveLocal) liveLocal[c.role]++;
    }
  }
  const playerCount     = Math.max(Number(presenceArr[0]) || 0, liveLocal.player);
  const controllerCount = Math.max(Number(presenceArr[1]) || 0, liveLocal.controller);
  const requestCount    = Math.max(Number(presenceArr[2]) || 0, liveLocal.request);

  if (controllerCount === 0) {
    logger.warn(`broadcastState controllerConnected=false  redis=${presenceArr[1]}  liveLocal=${liveLocal.controller}  localSetSize=${localSet ? [...localSet].map(c => `${c.role}:${c.readyState}`).join(',') : 'none'}  session=${sid(sessionId)}`);
  }

  await publishRaw(sessionId, {
    type:                 'state',
    queue:                 session.queue,
    nowPlaying:            session.nowPlaying,
    paused:                session.paused,
    playerConnected:       playerCount     > 0,
    controllerConnected:   controllerCount > 0,
    requesterCount:        requestCount,
    // Strip deviceToken from requests — it is stored server-side only.
    requests:              session.requests.map(({ deviceToken: _dt, ...r }) => r),
    requestMode:           session.requestMode,
    blockedCount:          (session.blockedDevices || []).length,
    bannedCount:           (session.bannedDevices  || []).length,
    standbyPlaylistId:     session.standbyPlaylistId    || null,
    standbyPlaylistTitle:     session.standbyPlaylistTitle     || null,
    standbyPlaylistThumbnail: session.standbyPlaylistThumbnail || null,
    standbyTrack:             session.standbyTrack             || null,
    standbyVolume:            session.standbyVolume  ?? 75,
    videoVolume:           session.videoVolume    ?? 100,
    fadeDuration:          session.fadeDuration   ?? 1500,
    micVolume:             session.micVolume      ?? 80,
    micMuted:              !!session.micMuted,
    standbyPaused:         session.standbyPaused  ?? false,
    playerMode:            session.playerMode      || 'karaoke',
    standbyTitle:          session.standbyTitle    ?? 'Karaoke Browser',
    standbySubtitle:       session.standbySubtitle ?? 'Your karaoke night command center',
    standbyColors:         session.standbyColors   || ['#4cc9f0', '#4361ee', '#7c3aed', '#f72585', '#ff6b35', '#ffd166', '#06d6a0', '#3a0ca3'],
    standbyTitleColor:          session.standbyTitleColor         ?? '#ffffff',
    standbyTitleOutline:         session.standbyTitleOutline       ?? '#000000',
    standbyTitleFont:            session.standbyTitleFont          ?? '',
    standbyTitleSize:            session.standbyTitleSize          ?? 0,
    standbyTitleOutlineSize:     session.standbyTitleOutlineSize   ?? 20,
    standbySubtitleColor:        session.standbySubtitleColor      ?? '#ffffff',
    standbySubtitleOutline:      session.standbySubtitleOutline    ?? '#000000',
    standbySubtitleFont:         session.standbySubtitleFont       ?? '',
    standbySubtitleSize:         session.standbySubtitleSize       ?? 0,
    standbySubtitleOutlineSize:  session.standbySubtitleOutlineSize ?? 8,
  });
}

/** Extract a YouTube playlist ID from any YouTube / YouTube Music URL. */
function extractPlaylistId(url) {
  if (typeof url !== 'string') return null;
  const m = url.match(/[?&]list=([A-Za-z0-9_-]+)/);
  if (!m) return null;
  // YouTube Music sometimes prepends 'VL' — strip it.
  const id = m[1].replace(/^VL/, '');
  return id.length >= 2 ? id : null;
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

async function playNext(sessionId, session) {
  session.paused     = false;
  session.nowPlaying = session.queue.length > 0 ? session.queue.shift() : null;
  await saveSession(sessionId, session);
  await broadcastState(sessionId);
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

app.post('/api/session/create', createSessionLimiter, async (req, res) => {
  let id;
  let requestMode = 'kiosk';
  if (AUTH_HASH) {
    // Auth mode: one fixed session for the whole server, keyed to the token hash.
    id = AUTH_HASH;
    const existing = await getSession(id);
    if (!existing) {
      const count = await redis.scard(K.sessions());
      if (count >= MAX_SESSIONS) {
        return res.status(503).json({ error: 'Server is at capacity — try again later' });
      }
      await redis.pipeline()
        .set(K.session(id), JSON.stringify(newSessionData()))
        .sadd(K.sessions(), id)
        .hset(K.presence(id), 'player', 0, 'controller', 0, 'request', 0)
        .expire(K.session(id),  SESSION_TTL_SECS)
        .expire(K.presence(id), SESSION_TTL_SECS)
        .exec();
      logger.info(`Session created (auth mode): ${sid(id)}`);
    } else {
      requestMode = existing.requestMode || 'kiosk';
      logger.debug(`Session resumed (auth mode): ${sid(id)}`);
    }
  } else {
    id = await createSession();
    if (!id) return res.status(503).json({ error: 'Server is at capacity — try again later' });
  }
  res.json({ sessionId: id, requestMode });
});

// Check whether a session still exists (used by the ingress page to restore state after refresh).
app.get('/api/session', async (req, res) => {
  const { s } = req.query;
  if (!s || typeof s !== 'string' || s.length > 128) {
    return res.status(400).json({ error: 'Invalid session id' });
  }
  const session = await getSession(s);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json({ sessionId: s, requestMode: session.requestMode || 'kiosk' });
});

// Update request mode for a session (called from the ingress page).
app.post('/api/session/mode', async (req, res) => {
  if (AUTH_HASH && getCookie(req, 'kp_auth') !== AUTH_HASH) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const { sessionId, mode } = req.body || {};
  if (mode !== 'kiosk' && mode !== 'crowd') {
    return res.status(400).json({ error: 'Invalid mode' });
  }
  const session = await getSession(sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (session.requestMode !== mode) {
    session.requestMode = mode;
    await saveSession(sessionId, session);
    await broadcastState(sessionId);
  }
  res.json({ ok: true });
});

// Reset a session back to a clean state (clear queue, now playing, requests, etc.).
app.post('/api/session/reset', async (req, res) => {
  if (AUTH_HASH && getCookie(req, 'kp_auth') !== AUTH_HASH) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const { sessionId } = req.body || {};
  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({ error: 'Missing sessionId' });
  }
  const existing = await getSession(sessionId);
  if (!existing) return res.status(404).json({ error: 'Session not found' });
  // Preserve request mode — carry it over to the fresh state.
  const fresh = newSessionData();
  fresh.requestMode = existing.requestMode || 'kiosk';
  await saveSession(sessionId, fresh);
  await broadcastState(sessionId);
  logger.info(`Session reset  session=${sid(sessionId)}`);
  res.json({ ok: true });
});

// ── REST – currently-playing title broadcast (hidden feature; requires TITLE_BROADCAST env var) ──────────
if (TITLE_BROADCAST) {
  app.get('/api/buttm', buttmLimiter, async (req, res) => {
    if (AUTH_TOKEN && req.query.auth !== AUTH_TOKEN) {
      return res.status(403).type('text/plain').send('Forbidden');
    }
    const session = await getSession(req.query.s);
    if (session) {
      const title = (session.nowPlaying?.title && !session.paused ? session.nowPlaying.title : null)
        || (session.standbyTrack?.title ? cleanTitle(session.standbyTrack.title) : null)
        || null;
      return res.type('text/plain').send(title || TITLE_BROADCAST);
    }
    return res.type('text/plain').send(TITLE_BROADCAST);
  });
}

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
  const cachedRaw = await redis.get(K.search(q));
  if (cachedRaw) {
    logger.debug(`Search cache hit  q="${q}"`);
    return res.json({ results: JSON.parse(cachedRaw) });
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

    await redis.set(K.search(q), JSON.stringify(results), 'EX', SEARCH_CACHE_TTL_SECS);
    logger.debug(`Search complete  q="${q}"  results=${results.length}  cached=true`);

    res.json({ results });
  } catch (e) {
    logger.error('Search error:', e.message);
    res.status(500).json({ error: 'Search failed — check server logs' });
  }
});
// ── REST – Mixer playlist search ──────────────────────────────────────────────

app.get('/api/mixer/search', searchLimiter, async (req, res) => {
  if (!YT_KEYS.length) {
    return res.status(503).json({ error: 'not_configured' });
  }
  const raw = req.query.q;
  if (!raw || typeof raw !== 'string') return res.json({ items: [] });
  const q = sanitiseTitle(raw).slice(0, 150);
  if (!q) return res.json({ items: [] });

  const cacheKey = K.playlistSearch(q);
  const cached = await redis.get(cacheKey);
  if (cached) {
    logger.debug(`Playlist search cache hit  q="${q}"`);
    return res.json({ items: JSON.parse(cached) });
  }

  const apiKey = getNextKey();
  if (!apiKey) {
    return res.status(503).json({ error: 'quota_exhausted' });
  }

  try {
    const searchUrl = 'https://www.googleapis.com/youtube/v3/search?part=snippet' +
      '&type=playlist&maxResults=12' +
      '&q=' + encodeURIComponent(q) +
      '&key=' + encodeURIComponent(apiKey);
    const sr = await fetch(searchUrl, { signal: AbortSignal.timeout(8000) });
    if (sr.status === 403) {
      retireKey(apiKey);
      return res.status(503).json({ error: 'quota_exhausted' });
    }
    if (!sr.ok) throw new Error(`HTTP ${sr.status}`);
    const sd = await sr.json();
    const items = (sd.items || []).map(i => ({
      playlistId:   i.id.playlistId,
      title:        sanitiseTitle(decodeEntities(i.snippet.title)).slice(0, 120),
      channelTitle: sanitiseTitle(decodeEntities(i.snippet.channelTitle)).slice(0, 80),
      thumbnail:    i.snippet.thumbnails?.medium?.url || i.snippet.thumbnails?.default?.url || '',
    })).filter(i => i.playlistId);
    await redis.set(cacheKey, JSON.stringify(items), 'EX', SEARCH_CACHE_TTL_SECS);
    logger.debug(`Playlist search complete  q="${q}"  results=${items.length}`);
    res.json({ items });
  } catch (e) {
    logger.error('Playlist search error:', e.message);
    res.status(500).json({ error: 'search_failed' });
  }
});

app.get('/api/mixer/playlist-items', searchLimiter, async (req, res) => {
  if (!YT_KEYS.length) return res.status(503).json({ error: 'not_configured' });
  const sessionId = req.query.s;
  if (!sessionId || !(await getSession(sessionId))) {
    return res.status(403).json({ error: 'Invalid session' });
  }
  const playlistId = req.query.id;
  if (!playlistId || typeof playlistId !== 'string' || !/^[A-Za-z0-9_-]{10,60}$/.test(playlistId)) {
    return res.status(400).json({ error: 'invalid_id' });
  }

  const cacheKey = K.playlistItems(playlistId);
  const cached = await redis.get(cacheKey);
  if (cached) return res.json({ items: JSON.parse(cached) });

  const apiKey = getNextKey();
  if (!apiKey) return res.status(503).json({ error: 'quota_exhausted' });

  try {
    const url = 'https://www.googleapis.com/youtube/v3/playlistItems' +
      '?part=snippet&maxResults=50' +
      '&playlistId=' + encodeURIComponent(playlistId) +
      '&key=' + encodeURIComponent(apiKey);
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (r.status === 403) { retireKey(apiKey); return res.status(503).json({ error: 'quota_exhausted' }); }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    const items = (data.items || [])
      .filter(i => i.snippet?.resourceId?.kind === 'youtube#video')
      .map(i => ({
        videoId:   i.snippet.resourceId.videoId,
        title:     sanitiseTitle(decodeEntities(i.snippet.title)).slice(0, 120),
        thumbnail: i.snippet.thumbnails?.medium?.url || i.snippet.thumbnails?.default?.url || '',
      }));
    await redis.set(cacheKey, JSON.stringify(items), 'EX', SEARCH_CACHE_TTL_SECS);
    res.json({ items });
  } catch (e) {
    logger.error('Playlist items error:', e.message);
    res.status(500).json({ error: 'fetch_failed' });
  }
});

app.get('/api/qr', qrLimiter, async (req, res) => {
  const sessionId = req.query.s;
  if (!sessionId || !(await getSession(sessionId))) {
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

// Return only the standby display-theme fields for a session (used by the display page).
app.get('/api/standby-theme', async (req, res) => {
  const { s } = req.query;
  if (!s || typeof s !== 'string' || s.length > 128) {
    return res.status(400).json({ error: 'Invalid session id' });
  }
  const session = await getSession(s);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  const defs = ['#4cc9f0', '#4361ee', '#7c3aed', '#f72585', '#ff6b35', '#ffd166', '#06d6a0', '#3a0ca3'];
  res.json({
    standbyColors:              session.standbyColors              || defs,
    standbyTitleColor:          session.standbyTitleColor          || '#ffffff',
    standbyTitleOutline:        session.standbyTitleOutline        || '#000000',
    standbyTitleOutlineSize:    session.standbyTitleOutlineSize    ?? 20,
    standbySubtitleColor:       session.standbySubtitleColor       || '#ffffff',
    standbySubtitleOutline:     session.standbySubtitleOutline     || '#000000',
    standbySubtitleOutlineSize: session.standbySubtitleOutlineSize ?? 8,
  });
});

// ── WebSocket ─────────────────────────────────────────────────────────────────

wss.on('connection', async (ws, req) => {
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
  const initSession = sessionId ? await getSession(sessionId) : null;
  if (!initSession) {
    logger.warn(`WS unknown session  role=${role} sid=${sid(sessionId)} ip=${ip}`);
    ws.close(4004, 'Session not found');
    return;
  }

  ws.role = role;

  // Enforce single controller / single player per session across all instances.
  // In kiosk mode, also enforce a single request page.
  let slotHeartbeat = null;
  ws._hasRequestSlot = false;
  if (role === 'controller' || role === 'player') {
    const connId  = randomBytes(8).toString('hex');
    let claimed = await claimSlot(sessionId, role, connId);
    if (!claimed) {
      // Slot exists in Redis — check if a live local WS actually holds it.
      const localSet = localClients.get(sessionId);
      const liveLocal = localSet && [...localSet].find(c => c.role === role && c.readyState === 1);
      if (!liveLocal) {
        // No live local holder — stale slot from a server restart before TTL expired.
        await redis.set(slotKey(sessionId, role), connId, 'EX', SLOT_TTL_SECS);
        claimed = true;
        logger.info(`WS stale slot evicted  role=${role} session=${sid(sessionId)} ip=${ip}`);
      } else {
        // Live WS exists for this role — likely a browser refresh where the new
        // connection races the close of the old one.  Force-close the old socket
        // and steal the slot; its close handler will no-op the release because
        // the slot value will no longer match its connId.
        liveLocal.close(4410, 'Replaced by new connection');
        await redis.set(slotKey(sessionId, role), connId, 'EX', SLOT_TTL_SECS);
        claimed = true;
        logger.info(`WS slot takeover  role=${role} session=${sid(sessionId)} ip=${ip}`);
      }
    }
    ws._slotConnId = connId;
    if (!claimed) {
      logger.warn(`WS slot occupied  role=${role} session=${sid(sessionId)} ip=${ip}`);
      ws.close(4409, 'Role already connected');
      return;
    }
    slotHeartbeat = setInterval(
      () => refreshSlot(sessionId, role).catch(() => {}),
      SLOT_HEARTBEAT_MS
    );
  } else if (role === 'request' && initSession.requestMode === 'kiosk') {
    const connId  = randomBytes(8).toString('hex');
    const claimed = await claimSlot(sessionId, 'request', connId);
    if (!claimed) {
      logger.warn(`WS kiosk slot occupied  session=${sid(sessionId)} ip=${ip}`);
      ws.close(4409, 'Kiosk already connected');
      return;
    }
    ws._hasRequestSlot = true;
    slotHeartbeat = setInterval(
      () => refreshSlot(sessionId, 'request').catch(() => {}),
      SLOT_HEARTBEAT_MS
    );
  }

  logger.info(`WS connect    role=${role.padEnd(10)} session=${sid(sessionId)} ip=${ip}`);

  addLocalClient(sessionId, ws);
  await touchSession(sessionId);
  await markPresence(sessionId, role, 1);
  // Broadcast full state to all clients (including the new one) so controllers
  // immediately learn about updated playerConnected / controllerConnected status.
  await broadcastState(sessionId);

  ws.on('close', async (code) => {
    if (slotHeartbeat) clearInterval(slotHeartbeat);
    if (role === 'controller' || role === 'player') await releaseSlot(sessionId, role, ws._slotConnId);
    if (ws._hasRequestSlot) await releaseSlot(sessionId, 'request');
    const wasLocal = removeLocalClient(sessionId, ws);
    if (wasLocal) await markPresence(sessionId, role, -1);
    logger.info(`WS disconnect role=${role.padEnd(10)} session=${sid(sessionId)} code=${code} wasLocal=${wasLocal}`);
    if (wasLocal && (role === 'player' || role === 'controller' || role === 'request')) await broadcastState(sessionId);
  });

  ws.on('message', (raw) => {
    withSessionLock(sessionId, async () => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      logger.debug(`WS msg        type=${String(msg.type).padEnd(14)} session=${sid(sessionId)}`);

      // Re-read session fresh from Redis on every message so this instance sees
      // changes made by other instances.
      const session = await getSession(sessionId);
      if (!session) return; // session expired while client was connected

    switch (msg.type) {
      case 'hello': {
        // Sent by request pages on connect. Responds with the device's current
        // blocked status so the page can show the right UI immediately.
        if (role !== 'request') break;
        const hToken = typeof msg.deviceToken === 'string' ? msg.deviceToken.slice(0, 80) : null;
        if (!hToken) break;
        const isBanned  = (session.bannedDevices  || []).includes(hToken);
        const isBlocked = !isBanned && session.requestMode === 'crowd' &&
          (session.blockedDevices || []).includes(hToken);
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({
            type:    'device-status',
            mode:    session.requestMode,
            blocked: isBlocked,
            banned:  isBanned,
          }));
        }
        break;
      }

      case 'clear-blocked-devices': {
        // Controller only. Unblocks every device waiting in crowd mode at once.
        if (role !== 'controller') break;
        const cleared = session.blockedDevices || [];
        if (!cleared.length) break;
        session.blockedDevices = [];
        await saveSession(sessionId, session);
        await broadcastState(sessionId);
        for (const token of cleared) {
          await publishRaw(sessionId, { type: 'device-cleared', token });
        }
        logger.info(`Blocked devices cleared: ${cleared.length}  session=${sid(sessionId)}`);
        break;
      }

      case 'reset-requester-presence': {
        // Controller only. Recalculates the requester presence counter from
        // actually-connected local WS sockets. Fixes stale counts after ungraceful disconnects.
        if (role !== 'controller') break;
        const localSet = localClients.get(sessionId);
        const actual = localSet
          ? [...localSet].filter(c => c.role === 'request' && c.readyState === 1).length
          : 0;
        await redis.hset(K.presence(sessionId), 'request', actual);
        await broadcastState(sessionId);
        logger.info(`Requester presence reset to ${actual}  session=${sid(sessionId)}`);
        break;
      }

      case 'unban-all-devices': {
        // Controller only. Clears the banned-device list for this session.
        if (role !== 'controller') break;
        if (!(session.bannedDevices || []).length) break;
        session.bannedDevices = [];
        await saveSession(sessionId, session);
        await broadcastState(sessionId);
        logger.info(`All devices unbanned  session=${sid(sessionId)}`);
        break;
      }

      case 'set-request-mode': {
        // Controller only. Switches the session between kiosk and crowd mode.
        if (role !== 'controller') break;
        const newMode = msg.mode === 'crowd' ? 'crowd' : 'kiosk';
        if (session.requestMode === newMode) break;
        session.requestMode = newMode;
        // Clear all blocks when returning to kiosk so devices aren't stuck.
        if (newMode === 'kiosk') session.blockedDevices = [];
        await saveSession(sessionId, session);
        await broadcastState(sessionId);
        break;
      }

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
        if (!session.nowPlaying) {
          await playNext(sessionId, session);
        } else {
          await saveSession(sessionId, session);
          await broadcastState(sessionId);
        }
        break;
      }

      case 'play-index': {
        const idx = Number(msg.index);
        if (Number.isInteger(idx) && idx >= 0 && idx < session.queue.length) {
          session.paused = false;
          session.nowPlaying = session.queue.splice(idx, 1)[0];
          await saveSession(sessionId, session);
          await broadcastState(sessionId);
        }
        break;
      }

      case 'next':
        await playNext(sessionId, session);
        break;

      case 'requeue': {
        // Controller only. Moves nowPlaying back to position 0 of the queue
        // and advances to the next queued track, so the current song comes
        // back around immediately after rather than being discarded.
        if (!session.nowPlaying || !session.queue.length) break;
        const requeued = session.nowPlaying;
        session.paused     = false;
        session.nowPlaying = session.queue.shift();
        session.queue.unshift(requeued);
        await saveSession(sessionId, session);
        await broadcastState(sessionId);
        break;
      }

      case 'remove': {
        const idx = Number(msg.index);
        if (Number.isInteger(idx) && idx >= 0 && idx < session.queue.length) {
          session.queue.splice(idx, 1);
          await saveSession(sessionId, session);
          await broadcastState(sessionId);
        }
        break;
      }

      case 'reorder': {
        const from = Number(msg.from);
        const to   = Number(msg.to);
        if (
          Number.isInteger(from) && Number.isInteger(to) &&
          from >= 0 && from < session.queue.length &&
          to   >= 0 && to   < session.queue.length &&
          from !== to
        ) {
          const [item] = session.queue.splice(from, 1);
          session.queue.splice(to, 0, item);
          await saveSession(sessionId, session);
          await broadcastState(sessionId);
        }
        break;
      }

      case 'restart':
        if (session.nowPlaying) {
          session.paused = false;
          await saveSession(sessionId, session);
          // restart is a transient command — publish directly rather than a full state.
          await publishRaw(sessionId, { type: 'restart' });
        }
        break;

      case 'video-ended':
        await playNext(sessionId, session);
        break;

      case 'pause':
        if (session.nowPlaying) {
          session.paused = true;
          await saveSession(sessionId, session);
          await broadcastState(sessionId);
        }
        break;

      case 'resume':
        if (session.nowPlaying) {
          session.paused = false;
          await saveSession(sessionId, session);
          await broadcastState(sessionId);
        }
        break;

      case 'video-error':
        if (session.nowPlaying) {
          session.nowPlaying.embedFailed = true;
          await saveSession(sessionId, session);
          await broadcastState(sessionId);
        }
        break;

      case 'request': {
        // Per-client flood guard.
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
        if (session.requests.length >= MAX_SESSION_REQUESTS) return;
        const title  = sanitiseTitle(msg.title  || '').slice(0, 120);
        if (!title) return;
        const name   = sanitiseTitle(msg.name   || '').slice(0, 120);
        const artist = sanitiseTitle(msg.artist || '').slice(0, 120);

        // Gate: banned devices cannot submit in any mode.
        const dToken = typeof msg.deviceToken === 'string' ? msg.deviceToken.slice(0, 80) : null;
        if (dToken && (session.bannedDevices || []).includes(dToken)) {
          if (ws.readyState === 1)
            ws.send(JSON.stringify({ type: 'device-banned', token: dToken }));
          return;
        }

        if (session.requestMode === 'crowd') {
          // Crowd mode: one pending request per device token.
          if (!dToken) return; // crowd mode requires a device token
          if ((session.blockedDevices || []).includes(dToken)) {
            // Re-assert blocked state in case client lost track.
            if (ws.readyState === 1) {
              ws.send(JSON.stringify({ type: 'device-status', mode: 'crowd', blocked: true }));
            }
            return;
          }
          session.requests.push({ id: session.nextRequestId++, name, artist, title, deviceToken: dToken });
          if (!session.blockedDevices) session.blockedDevices = [];
          session.blockedDevices.push(dToken);
        } else {
          // Kiosk mode: no per-device tracking.
          session.requests.push({ id: session.nextRequestId++, name, artist, title });
        }
        await saveSession(sessionId, session);
        await broadcastState(sessionId);
        break;
      }

      case 'dismiss-request': {
        const idx = session.requests.findIndex(r => r.id === msg.id);
        if (idx !== -1) {
          const [dismissed] = session.requests.splice(idx, 1);
          // Auto-unblock the device that submitted this request (crowd mode).
          if (dismissed.deviceToken) {
            if (!session.blockedDevices) session.blockedDevices = [];
            const di = session.blockedDevices.indexOf(dismissed.deviceToken);
            if (di !== -1) session.blockedDevices.splice(di, 1);
          }
          await saveSession(sessionId, session);
          await broadcastState(sessionId);
          // Tell the device's request page it can submit again.
          if (dismissed.deviceToken) {
            await publishRaw(sessionId, { type: 'device-cleared', token: dismissed.deviceToken });
          }
        }
        break;
      }

      case 'set-standby-playlist': {
        if (role !== 'controller' && role !== 'mixer') break;
        const playlistId = extractPlaylistId(msg.url || '');
        if (!playlistId) break;
        session.standbyPlaylistId        = playlistId;
        session.standbyPlaylistTitle     = typeof msg.title     === 'string' ? msg.title.slice(0, 120)     : null;
        session.standbyPlaylistThumbnail = typeof msg.thumbnail === 'string' ? msg.thumbnail.slice(0, 500) : null;
        session.standbyTrack             = null; // clear stale track from previous playlist
        await saveSession(sessionId, session);
        await broadcastState(sessionId);
        logger.info(`Standby playlist set  session=${sid(sessionId)}  id=${playlistId}`);
        break;
      }

      case 'clear-standby': {
        if (role !== 'controller' && role !== 'mixer') break;
        session.standbyPlaylistId        = null;
        session.standbyPlaylistTitle     = null;
        session.standbyPlaylistThumbnail = null;
        session.standbyTrack             = null;
        await saveSession(sessionId, session);
        await broadcastState(sessionId);
        break;
      }

      case 'set-mic-volume': {
        if (role !== 'controller' && role !== 'mixer') break;
        const mv = Number(msg.volume);
        if (!Number.isFinite(mv)) break;
        session.micVolume = Math.round(Math.max(0, Math.min(100, mv)));
        await saveSession(sessionId, session);
        await broadcastState(sessionId);
        break;
      }

      case 'mic-mute': {
        if (role !== 'controller' && role !== 'mixer') break;
        session.micMuted = !!msg.muted;
        await saveSession(sessionId, session);
        await broadcastState(sessionId);
        break;
      }

      case 'standby-skip': {
        if (role !== 'controller' && role !== 'mixer') break;
        if (!session.standbyPlaylistId) break;
        await publishRaw(sessionId, { type: 'standby-skip' });
        break;
      }

      case 'standby-pause': {
        if (role !== 'controller' && role !== 'mixer') break;
        if (!session.standbyPlaylistId) break;
        session.standbyPaused = true;
        await saveSession(sessionId, session);
        await publishRaw(sessionId, { type: 'standby-pause' });
        await broadcastState(sessionId);
        break;
      }

      case 'standby-resume': {
        if (role !== 'controller' && role !== 'mixer') break;
        if (!session.standbyPlaylistId) break;
        session.standbyPaused = false;
        await saveSession(sessionId, session);
        await publishRaw(sessionId, { type: 'standby-resume' });
        await broadcastState(sessionId);
        break;
      }

      case 'standby-track': {
        if (role !== 'player') break;
        const trackVideoId = typeof msg.videoId === 'string'
          ? msg.videoId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 20)
          : null;
        if (!trackVideoId || !session.standbyPlaylistId) break;
        const trackTitle = typeof msg.title === 'string' ? msg.title.slice(0, 200) : null;
        session.standbyTrack  = { videoId: trackVideoId, title: trackTitle };
        session.standbyPaused = false; // player is reporting playback — ensure paused flag is in sync
        await saveSession(sessionId, session);
        await broadcastState(sessionId);
        break;
      }

      case 'set-standby-volume': {
        if (role !== 'controller' && role !== 'mixer') break;
        const sv = Number(msg.volume);
        if (!Number.isFinite(sv)) break;
        session.standbyVolume = Math.round(Math.max(0, Math.min(100, sv)));
        await saveSession(sessionId, session);
        await broadcastState(sessionId);
        break;
      }

      case 'set-video-volume': {
        if (role !== 'controller' && role !== 'mixer') break;
        const vv = Number(msg.volume);
        if (!Number.isFinite(vv)) break;
        session.videoVolume = Math.round(Math.max(0, Math.min(100, vv)));
        await saveSession(sessionId, session);
        await broadcastState(sessionId);
        break;
      }

      case 'toggle-pause': {
        if (!session.nowPlaying) break;
        session.paused = !session.paused;
        await saveSession(sessionId, session);
        await broadcastState(sessionId);
        break;
      }

      case 'standby-toggle-pause': {
        if (role !== 'controller' && role !== 'mixer') break;
        if (!session.standbyPlaylistId) break;
        session.standbyPaused = !session.standbyPaused;
        await saveSession(sessionId, session);
        await publishRaw(sessionId, { type: session.standbyPaused ? 'standby-pause' : 'standby-resume' });
        await broadcastState(sessionId);
        break;
      }

      case 'player-mode': {
        if (role !== 'controller' && role !== 'mixer') break;
        const newMode = msg.mode === 'standby' ? 'standby' : 'karaoke';
        session.playerMode = newMode;
        await saveSession(sessionId, session);
        await broadcastState(sessionId);
        break;
      }

      case 'toggle-player-mode': {
        if (role !== 'controller' && role !== 'mixer') break;
        session.playerMode = (session.playerMode === 'standby') ? 'karaoke' : 'standby';
        await saveSession(sessionId, session);
        await broadcastState(sessionId);
        break;
      }

      case 'ban-device': {
        // Controller only. Ban a device by its request ID — removes the request
        // and permanently blocks the device token for this session.
        if (role !== 'controller') break;
        const bidx = session.requests.findIndex(r => r.id === msg.id);
        if (bidx === -1) break;
        const [banned] = session.requests.splice(bidx, 1);
        if (banned.deviceToken) {
          if (!session.bannedDevices) session.bannedDevices = [];
          if (!session.bannedDevices.includes(banned.deviceToken))
            session.bannedDevices.push(banned.deviceToken);
          // Also remove from crowd blocked list.
          if (session.blockedDevices) {
            const bi = session.blockedDevices.indexOf(banned.deviceToken);
            if (bi !== -1) session.blockedDevices.splice(bi, 1);
          }
        }
        await saveSession(sessionId, session);
        await broadcastState(sessionId);
        if (banned.deviceToken) {
          await publishRaw(sessionId, { type: 'device-banned', token: banned.deviceToken });
        }
        logger.info(`Device banned: session=${sid(sessionId)}`);
        break;
      }

      case 'set-player-mode': {
        // Controller only. Switches the player between karaoke and standby mode.
        if (role !== 'controller') break;
        const newMode = msg.mode === 'standby' ? 'standby' : 'karaoke';
        if (session.playerMode === newMode) break;
        session.playerMode = newMode;
        await saveSession(sessionId, session);
        await broadcastState(sessionId);
        break;
      }

      case 'set-standby-settings': {
        // Controller only. Updates standby screen title, subtitle, gradient colors, text colors, fonts, and sizes.
        if (role !== 'controller') break;
        const hexRe = /^#[0-9a-fA-F]{6}$/;
        if (typeof msg.title    === 'string') session.standbyTitle    = msg.title.slice(0, 80);
        if (typeof msg.subtitle === 'string') session.standbySubtitle = msg.subtitle.slice(0, 120);
        if (Array.isArray(msg.colors)) {
          const defs = ['#4cc9f0', '#4361ee', '#7c3aed', '#f72585', '#ff6b35', '#ffd166', '#06d6a0', '#3a0ca3'];
          session.standbyColors = [0, 1, 2, 3, 4, 5, 6, 7].map(i => {
            const c = msg.colors[i];
            return (typeof c === 'string' && hexRe.test(c)) ? c : defs[i];
          });
        }
        if (typeof msg.titleColor      === 'string' && hexRe.test(msg.titleColor))      session.standbyTitleColor      = msg.titleColor;
        if (typeof msg.titleOutline    === 'string' && hexRe.test(msg.titleOutline))    session.standbyTitleOutline    = msg.titleOutline;
        if (typeof msg.subtitleColor   === 'string' && hexRe.test(msg.subtitleColor))   session.standbySubtitleColor   = msg.subtitleColor;
        if (typeof msg.subtitleOutline === 'string' && hexRe.test(msg.subtitleOutline)) session.standbySubtitleOutline = msg.subtitleOutline;
        if (typeof msg.titleFont    === 'string') session.standbyTitleFont    = msg.titleFont.replace(/[^a-zA-Z0-9 ,'\-_|]/g, '').slice(0, 200);
        if (Number.isFinite(msg.titleSize))       session.standbyTitleSize    = Math.max(0, Math.min(500, Math.round(msg.titleSize)));
        if (Number.isFinite(msg.titleOutlineSize)) session.standbyTitleOutlineSize = Math.max(0, Math.min(30, Math.round(msg.titleOutlineSize)));
        if (typeof msg.subtitleFont    === 'string') session.standbySubtitleFont    = msg.subtitleFont.replace(/[^a-zA-Z0-9 ,'\-_|]/g, '').slice(0, 200);
        if (Number.isFinite(msg.subtitleSize))       session.standbySubtitleSize    = Math.max(0, Math.min(500, Math.round(msg.subtitleSize)));
        if (Number.isFinite(msg.subtitleOutlineSize)) session.standbySubtitleOutlineSize = Math.max(0, Math.min(30, Math.round(msg.subtitleOutlineSize)));
        await saveSession(sessionId, session);
        await broadcastState(sessionId);
        break;
      }
    }
    }); // end withSessionLock
  });
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────

function shutdown(signal) {
  logger.info(`${signal} received — shutting down…`);
  server.close(() => {
    redis.disconnect();
    subRedis.disconnect();
    process.exit(0);
  });
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

// ── Start ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3444;

async function start() {
  await redis.connect();
  await subRedis.connect();

  // On startup, reset all presence counters. If this process was killed before
  // close-handlers ran, the hincrby decrements never fired and counters are
  // stale. Since we haven't started accepting connections yet, every count
  // must be 0.
  try {
    const sessionIds = await redis.smembers(K.sessions());
    if (sessionIds.length) {
      const pipeline = redis.pipeline();
      for (const id of sessionIds) {
        pipeline.hset(K.presence(id), 'player', 0, 'controller', 0, 'request', 0);
      }
      await pipeline.exec();
      logger.info(`Startup: reset presence for ${sessionIds.length} session(s)`);
    }
  } catch (e) {
    logger.warn('Startup presence reset failed:', e.message);
  }

  // Pattern-subscribe to all session state channels.
  // Any message published by any instance is forwarded to locally-connected
  // sockets for that session — this is the cross-instance broadcast mechanism.
  await subRedis.psubscribe('kk:state:*');
  subRedis.on('pmessage', (_pattern, channel, message) => {
    const sessionId = channel.slice('kk:state:'.length);
    const localSet  = localClients.get(sessionId);
    if (!localSet) return;
    for (const ws of localSet) {
      if (ws.readyState === 1) ws.send(message);
    }
  });

  server.listen(PORT, () => {
    logger.info(`Karaoke Browser listening on port ${PORT}`);
    logger.info(`  Open:  http://localhost:${PORT}/`);
    logger.info(`  Auth:  ${AUTH_HASH ? 'enabled' : 'disabled'}`);
    logger.info(`  Keys:  ${YT_KEYS.length} YouTube API key(s) configured`);
    logger.info(`  Redis: ${REDIS_URL}`);
    logger.info(`  Log level: ${process.env.LOG_LEVEL || 'info'}`);
  });
}

start().catch(err => {
  logger.error('Startup failed:', err.message);
  process.exit(1);
});
