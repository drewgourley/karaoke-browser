import 'dotenv/config';

import express, { type Request, type Response, type NextFunction } from 'express';
import helmet from 'helmet';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import http from 'http';
import path from 'path';
import Redis from 'ioredis';
import QRCode from 'qrcode';
import { randomBytes, createHash } from 'crypto';
import type { IncomingMessage } from 'http';

import type { SessionState, ClientMessage, ServerMessage } from '@karaoke-browser/shared';

// ── Extended WebSocket type ───────────────────────────────────────────────────
interface KaraokeWs extends WebSocket {
  role: string;
  _slotConnId?: string;
  _hasRequestSlot: boolean;
  _reqWindowStart?: number;
  _reqCount: number;
}

// ── Logger ──────────────────────────────────────────────────────────────────
const LOG_LEVELS: Record<string, number> = { error: 0, warn: 1, info: 2, debug: 3 };
const LOG_COLORS: Record<string, string> = { error: '\x1b[31m', warn: '\x1b[33m', info: '\x1b[36m', debug: '\x1b[90m' };
const RESET = '\x1b[0m';
const logLevelNum = LOG_LEVELS[process.env.LOG_LEVEL ?? 'info'] ?? LOG_LEVELS['info']!;
const useTTYColors = process.stdout.isTTY;

function log(level: string, ...args: unknown[]): void {
  if (LOG_LEVELS[level]! > logLevelNum) return;
  const ts = new Date().toISOString();
  const c = useTTYColors ? (LOG_COLORS[level] ?? '') : '';
  const r = useTTYColors ? RESET : '';
  console.log(`${c}[${ts}] ${level.toUpperCase().padEnd(5)}${r}`, ...args);
}

const logger = {
  error: (...a: unknown[]) => log('error', ...a),
  warn:  (...a: unknown[]) => log('warn',  ...a),
  info:  (...a: unknown[]) => log('info',  ...a),
  debug: (...a: unknown[]) => log('debug', ...a),
};

function sid(id: string | null | undefined): string {
  return id ? id.slice(0, 8) + '\u2026' : '(none)';
}

// ── Rate limiting ─────────────────────────────────────────────────────────────
interface RateLimiterEntry { count: number; resetAt: number }

function makeRateLimiter({ windowMs, max, message = 'Too many requests — try again later' }: {
  windowMs: number;
  max: number;
  message?: string;
}): (req: Request, res: Response, next: NextFunction) => void {
  const hits = new Map<string, RateLimiterEntry>();
  setInterval(() => {
    const now = Date.now();
    for (const [ip, e] of hits) if (now >= e.resetAt) hits.delete(ip);
  }, windowMs).unref();
  return function rateLimiter(req, res, next) {
    const ip  = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    const now = Date.now();
    let e = hits.get(ip);
    if (!e || now >= e.resetAt) { e = { count: 0, resetAt: now + windowMs }; hits.set(ip, e); }
    if (++e.count > max) {
      logger.warn(`Rate limit  ip=${ip}  path=${req.path}`);
      res.status(429).json({ error: message });
      return;
    }
    next();
  };
}

const MAX_SESSIONS         = Number(process.env.MAX_SESSIONS)         || 500;
const MAX_SESSION_REQUESTS = Number(process.env.MAX_SESSION_REQUESTS) || 100;
const WS_REQ_RATE_MAX       = Number(process.env.WS_REQ_RATE_MAX)       || 10;
const WS_REQ_RATE_WINDOW_MS  = (Number(process.env.WS_REQ_RATE_WINDOW_MIN)  || 1) * 60_000;
const WS_CONN_RATE_MAX       = Number(process.env.WS_CONN_RATE_MAX)       || 60;
const WS_CONN_RATE_WINDOW_MS = (Number(process.env.WS_CONN_RATE_WINDOW_MIN) || 1) * 60_000;

const buttmLimiter = makeRateLimiter({ windowMs: 60_000, max: 30 });
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
const YT_KEYS = (process.env.YOUTUBE_API_KEYS ?? '')
  .split(',').map(k => k.trim()).filter(Boolean);
if (!YT_KEYS.length) logger.warn('No YOUTUBE_API_KEYS configured — search will be unavailable');

const retiredKeys = new Map<string, number>();
let keyIndex = 0;

function retireUntilMidnightUTC(): number {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
}

function getNextKey(): string | null {
  const now = Date.now();
  for (const [k, until] of retiredKeys) if (now >= until) retiredKeys.delete(k);
  const n = YT_KEYS.length;
  for (let i = 0; i < n; i++) {
    const key = YT_KEYS[(keyIndex + i) % n]!;
    if (!retiredKeys.has(key)) {
      keyIndex = (keyIndex + i + 1) % n;
      return key;
    }
  }
  return null;
}

function retireKey(key: string): void {
  retiredKeys.set(key, retireUntilMidnightUTC());
  const remaining = YT_KEYS.filter(k => !retiredKeys.has(k)).length;
  if (remaining === 0) {
    logger.warn('All YouTube API keys exhausted — search unavailable until midnight UTC');
  } else {
    logger.warn(`YouTube key …${key.slice(-4)} quota exceeded — retired until midnight UTC (${remaining} key(s) remaining)`);
  }
}

const SEARCH_CACHE_TTL_SECS = (Number(process.env.SEARCH_CACHE_TTL_MIN) || 60) * 60;

const app = express();
app.set('trust proxy', 1);
const server = http.createServer(app);

// ── WS connection rate limiter ────────────────────────────────────────────────
const wsConnHits = new Map<string, RateLimiterEntry>();
setInterval(() => {
  const now = Date.now();
  for (const [ip, e] of wsConnHits) if (now >= e.resetAt) wsConnHits.delete(ip);
}, WS_CONN_RATE_WINDOW_MS).unref();

function checkWsConnLimit(ip: string): boolean {
  const now = Date.now();
  let e = wsConnHits.get(ip);
  if (!e || now >= e.resetAt) { e = { count: 0, resetAt: now + WS_CONN_RATE_WINDOW_MS }; wsConnHits.set(ip, e); }
  return ++e.count <= WS_CONN_RATE_MAX;
}

const wss = new WebSocketServer({
  server,
  verifyClient: ({ req }: { req: IncomingMessage }, done: (res: boolean, code?: number, message?: string) => void) => {
    const ip = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ?? req.socket.remoteAddress ?? 'unknown';
    if (!checkWsConnLimit(ip)) {
      logger.warn(`WS conn rate limit  ip=${ip}`);
      done(false, 429, 'Too Many Requests');
      return;
    }
    done(true);
  },
});

const AUTH_TOKEN = process.env.AUTH_TOKEN ?? null;
const AUTH_HASH  = AUTH_TOKEN ? createHash('sha256').update(AUTH_TOKEN).digest('hex') : null;
const TITLE_BROADCAST = process.env.TITLE_BROADCAST ?? null;

// ── Auth (optional) ───────────────────────────────────────────────────────────
function getCookie(req: Request | IncomingMessage, name: string): string | null {
  const header = (req.headers as Record<string, string | undefined>)['cookie'] ?? '';
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!AUTH_HASH) { next(); return; }

  const p = req.path;
  const cookieToken = getCookie(req, 'kp_auth');

  // Root index and audience pages are always accessible.
  if (p === '/' || p === '/index.html') { next(); return; }
  if (p === '/request/' || p === '/request/index.html') { next(); return; }
  if (p === '/display/' || p === '/display/index.html') { next(); return; }

  // Only gate HTML entry points; CSS/JS assets load freely.
  if (!p.endsWith('/') && !p.endsWith('.html')) { next(); return; }

  if (cookieToken === AUTH_HASH) { next(); return; }

  logger.debug(`Auth redirect ${req.path} → / for ${req.ip}`);
  res.redirect(302, '/?redirect=' + encodeURIComponent(req.originalUrl));
}

// ── Redis ─────────────────────────────────────────────────────────────────────
const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
const redis    = new Redis(REDIS_URL, { lazyConnect: true });
const subRedis = new Redis(REDIS_URL, { lazyConnect: true });

redis.on('error',    (err: Error) => logger.error('Redis error:',     err.message));
subRedis.on('error', (err: Error) => logger.error('Redis sub error:', err.message));

// ── Redis key schema ──────────────────────────────────────────────────────────
const K = {
  session:        (id: string)  => `kk:session:${id}`,
  presence:       (id: string)  => `kk:presence:${id}`,
  sessions:       ()            => 'kk:sessions',
  search:         (q: string)   => `kk:search:${q}`,
  playlistSearch: (q: string)   => `kk:plsearch:${q}`,
  playlistItems:  (id: string)  => `kk:plitems:${id}`,
  channel:        (id: string)  => `kk:state:${id}`,
};

// ── Sessions ──────────────────────────────────────────────────────────────────
const SESSION_TTL_SECS = (Number(process.env.SESSION_TTL_HOURS) || 4) * 60 * 60;

function newSessionData(): SessionState {
  return {
    queue:                [],
    nowPlaying:           null,
    paused:               false,
    nextId:               1,
    requests:             [],
    nextRequestId:        1,
    requestMode:          'kiosk',
    blockedDevices:       [],
    bannedDevices:        [],
    standbyPlaylistId:        null,
    standbyPlaylistTitle:     null,
    standbyPlaylistThumbnail: null,
    standbyTrack:             null,
    standbyVolume:            75,
    videoVolume:          100,
    fadeDuration:         1500,
    micVolume:            80,
    micMuted:             false,
    standbyPaused:        false,
    playerMode:           'karaoke',
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

async function getSession(id: string | null | undefined): Promise<SessionState | null> {
  if (!id) return null;
  const raw = await redis.get(K.session(id));
  return raw ? (JSON.parse(raw) as SessionState) : null;
}

async function saveSession(id: string, session: SessionState): Promise<void> {
  session.lastActivity = Date.now();
  await redis.pipeline()
    .set(K.session(id), JSON.stringify(session))
    .expire(K.session(id),  SESSION_TTL_SECS)
    .expire(K.presence(id), SESSION_TTL_SECS)
    .exec();
}

async function createSession(): Promise<string | null> {
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

async function touchSession(sessionId: string): Promise<void> {
  await redis.pipeline()
    .expire(K.session(sessionId),  SESSION_TTL_SECS)
    .expire(K.presence(sessionId), SESSION_TTL_SECS)
    .exec();
}

async function markPresence(sessionId: string, role: string, delta: number): Promise<void> {
  await redis.hincrby(K.presence(sessionId), role, delta);
  await redis.expire(K.presence(sessionId), SESSION_TTL_SECS);
}

setInterval(async () => {
  try {
    const ids = await redis.smembers(K.sessions());
    if (!ids.length) return;
    const pipeline = redis.pipeline();
    for (const id of ids) pipeline.exists(K.session(id));
    const results = await pipeline.exec();
    const expired = ids.filter((_, i) => (results?.[i]?.[1] as number) === 0);
    if (expired.length) {
      await redis.srem(K.sessions(), ...expired);
      logger.debug(`Session index: pruned ${expired.length} expired entries`);
    }
  } catch (e) {
    logger.error('Session index cleanup error:', (e as Error).message);
  }
}, 30 * 60_000).unref();

// ── Static serving ────────────────────────────────────────────────────────────
// In production, serve the React build. Default path is relative to compiled
// output in packages/api/dist/ → packages/app/dist/.
const CLIENT_BUILD_PATH = process.env.CLIENT_BUILD_PATH
  ?? path.join(__dirname, '..', '..', 'app', 'dist');

app.use(helmet({
  crossOriginEmbedderPolicy: false,
  contentSecurityPolicy: {
    directives: {
      defaultSrc:  ["'self'"],
      scriptSrc:   ["'self'", 'https://www.youtube.com', 'https://s.ytimg.com'],
      styleSrc:    ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc:     ["'self'", 'https://fonts.gstatic.com'],
      imgSrc:      ["'self'", 'data:', 'https://img.youtube.com', 'https://i.ytimg.com', 'https://s.ytimg.com'],
      frameSrc:    ['https://www.youtube.com'],
      connectSrc:  ["'self'", 'ws:', 'wss:'],
      objectSrc:   ["'none'"],
      baseUri:     ["'self'"],
    },
  },
}));
app.use(authMiddleware);
app.use(express.json({ limit: '4kb' }));
app.use(express.static(CLIENT_BUILD_PATH));

// ── Local client registry + pub/sub dispatch ──────────────────────────────────
const localClients = new Map<string, Set<KaraokeWs>>();

function addLocalClient(sessionId: string, ws: KaraokeWs): void {
  if (!localClients.has(sessionId)) localClients.set(sessionId, new Set());
  localClients.get(sessionId)!.add(ws);
}

function removeLocalClient(sessionId: string, ws: KaraokeWs): boolean {
  const set = localClients.get(sessionId);
  if (!set) return false;
  const removed = set.delete(ws);
  if (set.size === 0) localClients.delete(sessionId);
  return removed;
}

// ── Per-session message serialization ────────────────────────────────────────
const sessionLocks = new Map<string, Promise<void>>();

function withSessionLock(sessionId: string, fn: () => Promise<void>): void {
  const previous = sessionLocks.get(sessionId) ?? Promise.resolve();
  const next = previous.then(fn).catch((err: Error) =>
    logger.error(`WS handler error session=${sid(sessionId)}:`, err.message)
  );
  sessionLocks.set(sessionId, next.then(() => {
    if (sessionLocks.get(sessionId) === next) sessionLocks.delete(sessionId);
  }));
}

// ── Role slot enforcement ─────────────────────────────────────────────────────
const SLOT_TTL_SECS     = 30;
const SLOT_HEARTBEAT_MS = 15_000;

const slotKey = (sessionId: string, role: string) => `kk:slot:${sessionId}:${role}`;

async function claimSlot(sessionId: string, role: string, connId: string): Promise<boolean> {
  // ioredis SET NX EX: use the options-object overload to satisfy TypeScript
  const result = await (redis as unknown as { set: (k: string, v: string, ex: string, ttl: number, nx: string) => Promise<string | null> })
    .set(slotKey(sessionId, role), connId, 'EX', SLOT_TTL_SECS, 'NX');
  return result === 'OK';
}

async function releaseSlot(sessionId: string, role: string, connId?: string): Promise<void> {
  if (connId) {
    await redis.eval(
      "if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end",
      1, slotKey(sessionId, role), connId
    );
  } else {
    await redis.del(slotKey(sessionId, role));
  }
}

async function refreshSlot(sessionId: string, role: string): Promise<void> {
  await redis.expire(slotKey(sessionId, role), SLOT_TTL_SECS);
}

async function publishRaw(sessionId: string, data: ServerMessage): Promise<void> {
  await redis.publish(K.channel(sessionId), JSON.stringify(data));
}

async function broadcastState(sessionId: string): Promise<void> {
  const [session, presenceArr] = await Promise.all([
    getSession(sessionId),
    redis.hmget(K.presence(sessionId), 'player', 'controller', 'request'),
  ]);
  if (!session) return;

  const localSet = localClients.get(sessionId);
  const liveLocal = { player: 0, controller: 0, request: 0 };
  if (localSet) {
    for (const c of localSet) {
      if (c.readyState === 1 && c.role in liveLocal) {
        liveLocal[c.role as keyof typeof liveLocal]++;
      }
    }
  }
  const playerCount     = Math.max(Number(presenceArr[0]) || 0, liveLocal.player);
  const controllerCount = Math.max(Number(presenceArr[1]) || 0, liveLocal.controller);
  const requestCount    = Math.max(Number(presenceArr[2]) || 0, liveLocal.request);

  if (controllerCount === 0) {
    logger.warn(`broadcastState controllerConnected=false  session=${sid(sessionId)}`);
  }

  await publishRaw(sessionId, {
    type:                 'state',
    queue:                 session.queue,
    nowPlaying:            session.nowPlaying,
    paused:                session.paused,
    playerConnected:       playerCount     > 0,
    controllerConnected:   controllerCount > 0,
    requesterCount:        requestCount,
    requests:              session.requests.map(({ deviceToken: _dt, ...r }) => r),
    requestMode:           session.requestMode,
    blockedCount:          (session.blockedDevices ?? []).length,
    bannedCount:           (session.bannedDevices  ?? []).length,
    standbyPlaylistId:         session.standbyPlaylistId    ?? null,
    standbyPlaylistTitle:      session.standbyPlaylistTitle  ?? null,
    standbyPlaylistThumbnail:  session.standbyPlaylistThumbnail ?? null,
    standbyTrack:              session.standbyTrack          ?? null,
    standbyVolume:             session.standbyVolume  ?? 75,
    videoVolume:               session.videoVolume    ?? 100,
    fadeDuration:              session.fadeDuration   ?? 1500,
    micVolume:                 session.micVolume      ?? 80,
    micMuted:                  !!session.micMuted,
    standbyPaused:             session.standbyPaused  ?? false,
    playerMode:                session.playerMode      ?? 'karaoke',
    standbyTitle:              session.standbyTitle    ?? 'Karaoke Browser',
    standbySubtitle:           session.standbySubtitle ?? 'Your karaoke night command center',
    standbyColors:             session.standbyColors   ?? ['#4cc9f0', '#4361ee', '#7c3aed', '#f72585', '#ff6b35', '#ffd166', '#06d6a0', '#3a0ca3'],
    standbyTitleColor:          session.standbyTitleColor         ?? '#ffffff',
    standbyTitleOutline:        session.standbyTitleOutline       ?? '#000000',
    standbyTitleFont:           session.standbyTitleFont          ?? '',
    standbyTitleSize:           session.standbyTitleSize          ?? 0,
    standbyTitleOutlineSize:    session.standbyTitleOutlineSize   ?? 20,
    standbySubtitleColor:       session.standbySubtitleColor      ?? '#ffffff',
    standbySubtitleOutline:     session.standbySubtitleOutline    ?? '#000000',
    standbySubtitleFont:        session.standbySubtitleFont       ?? '',
    standbySubtitleSize:        session.standbySubtitleSize       ?? 0,
    standbySubtitleOutlineSize: session.standbySubtitleOutlineSize ?? 8,
  });
}

// ── Utility functions ─────────────────────────────────────────────────────────

function extractPlaylistId(url: string): string | null {
  if (typeof url !== 'string') return null;
  const m = url.match(/[?&]list=([A-Za-z0-9_-]+)/);
  if (!m) return null;
  const id = m[1]!.replace(/^VL/, '');
  return id.length >= 2 ? id : null;
}

function extractVideoId(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  const patterns = [
    /[?&]v=([A-Za-z0-9_-]{11})/,
    /youtu\.be\/([A-Za-z0-9_-]{11})/,
    /\/embed\/([A-Za-z0-9_-]{11})/,
    /\/shorts\/([A-Za-z0-9_-]{11})/,
  ];
  for (const re of patterns) {
    const m = url.match(re);
    if (m) return m[1]!;
  }
  return null;
}

function sanitiseTitle(str: unknown): string {
  if (typeof str !== 'string') return '';
  return str.trim().slice(0, 200);
}

function cleanTitle(str: string): string {
  const s = sanitiseTitle(str);
  if (!s) return s;
  const sep = s.match(/\s+(\u2013|\u2014|\||-{1,2}|\/\/)\s+/);
  if (!sep) return s;
  const left  = s.slice(0, sep.index).trim();
  const after = s.slice((sep.index ?? 0) + sep[0]!.length);
  const right = after
    .split(/\s+(?:\u2013|\u2014|\||-{1,2}|\/\/)\s+/)[0]!
    .replace(/\s*[\(\[\uff08\u3010].*$/, '')
    .trim();
  if (!left || !right) return s;
  return `${left} ${sep[1]} ${right}`;
}

function decodeEntities(str: string): string {
  return str
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'");
}

async function playNext(sessionId: string, session: SessionState): Promise<void> {
  session.paused     = false;
  session.nowPlaying = session.queue.length > 0 ? session.queue.shift()! : null;
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
  if (!AUTH_HASH) { res.json({ ok: true }); return; }
  const { hash } = (req.body as Record<string, unknown>) ?? {};
  if (typeof hash !== 'string' || hash !== AUTH_HASH) {
    logger.warn(`Login failed from ${req.ip}`);
    res.status(401).json({ ok: false });
    return;
  }
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  const maxAge = 30 * 24 * 60 * 60;
  res.setHeader('Set-Cookie',
    `kp_auth=${AUTH_HASH}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure ? '; Secure' : ''}`);
  logger.info(`Login success from ${req.ip}`);
  res.json({ ok: true });
});

app.post('/api/logout', (_req, res) => {
  res.setHeader('Set-Cookie', 'kp_auth=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
  res.json({ ok: true });
});

// ── REST – session ────────────────────────────────────────────────────────────

app.post('/api/session/create', createSessionLimiter, async (req, res) => {
  let id: string;
  let requestMode = 'kiosk';
  if (AUTH_HASH) {
    id = AUTH_HASH;
    const existing = await getSession(id);
    if (!existing) {
      const count = await redis.scard(K.sessions());
      if (count >= MAX_SESSIONS) {
        res.status(503).json({ error: 'Server is at capacity — try again later' });
        return;
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
      requestMode = existing.requestMode ?? 'kiosk';
      logger.debug(`Session resumed (auth mode): ${sid(id)}`);
    }
  } else {
    const newId = await createSession();
    if (!newId) { res.status(503).json({ error: 'Server is at capacity — try again later' }); return; }
    id = newId;
  }
  res.json({ sessionId: id, requestMode });
});

app.get('/api/session', async (req, res) => {
  const { s } = req.query as Record<string, string | undefined>;
  if (!s || s.length > 128) { res.status(400).json({ error: 'Invalid session id' }); return; }
  const session = await getSession(s);
  if (!session) { res.status(404).json({ error: 'Session not found' }); return; }
  res.json({ sessionId: s, requestMode: session.requestMode ?? 'kiosk' });
});

app.post('/api/session/mode', async (req, res) => {
  if (AUTH_HASH && getCookie(req, 'kp_auth') !== AUTH_HASH) {
    res.status(401).json({ error: 'Unauthorized' }); return;
  }
  const { sessionId, mode } = (req.body as Record<string, unknown>) ?? {};
  if (mode !== 'kiosk' && mode !== 'crowd') { res.status(400).json({ error: 'Invalid mode' }); return; }
  const session = await getSession(sessionId as string);
  if (!session) { res.status(404).json({ error: 'Session not found' }); return; }
  if (session.requestMode !== mode) {
    session.requestMode = mode as 'kiosk' | 'crowd';
    await saveSession(sessionId as string, session);
    await broadcastState(sessionId as string);
  }
  res.json({ ok: true });
});

app.post('/api/session/reset', async (req, res) => {
  if (AUTH_HASH && getCookie(req, 'kp_auth') !== AUTH_HASH) {
    res.status(401).json({ error: 'Unauthorized' }); return;
  }
  const { sessionId } = (req.body as Record<string, unknown>) ?? {};
  if (!sessionId || typeof sessionId !== 'string') {
    res.status(400).json({ error: 'Missing sessionId' }); return;
  }
  const existing = await getSession(sessionId);
  if (!existing) { res.status(404).json({ error: 'Session not found' }); return; }
  const fresh = newSessionData();
  fresh.requestMode = existing.requestMode ?? 'kiosk';
  await saveSession(sessionId, fresh);
  await broadcastState(sessionId);
  logger.info(`Session reset  session=${sid(sessionId)}`);
  res.json({ ok: true });
});

// ── REST – title broadcast (hidden; requires TITLE_BROADCAST env var) ─────────
if (TITLE_BROADCAST) {
  app.get('/api/buttm', buttmLimiter, async (req, res) => {
    const q = req.query as Record<string, string | undefined>;
    if (AUTH_TOKEN && q['auth'] !== AUTH_TOKEN) {
      res.status(403).type('text/plain').send('Forbidden'); return;
    }
    const session = await getSession(q['s'] ?? null);
    if (session) {
      const title = (session.nowPlaying?.title && !session.paused ? session.nowPlaying.title : null)
        ?? (session.standbyTrack?.title ? cleanTitle(session.standbyTrack.title) : null)
        ?? null;
      res.type('text/plain').send(title ?? TITLE_BROADCAST);
      return;
    }
    res.type('text/plain').send(TITLE_BROADCAST);
  });
}

// ── REST – title lookup ───────────────────────────────────────────────────────

app.get('/api/title', titleLimiter, async (req, res) => {
  const videoId = extractVideoId(req.query['url']);
  if (!videoId) { res.json({ title: null }); return; }

  try {
    const r = await fetch(
      `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&format=json`,
      { signal: AbortSignal.timeout(5000) }
    );
    if (r.ok) {
      const data = await r.json() as { title?: string };
      if (data.title) { res.json({ title: cleanTitle(decodeEntities(data.title)) }); return; }
    }
  } catch { /* fall through */ }

  try {
    const r = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const html = await r.text();
    const ogMatch = html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/);
    if (ogMatch) { res.json({ title: cleanTitle(decodeEntities(ogMatch[1]!)) }); return; }
    const titleMatch = html.match(/<title>([^<]+)<\/title>/);
    if (titleMatch) {
      const t = decodeEntities(titleMatch[1]!).replace(/ - YouTube$/, '').trim();
      res.json({ title: cleanTitle(t) }); return;
    }
  } catch { /* ignore */ }

  res.json({ title: null });
});

// ── REST – YouTube search ─────────────────────────────────────────────────────

app.get('/api/search', searchLimiter, async (req, res) => {
  if (!YT_KEYS.length) {
    res.status(503).json({ error: 'No YouTube API keys configured — add YOUTUBE_API_KEYS to .env' }); return;
  }
  const raw = req.query['q'];
  if (!raw || typeof raw !== 'string') { res.json({ results: [] }); return; }
  const q = sanitiseTitle(raw).slice(0, 150);
  if (!q) { res.json({ results: [] }); return; }

  const cachedRaw = await redis.get(K.search(q));
  if (cachedRaw) { res.json({ results: JSON.parse(cachedRaw) }); return; }

  const apiKey = getNextKey();
  if (!apiKey) {
    res.status(503).json({ error: 'YouTube API quota exhausted — try again after midnight UTC' }); return;
  }

  try {
    type YtItem = { id: { videoId: string }; snippet: { title: string; channelTitle: string; thumbnails?: { medium?: { url: string }; default?: { url: string } } } };
    type VidItem = { id: string; status?: { embeddable: boolean } };

    const sr = await fetch(
      'https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=15' +
      '&q=' + encodeURIComponent(q) + '&key=' + encodeURIComponent(apiKey),
      { signal: AbortSignal.timeout(8000) }
    );
    if (sr.status === 403) { retireKey(apiKey); res.status(503).json({ error: 'YouTube API quota exceeded — key rotated, try again' }); return; }
    if (!sr.ok) throw new Error(`Search HTTP ${sr.status}`);
    const sd = await sr.json() as { items?: YtItem[] };
    const items = sd.items ?? [];
    if (!items.length) { res.json({ results: [] }); return; }

    const ids = items.map(i => i.id.videoId).filter(Boolean).join(',');
    const vr = await fetch(
      'https://www.googleapis.com/youtube/v3/videos?part=status&id=' + encodeURIComponent(ids) + '&key=' + encodeURIComponent(apiKey),
      { signal: AbortSignal.timeout(8000) }
    );
    if (!vr.ok) throw new Error(`Videos HTTP ${vr.status}`);
    const vd = await vr.json() as { items?: VidItem[] };
    const embeddable = new Set((vd.items ?? []).filter(v => v.status?.embeddable).map(v => v.id));

    const results = items
      .filter(i => embeddable.has(i.id.videoId))
      .map(i => ({
        videoId: i.id.videoId,
        title:   cleanTitle(decodeEntities(i.snippet.title)),
        channel: sanitiseTitle(decodeEntities(i.snippet.channelTitle)),
        thumb:   i.snippet.thumbnails?.medium?.url ?? i.snippet.thumbnails?.default?.url ?? '',
        url:     'https://www.youtube.com/watch?v=' + i.id.videoId,
      }));

    await redis.set(K.search(q), JSON.stringify(results), 'EX', SEARCH_CACHE_TTL_SECS);
    res.json({ results });
  } catch (e) {
    logger.error('Search error:', (e as Error).message);
    res.status(500).json({ error: 'Search failed' });
  }
});

// ── REST – Mixer ──────────────────────────────────────────────────────────────

app.get('/api/mixer/search', searchLimiter, async (req, res) => {
  if (!YT_KEYS.length) { res.status(503).json({ error: 'not_configured' }); return; }
  const raw = req.query['q'];
  if (!raw || typeof raw !== 'string') { res.json({ items: [] }); return; }
  const q = sanitiseTitle(raw).slice(0, 150);
  if (!q) { res.json({ items: [] }); return; }

  const cached = await redis.get(K.playlistSearch(q));
  if (cached) { res.json({ items: JSON.parse(cached) }); return; }

  const apiKey = getNextKey();
  if (!apiKey) { res.status(503).json({ error: 'quota_exhausted' }); return; }

  try {
    type PlItem = { id: { playlistId: string }; snippet: { title: string; channelTitle: string; thumbnails?: { medium?: { url: string }; default?: { url: string } } } };
    const sr = await fetch(
      'https://www.googleapis.com/youtube/v3/search?part=snippet&type=playlist&maxResults=12' +
      '&q=' + encodeURIComponent(q) + '&key=' + encodeURIComponent(apiKey),
      { signal: AbortSignal.timeout(8000) }
    );
    if (sr.status === 403) { retireKey(apiKey); res.status(503).json({ error: 'quota_exhausted' }); return; }
    if (!sr.ok) throw new Error(`HTTP ${sr.status}`);
    const sd = await sr.json() as { items?: PlItem[] };
    const items = (sd.items ?? []).map(i => ({
      playlistId:   i.id.playlistId,
      title:        sanitiseTitle(decodeEntities(i.snippet.title)).slice(0, 120),
      channelTitle: sanitiseTitle(decodeEntities(i.snippet.channelTitle)).slice(0, 80),
      thumbnail:    i.snippet.thumbnails?.medium?.url ?? i.snippet.thumbnails?.default?.url ?? '',
    })).filter(i => i.playlistId);
    await redis.set(K.playlistSearch(q), JSON.stringify(items), 'EX', SEARCH_CACHE_TTL_SECS);
    res.json({ items });
  } catch (e) {
    logger.error('Playlist search error:', (e as Error).message);
    res.status(500).json({ error: 'search_failed' });
  }
});

app.get('/api/mixer/playlist-items', searchLimiter, async (req, res) => {
  if (!YT_KEYS.length) { res.status(503).json({ error: 'not_configured' }); return; }
  const q = req.query as Record<string, string | undefined>;
  if (!q['s'] || !(await getSession(q['s']))) { res.status(403).json({ error: 'Invalid session' }); return; }
  const playlistId = q['id'];
  if (!playlistId || !/^[A-Za-z0-9_-]{10,60}$/.test(playlistId)) { res.status(400).json({ error: 'invalid_id' }); return; }

  const cached = await redis.get(K.playlistItems(playlistId));
  if (cached) { res.json({ items: JSON.parse(cached) }); return; }

  const apiKey = getNextKey();
  if (!apiKey) { res.status(503).json({ error: 'quota_exhausted' }); return; }

  try {
    type PliItem = { snippet?: { resourceId?: { kind: string; videoId: string }; title: string; thumbnails?: { medium?: { url: string }; default?: { url: string } } } };
    const r = await fetch(
      'https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&maxResults=50' +
      '&playlistId=' + encodeURIComponent(playlistId) + '&key=' + encodeURIComponent(apiKey),
      { signal: AbortSignal.timeout(8000) }
    );
    if (r.status === 403) { retireKey(apiKey); res.status(503).json({ error: 'quota_exhausted' }); return; }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json() as { items?: PliItem[] };
    const items = (data.items ?? [])
      .filter(i => i.snippet?.resourceId?.kind === 'youtube#video')
      .map(i => ({
        videoId:   i.snippet!.resourceId!.videoId,
        title:     sanitiseTitle(decodeEntities(i.snippet!.title)).slice(0, 120),
        thumbnail: i.snippet!.thumbnails?.medium?.url ?? i.snippet!.thumbnails?.default?.url ?? '',
      }));
    await redis.set(K.playlistItems(playlistId), JSON.stringify(items), 'EX', SEARCH_CACHE_TTL_SECS);
    res.json({ items });
  } catch (e) {
    logger.error('Playlist items error:', (e as Error).message);
    res.status(500).json({ error: 'fetch_failed' });
  }
});

app.get('/api/qr', qrLimiter, async (req, res) => {
  const q = req.query as Record<string, string | undefined>;
  if (!q['s'] || !(await getSession(q['s']))) { res.status(403).json({ error: 'Invalid session' }); return; }
  const data = q['data'];
  if (!data || data.length > 2048) { res.status(400).json({ error: 'Missing or invalid data param' }); return; }
  try {
    const dataUrl = await QRCode.toDataURL(data, { width: 256, margin: 2, color: { dark: '#000000', light: '#ffffff' } });
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.json({ dataUrl });
  } catch (e) {
    logger.error('QR generation error:', (e as Error).message);
    res.status(500).json({ error: 'QR generation failed' });
  }
});

app.get('/api/standby-theme', async (req, res) => {
  const { s } = req.query as Record<string, string | undefined>;
  if (!s || s.length > 128) { res.status(400).json({ error: 'Invalid session id' }); return; }
  const session = await getSession(s);
  if (!session) { res.status(404).json({ error: 'Session not found' }); return; }
  const defs = ['#4cc9f0', '#4361ee', '#7c3aed', '#f72585', '#ff6b35', '#ffd166', '#06d6a0', '#3a0ca3'];
  res.json({
    standbyColors:              session.standbyColors              ?? defs,
    standbyTitleColor:          session.standbyTitleColor          ?? '#ffffff',
    standbyTitleOutline:        session.standbyTitleOutline        ?? '#000000',
    standbyTitleOutlineSize:    session.standbyTitleOutlineSize    ?? 20,
    standbySubtitleColor:       session.standbySubtitleColor       ?? '#ffffff',
    standbySubtitleOutline:     session.standbySubtitleOutline     ?? '#000000',
    standbySubtitleOutlineSize: session.standbySubtitleOutlineSize ?? 8,
  });
});

// ── WebSocket ─────────────────────────────────────────────────────────────────

wss.on('connection', async (rawWs: WebSocket, req: IncomingMessage) => {
  const ws = rawWs as KaraokeWs;
  const wsUrl = new URL(req.url ?? '/', 'http://localhost');
  const role = wsUrl.searchParams.get('role') ?? 'unknown';
  const ip = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim()
    ?? req.socket.remoteAddress ?? 'unknown';

  if (AUTH_HASH && role !== 'request' && getCookie(req as unknown as Request, 'kp_auth') !== AUTH_HASH) {
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
  let slotHeartbeat: ReturnType<typeof setInterval> | null = null;
  ws._hasRequestSlot = false;

  if (role === 'controller' || role === 'player') {
    const connId = randomBytes(8).toString('hex');
    let claimed  = await claimSlot(sessionId!, role, connId);
    if (!claimed) {
      const localSet = localClients.get(sessionId!);
      const liveLocal = localSet && [...localSet].find(c => c.role === role && c.readyState === 1);
      if (!liveLocal) {
        await redis.set(slotKey(sessionId!, role), connId, 'EX', SLOT_TTL_SECS);
        claimed = true;
        logger.info(`WS stale slot evicted  role=${role} session=${sid(sessionId)} ip=${ip}`);
      } else {
        liveLocal.close(4410, 'Replaced by new connection');
        await redis.set(slotKey(sessionId!, role), connId, 'EX', SLOT_TTL_SECS);
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
    slotHeartbeat = setInterval(() => refreshSlot(sessionId!, role).catch(() => {}), SLOT_HEARTBEAT_MS);
  } else if (role === 'request' && initSession.requestMode === 'kiosk') {
    const connId  = randomBytes(8).toString('hex');
    const claimed = await claimSlot(sessionId!, 'request', connId);
    if (!claimed) {
      logger.warn(`WS kiosk slot occupied  session=${sid(sessionId)} ip=${ip}`);
      ws.close(4409, 'Kiosk already connected');
      return;
    }
    ws._hasRequestSlot = true;
    slotHeartbeat = setInterval(() => refreshSlot(sessionId!, 'request').catch(() => {}), SLOT_HEARTBEAT_MS);
  }

  logger.info(`WS connect    role=${role.padEnd(10)} session=${sid(sessionId)} ip=${ip}`);
  addLocalClient(sessionId!, ws);
  await touchSession(sessionId!);
  await markPresence(sessionId!, role, 1);
  await broadcastState(sessionId!);

  ws.on('close', async (code: number) => {
    if (slotHeartbeat) clearInterval(slotHeartbeat);
    if (role === 'controller' || role === 'player') await releaseSlot(sessionId!, role, ws._slotConnId);
    if (ws._hasRequestSlot) await releaseSlot(sessionId!, 'request');
    const wasLocal = removeLocalClient(sessionId!, ws);
    if (wasLocal) await markPresence(sessionId!, role, -1);
    logger.info(`WS disconnect role=${role.padEnd(10)} session=${sid(sessionId)} code=${code} wasLocal=${wasLocal}`);
    if (wasLocal && (role === 'player' || role === 'controller' || role === 'request')) {
      await broadcastState(sessionId!);
    }
  });

  ws.on('message', (raw: RawData) => {
    withSessionLock(sessionId!, async () => {
      let msg: ClientMessage;
      try { msg = JSON.parse(raw.toString()) as ClientMessage; } catch { return; }
      logger.debug(`WS msg        type=${String(msg.type).padEnd(14)} session=${sid(sessionId)}`);

      const session = await getSession(sessionId);
      if (!session) return;

      switch (msg.type) {
        case 'hello': {
          if (role !== 'request') break;
          const hToken = msg.deviceToken.slice(0, 80);
          const isBanned  = (session.bannedDevices  ?? []).includes(hToken);
          const isBlocked = !isBanned && session.requestMode === 'crowd' &&
            (session.blockedDevices ?? []).includes(hToken);
          if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'device-status', mode: session.requestMode, blocked: isBlocked, banned: isBanned }));
          break;
        }

        case 'clear-blocked-devices': {
          if (role !== 'controller') break;
          const cleared = session.blockedDevices ?? [];
          if (!cleared.length) break;
          session.blockedDevices = [];
          await saveSession(sessionId!, session);
          await broadcastState(sessionId!);
          for (const token of cleared) await publishRaw(sessionId!, { type: 'device-cleared', token });
          logger.info(`Blocked devices cleared: ${cleared.length}  session=${sid(sessionId)}`);
          break;
        }

        case 'reset-requester-presence': {
          if (role !== 'controller') break;
          const localSet = localClients.get(sessionId!);
          const actual = localSet ? [...localSet].filter(c => c.role === 'request' && c.readyState === 1).length : 0;
          await redis.hset(K.presence(sessionId!), 'request', actual);
          await broadcastState(sessionId!);
          break;
        }

        case 'unban-all-devices': {
          if (role !== 'controller') break;
          if (!(session.bannedDevices ?? []).length) break;
          session.bannedDevices = [];
          await saveSession(sessionId!, session);
          await broadcastState(sessionId!);
          break;
        }

        case 'set-request-mode': {
          if (role !== 'controller') break;
          if (session.requestMode === msg.mode) break;
          session.requestMode = msg.mode;
          if (msg.mode === 'kiosk') session.blockedDevices = [];
          await saveSession(sessionId!, session);
          await broadcastState(sessionId!);
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
            singer: sanitiseTitle(msg.singer ?? ''),
          };
          session.queue.push(item);
          if (!session.nowPlaying) await playNext(sessionId!, session);
          else { await saveSession(sessionId!, session); await broadcastState(sessionId!); }
          break;
        }

        case 'play-index': {
          const idx = Number(msg.index);
          if (Number.isInteger(idx) && idx >= 0 && idx < session.queue.length) {
            session.paused = false;
            session.nowPlaying = session.queue.splice(idx, 1)[0]!;
            await saveSession(sessionId!, session);
            await broadcastState(sessionId!);
          }
          break;
        }

        case 'next':
          await playNext(sessionId!, session);
          break;

        case 'requeue': {
          if (!session.nowPlaying || !session.queue.length) break;
          const requeued = session.nowPlaying;
          session.paused = false;
          session.nowPlaying = session.queue.shift()!;
          session.queue.unshift(requeued);
          await saveSession(sessionId!, session);
          await broadcastState(sessionId!);
          break;
        }

        case 'remove': {
          const idx = Number(msg.index);
          if (Number.isInteger(idx) && idx >= 0 && idx < session.queue.length) {
            session.queue.splice(idx, 1);
            await saveSession(sessionId!, session);
            await broadcastState(sessionId!);
          }
          break;
        }

        case 'reorder': {
          const from = Number(msg.from), to = Number(msg.to);
          if (Number.isInteger(from) && Number.isInteger(to) && from >= 0 && from < session.queue.length && to >= 0 && to < session.queue.length && from !== to) {
            const [item] = session.queue.splice(from, 1);
            session.queue.splice(to, 0, item!);
            await saveSession(sessionId!, session);
            await broadcastState(sessionId!);
          }
          break;
        }

        case 'restart':
          if (session.nowPlaying) {
            session.paused = false;
            await saveSession(sessionId!, session);
            await publishRaw(sessionId!, { type: 'restart' });
          }
          break;

        case 'video-ended': await playNext(sessionId!, session); break;

        case 'pause':
          if (session.nowPlaying) { session.paused = true; await saveSession(sessionId!, session); await broadcastState(sessionId!); }
          break;

        case 'resume':
          if (session.nowPlaying) { session.paused = false; await saveSession(sessionId!, session); await broadcastState(sessionId!); }
          break;

        case 'toggle-pause':
          if (session.nowPlaying) { session.paused = !session.paused; await saveSession(sessionId!, session); await broadcastState(sessionId!); }
          break;

        case 'video-error':
          if (session.nowPlaying) {
            (session.nowPlaying as unknown as Record<string, unknown>)['embedError'] = true;
            await saveSession(sessionId!, session);
            await broadcastState(sessionId!);
          }
          break;

        case 'request': {
          const _now = Date.now();
          if (!ws._reqWindowStart || _now - ws._reqWindowStart > WS_REQ_RATE_WINDOW_MS) { ws._reqWindowStart = _now; ws._reqCount = 0; }
          if (++ws._reqCount > WS_REQ_RATE_MAX) { logger.warn(`WS request flood  session=${sid(sessionId)}`); ws.close(4029, 'Rate limited'); return; }
          if (session.requests.length >= MAX_SESSION_REQUESTS) return;
          const title = sanitiseTitle(msg.title ?? '').slice(0, 120);
          if (!title) return;
          const name   = sanitiseTitle(msg.name   ?? '').slice(0, 120);
          const artist = sanitiseTitle(msg.artist ?? '').slice(0, 120);
          const dToken = typeof msg.deviceToken === 'string' ? msg.deviceToken.slice(0, 80) : '';
          if (dToken && (session.bannedDevices ?? []).includes(dToken)) {
            if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'device-banned', token: dToken }));
            return;
          }
          if (session.requestMode === 'crowd') {
            if (!dToken) return;
            if ((session.blockedDevices ?? []).includes(dToken)) {
              if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'device-status', mode: 'crowd', blocked: true }));
              return;
            }
            session.requests.push({ id: session.nextRequestId++, name, artist, title, deviceToken: dToken });
            if (!session.blockedDevices) session.blockedDevices = [];
            session.blockedDevices.push(dToken);
          } else {
            session.requests.push({ id: session.nextRequestId++, name, artist, title, deviceToken: '' });
          }
          await saveSession(sessionId!, session);
          await broadcastState(sessionId!);
          break;
        }

        case 'dismiss-request': {
          const idx = session.requests.findIndex(r => r.id === msg.id);
          if (idx !== -1) {
            const [dismissed] = session.requests.splice(idx, 1);
            if (dismissed!.deviceToken) {
              if (!session.blockedDevices) session.blockedDevices = [];
              const di = session.blockedDevices.indexOf(dismissed!.deviceToken);
              if (di !== -1) session.blockedDevices.splice(di, 1);
            }
            await saveSession(sessionId!, session);
            await broadcastState(sessionId!);
            if (dismissed!.deviceToken) await publishRaw(sessionId!, { type: 'device-cleared', token: dismissed!.deviceToken });
          }
          break;
        }

        case 'set-standby-playlist': {
          if (role !== 'controller' && role !== 'mixer') break;
          const playlistId = extractPlaylistId(msg.url ?? '');
          if (!playlistId) break;
          session.standbyPlaylistId        = playlistId;
          session.standbyPlaylistTitle     = typeof msg.title     === 'string' ? msg.title.slice(0, 120)     : null;
          session.standbyPlaylistThumbnail = typeof msg.thumbnail === 'string' ? msg.thumbnail.slice(0, 500) : null;
          session.standbyTrack             = null;
          await saveSession(sessionId!, session);
          await broadcastState(sessionId!);
          break;
        }

        case 'clear-standby': {
          if (role !== 'controller' && role !== 'mixer') break;
          session.standbyPlaylistId = null; session.standbyPlaylistTitle = null;
          session.standbyPlaylistThumbnail = null; session.standbyTrack = null;
          await saveSession(sessionId!, session);
          await broadcastState(sessionId!);
          break;
        }

        case 'set-mic-volume': {
          if (role !== 'controller' && role !== 'mixer') break;
          const mv = Number(msg.volume);
          if (!Number.isFinite(mv)) break;
          session.micVolume = Math.round(Math.max(0, Math.min(100, mv)));
          await saveSession(sessionId!, session); await broadcastState(sessionId!);
          break;
        }

        case 'mic-mute': {
          if (role !== 'controller' && role !== 'mixer') break;
          session.micMuted = !!msg.muted;
          await saveSession(sessionId!, session); await broadcastState(sessionId!);
          break;
        }

        case 'standby-skip': {
          if (role !== 'controller' && role !== 'mixer') break;
          if (!session.standbyPlaylistId) break;
          await publishRaw(sessionId!, { type: 'standby-skip' });
          break;
        }

        case 'standby-pause': {
          if (role !== 'controller' && role !== 'mixer') break;
          if (!session.standbyPlaylistId) break;
          session.standbyPaused = true;
          await saveSession(sessionId!, session);
          await publishRaw(sessionId!, { type: 'standby-pause' });
          await broadcastState(sessionId!);
          break;
        }

        case 'standby-resume': {
          if (role !== 'controller' && role !== 'mixer') break;
          if (!session.standbyPlaylistId) break;
          session.standbyPaused = false;
          await saveSession(sessionId!, session);
          await publishRaw(sessionId!, { type: 'standby-resume' });
          await broadcastState(sessionId!);
          break;
        }

        case 'standby-toggle-pause': {
          if (role !== 'controller' && role !== 'mixer') break;
          if (!session.standbyPlaylistId) break;
          session.standbyPaused = !session.standbyPaused;
          await saveSession(sessionId!, session);
          await publishRaw(sessionId!, { type: session.standbyPaused ? 'standby-pause' : 'standby-resume' });
          await broadcastState(sessionId!);
          break;
        }

        case 'standby-track': {
          if (role !== 'player') break;
          const trackVideoId = msg.videoId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 20);
          if (!trackVideoId || !session.standbyPlaylistId) break;
          session.standbyTrack  = { videoId: trackVideoId, title: (msg.title ?? '').slice(0, 200) };
          session.standbyPaused = false;
          await saveSession(sessionId!, session);
          await broadcastState(sessionId!);
          break;
        }

        case 'set-standby-volume': {
          if (role !== 'controller' && role !== 'mixer') break;
          const sv = Number(msg.volume);
          if (!Number.isFinite(sv)) break;
          session.standbyVolume = Math.round(Math.max(0, Math.min(100, sv)));
          await saveSession(sessionId!, session); await broadcastState(sessionId!);
          break;
        }

        case 'set-video-volume': {
          if (role !== 'controller' && role !== 'mixer') break;
          const vv = Number(msg.volume);
          if (!Number.isFinite(vv)) break;
          session.videoVolume = Math.round(Math.max(0, Math.min(100, vv)));
          await saveSession(sessionId!, session); await broadcastState(sessionId!);
          break;
        }

        case 'player-mode':
        case 'set-player-mode': {
          if (role !== 'controller' && role !== 'mixer') break;
          const newMode = msg.mode === 'standby' ? 'standby' : 'karaoke';
          if (session.playerMode === newMode) break;
          session.playerMode = newMode;
          await saveSession(sessionId!, session); await broadcastState(sessionId!);
          break;
        }

        case 'toggle-player-mode': {
          if (role !== 'controller' && role !== 'mixer') break;
          session.playerMode = session.playerMode === 'standby' ? 'karaoke' : 'standby';
          await saveSession(sessionId!, session); await broadcastState(sessionId!);
          break;
        }

        case 'ban-device': {
          if (role !== 'controller') break;
          const bidx = session.requests.findIndex(r => r.id === msg.id);
          if (bidx === -1) break;
          const [banned] = session.requests.splice(bidx, 1);
          if (banned!.deviceToken) {
            if (!session.bannedDevices) session.bannedDevices = [];
            if (!session.bannedDevices.includes(banned!.deviceToken)) session.bannedDevices.push(banned!.deviceToken);
            if (session.blockedDevices) {
              const bi = session.blockedDevices.indexOf(banned!.deviceToken);
              if (bi !== -1) session.blockedDevices.splice(bi, 1);
            }
          }
          await saveSession(sessionId!, session);
          await broadcastState(sessionId!);
          if (banned!.deviceToken) await publishRaw(sessionId!, { type: 'device-banned', token: banned!.deviceToken });
          break;
        }

        case 'set-standby-settings': {
          if (role !== 'controller') break;
          const hexRe = /^#[0-9a-fA-F]{6}$/;
          if (typeof msg.title    === 'string') session.standbyTitle    = msg.title.slice(0, 80);
          if (typeof msg.subtitle === 'string') session.standbySubtitle = msg.subtitle.slice(0, 120);
          if (Array.isArray(msg.colors)) {
            const defs = ['#4cc9f0', '#4361ee', '#7c3aed', '#f72585', '#ff6b35', '#ffd166', '#06d6a0', '#3a0ca3'];
            session.standbyColors = [0,1,2,3,4,5,6,7].map(i => {
              const c = msg.colors![i];
              return (typeof c === 'string' && hexRe.test(c)) ? c : defs[i]!;
            });
          }
          if (typeof msg.titleColor      === 'string' && hexRe.test(msg.titleColor))      session.standbyTitleColor      = msg.titleColor;
          if (typeof msg.titleOutline    === 'string' && hexRe.test(msg.titleOutline))     session.standbyTitleOutline    = msg.titleOutline;
          if (typeof msg.subtitleColor   === 'string' && hexRe.test(msg.subtitleColor))    session.standbySubtitleColor   = msg.subtitleColor;
          if (typeof msg.subtitleOutline === 'string' && hexRe.test(msg.subtitleOutline))  session.standbySubtitleOutline = msg.subtitleOutline;
          if (typeof msg.titleFont    === 'string') session.standbyTitleFont    = msg.titleFont.replace(/[^a-zA-Z0-9 ,'\-_|]/g, '').slice(0, 200);
          if (Number.isFinite(msg.titleSize))       session.standbyTitleSize    = Math.max(0, Math.min(500, Math.round(msg.titleSize!)));
          if (Number.isFinite(msg.titleOutlineSize)) session.standbyTitleOutlineSize = Math.max(0, Math.min(30, Math.round(msg.titleOutlineSize!)));
          if (typeof msg.subtitleFont === 'string') session.standbySubtitleFont = msg.subtitleFont.replace(/[^a-zA-Z0-9 ,'\-_|]/g, '').slice(0, 200);
          if (Number.isFinite(msg.subtitleSize))    session.standbySubtitleSize = Math.max(0, Math.min(500, Math.round(msg.subtitleSize!)));
          if (Number.isFinite(msg.subtitleOutlineSize)) session.standbySubtitleOutlineSize = Math.max(0, Math.min(30, Math.round(msg.subtitleOutlineSize!)));
          await saveSession(sessionId!, session);
          await broadcastState(sessionId!);
          break;
        }
      }
    }); // end withSessionLock
  });
});

// ── Catch-all: serve React SPA ────────────────────────────────────────────────
// Must be after all /api/* routes. Enables React Router deep links — a hard
// refresh on /controller sends index.html; the SPA router takes over.
app.get('*', (_req, res) => {
  res.sendFile(path.join(CLIENT_BUILD_PATH, 'index.html'));
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────

function shutdown(signal: string): void {
  logger.info(`${signal} received — shutting down…`);
  server.close(() => { redis.disconnect(); subRedis.disconnect(); process.exit(0); });
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

// ── Start ─────────────────────────────────────────────────────────────────────

const PORT = process.env['PORT'] ?? 3444;

async function start(): Promise<void> {
  await redis.connect();
  await subRedis.connect();

  try {
    const sessionIds = await redis.smembers(K.sessions());
    if (sessionIds.length) {
      const pipeline = redis.pipeline();
      for (const id of sessionIds) pipeline.hset(K.presence(id), 'player', 0, 'controller', 0, 'request', 0);
      await pipeline.exec();
      logger.info(`Startup: reset presence for ${sessionIds.length} session(s)`);
    }
  } catch (e) { logger.warn('Startup presence reset failed:', (e as Error).message); }

  await subRedis.psubscribe('kk:state:*');
  subRedis.on('pmessage', (_pattern: string, channel: string, message: string) => {
    const sessId   = channel.slice('kk:state:'.length);
    const localSet = localClients.get(sessId);
    if (!localSet) return;
    for (const ws of localSet) if (ws.readyState === 1) ws.send(message);
  });

  server.listen(PORT, () => {
    logger.info(`Karaoke Browser listening on port ${PORT}`);
    logger.info(`  Open:  http://localhost:${PORT}/`);
    logger.info(`  Auth:  ${AUTH_HASH ? 'enabled' : 'disabled'}`);
    logger.info(`  Keys:  ${YT_KEYS.length} YouTube API key(s) configured`);
    logger.info(`  Redis: ${REDIS_URL}`);
    logger.info(`  Log level: ${process.env['LOG_LEVEL'] ?? 'info'}`);
    logger.info(`  Client: ${CLIENT_BUILD_PATH}`);
  });
}

start().catch(err => { logger.error('Startup failed:', (err as Error).message); process.exit(1); });
