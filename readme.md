# karaoke-browser

A self-hosted karaoke room manager. The host creates a session, opens a YouTube-powered **Player** on the venue screen, and manages the song queue from a **Controller** on any device. Audience members scan a QR code to request songs.

---

## Features

- YouTube IFrame player — singers need nothing installed, just a browser
- Song search via YouTube Data API v3, or paste any YouTube URL directly
- Singer name attached to each queued song with a "now singing" slate
- Real-time queue management over WebSocket (reorder by drag-and-drop or buttons)
- Audience request screen — mobile-first form, no login required
- QR code generated on the host page for instant sharing
- Requests column on the controller — Grant pre-fills the search and singer name
- Player start gate — shows controller status, blocks autoplay until the DJ is ready
- Optional password protection for public-facing deployments
- 30-day auth cookie — survives browser restarts and PWA relaunches
- Dark theme throughout, responsive on mobile and desktop

---

## How it works

```
Host (index page)
 └─ creates a session
     ├─ opens Player  →  full-screen on the venue display or OBS browser source
     ├─ opens Controller  →  DJ's phone or laptop
     └─ shares Request QR  →  audience scans and submits song requests
```

The index page, controller, and player all connect to the same session over WebSocket. State (queue, now-playing, requests) is held server-side and broadcast to every connected client on every change.

Session IDs are 40-character random hex strings. The request page uses the session ID as its only credential, so the link is safe to share without a password.

---

## Pages

| Page | Who uses it | URL |
|---|---|---|
| Index | Host — creates session, shares links | `/` |
| Controller | DJ — manages queue and requests | `/controller/` |
| Player | Venue screen / OBS | `/player/` |
| Request | Audience — submits song requests | `/request/?s=<sessionId>` |

---

## Prerequisites

- **Node.js 18+**
- **Redis 6+** — required for session state, pub/sub broadcast, and search cache
- A **YouTube Data API v3 key** (free) for song search. URL-paste and the full queue work without one.

### Getting YouTube API keys

1. Go to [console.cloud.google.com](https://console.cloud.google.com/)
2. Create a project → **APIs & Services** → **Enable APIs**
3. Search for **YouTube Data API v3** and enable it
4. Go to **Credentials** → **Create credentials** → **API key**
5. Repeat to create as many keys as you need (each gets 10,000 units/day free; search costs 100 units)
6. (Recommended) Restrict each key to the YouTube Data API v3 and your server's IP
7. Paste all keys comma-separated into `YOUTUBE_API_KEYS` in your `.env`

---

## Quick start

```bash
git clone <repo-url>
cd karaoke-browser
npm install
cp .env.example .env
# open .env and add your YOUTUBE_API_KEYS (and REDIS_URL if Redis isn't on localhost:6379)
npm start
```

Open **http://localhost:3444** in your browser.

---

## Configuration

Copy `.env.example` to `.env` and edit as needed.

### YouTube / Search

| Variable | Default | Description |
|---|---|---|
| `YOUTUBE_API_KEYS` | — | Comma-separated YouTube Data API v3 keys. Round-robin with automatic quota retirement. Required for search. |
| `SEARCH_CACHE_TTL_MIN` | `60` | How long (minutes) search results are cached. Cached hits cost zero API quota. |

### Server

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3444` | HTTP port the server listens on. |
| `LOG_LEVEL` | `info` | Log verbosity: `error` / `warn` / `info` / `debug`. |
| `REDIS_URL` | `redis://127.0.0.1:6379` | Redis connection URL. Required for multi-instance deployments. |

### Auth

| Variable | Default | Description |
|---|---|---|
| `AUTH_TOKEN` | _(disabled)_ | Password for the room. See [Auth](#auth-optional) below. |

### Sessions

| Variable | Default | Description |
|---|---|---|
| `MAX_SESSIONS` | `500` | Maximum concurrent in-memory sessions. Returns HTTP 503 when full. |
| `SESSION_TTL_HOURS` | `4` | Hours of inactivity before a session is eligible for cleanup. |

### Rate limits

All per-IP unless noted. `_MAX` = request ceiling within the window; `_WINDOW_MIN` = window length in minutes.

| Variable | Default | Protects |
|---|---|---|
| `SESSION_RATE_MAX` | `10` | Session creation per IP |
| `SESSION_RATE_WINDOW_MIN` | `15` | ↑ window |
| `SEARCH_RATE_MAX` | `20` | `/api/search` per IP |
| `SEARCH_RATE_WINDOW_MIN` | `10` | ↑ window |
| `TITLE_RATE_MAX` | `30` | `/api/title` per IP |
| `TITLE_RATE_WINDOW_MIN` | `1` | ↑ window |
| `QR_RATE_MAX` | `20` | `/api/qr` per IP |
| `QR_RATE_WINDOW_MIN` | `1` | ↑ window |
| `MAX_SESSION_REQUESTS` | `100` | Inbox cap per session (WS, silent drop) |
| `WS_REQ_RATE_MAX` | `10` | Request messages per WS client |
| `WS_REQ_RATE_WINDOW_MIN` | `1` | ↑ window (disconnects at 4029) |

---

## Auth (optional)

By default auth is disabled — suitable for a home LAN where you trust everyone on the network.

When `AUTH_TOKEN` is set in `.env`, the index page shows a password form before allowing access to the controller and player. The browser hashes the entered password with SHA-256 and sends only the hash to the server — the plaintext never leaves the browser. A successful login sets a 30-day `HttpOnly` cookie.

The `/request/` page is always public; the session ID in the URL is the audience's credential.

---

## Running behind a reverse proxy (nginx)

```nginx
location / {
    proxy_pass http://localhost:3444;
    proxy_http_version 1.1;

    # WebSocket upgrade
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";

    # Real IP forwarding (used for auth logging)
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Host $host;
}
```

Set `AUTH_TOKEN` in `.env` whenever the server is reachable from the internet.

---

## Running with PM2

`ecosystem.config.js` is gitignored so your PM2 config stays local. Create one:

```js
// ecosystem.config.js
module.exports = {
  apps: [{
    name: 'karaoke-browser',
    script: 'app.js',
    env: {
      NODE_ENV: 'production',
      PORT: 3444,
    },
  }],
};
```

```bash
npm install -g pm2
pm2 start ecosystem.config.js
pm2 save
pm2 startup   # auto-start on reboot
```

---

## Session lifecycle

- Sessions are created on demand from the index page.
- In **auth mode** there is one fixed session for the life of the server (keyed to the token hash). Restarting the server with the same `AUTH_TOKEN` resumes the same session.
- In **no-auth mode** each "Start Karaoke Night" click creates a fresh session with a new random ID.
- Sessions are stored in Redis with a TTL of `SESSION_TTL_HOURS` (default: 4 h). Idle sessions with no active WebSocket connections expire automatically when the TTL elapses.
- Queue, now-playing, and song requests all persist in Redis for the life of the session. A server restart does not wipe active sessions — Redis holds the state.
- Multiple server instances share the same session state. WebSocket state changes are broadcast to all instances via Redis pub/sub.

---

## Hardening for public deployments

The following protections are built in and all tunable via `.env`:

| Protection | Default | Env var(s) |
|---|---|---|
| Session creation rate limit | 10 per IP / 15 min | `SESSION_RATE_MAX`, `SESSION_RATE_WINDOW_MIN` |
| Global session cap | 500 sessions (HTTP 503) | `MAX_SESSIONS` |
| Song request inbox cap | 100 per session (silent drop) | `MAX_SESSION_REQUESTS` |
| WS request flood guard | 10 msg/min per client (disconnects 4029) | `WS_REQ_RATE_MAX`, `WS_REQ_RATE_WINDOW_MIN` |
| `/api/search` rate limit | 20 per IP / 10 min | `SEARCH_RATE_MAX`, `SEARCH_RATE_WINDOW_MIN` |
| `/api/title` rate limit | 30 per IP / min | `TITLE_RATE_MAX`, `TITLE_RATE_WINDOW_MIN` |
| `/api/qr` rate limit | 20 per IP / min | `QR_RATE_MAX`, `QR_RATE_WINDOW_MIN` |
| YouTube key rotation | Round-robin; auto-retire on 403 until midnight UTC | `YOUTUBE_API_KEYS` |
| Search result cache | Redis-backed, shared across all instances | `SEARCH_CACHE_TTL_MIN` |
| WS connection rate limit | 60 upgrades/IP/min (pre-handshake) | `WS_CONN_RATE_MAX`, `WS_CONN_RATE_WINDOW_MIN` |
| Search result cache | 60-minute TTL; cached hits cost zero API quota | `SEARCH_CACHE_TTL_MIN` |
| Session persistence | Save every 60 s + on SIGTERM/SIGINT; restore on restart | — |

All rate limiters are in-process `Map`s. If you run multiple Node.js instances behind a load balancer, replace them with a shared store (e.g. Redis + `express-rate-limit`'s Redis store).

---

## Logging

Log output goes to stdout. Set `LOG_LEVEL` in `.env`:

```
error   — failures only
warn    — auth failures, unknown sessions
info    — startup, logins, WS connect/disconnect, sessions  (default)
debug   — every WS message, search queries, QR generation, auth redirects
```

Output is ANSI-coloured when stdout is a TTY, plain text otherwise (suitable for PM2 log files).

---

## Project structure

```
app.js                   Main server — Express + WebSocket, auth, sessions, REST API
.env.example             Configuration template
web/
  index.html             Host entry page — login / session creation / share links
  controller/index.html  DJ queue manager
  player/index.html      YouTube player (venue screen)
  request/index.html     Audience song request form
  script/
    index.js             Entry page logic
    controller.js        Controller WebSocket client + queue/request rendering
    player.js            Player WebSocket client + YouTube IFrame API
    request.js           Request page WebSocket client + form logic
  style/
    index.css
    controller.css
    player.css
    request.css
```

---

## API reference

| Method | Path | Notes | Description |
|---|---|---|---|
| `GET` | `/api/auth-status` | Public | Returns `{ authRequired, authed }` |
| `POST` | `/api/login` | Public | Body: `{ hash }`. Sets 30-day auth cookie. |
| `POST` | `/api/logout` | Public | Expires auth cookie. |
| `POST` | `/api/session/create` | Rate-limited | Returns `{ sessionId }`. 10 req/IP/15 min by default. |
| `GET` | `/api/title?url=` | Rate-limited | Resolves a YouTube URL to a clean title. 30 req/IP/min. |
| `GET` | `/api/search?q=` | Rate-limited | YouTube search with key rotation + result cache. Returns `{ results }`. 20 req/IP/10 min. |
| `GET` | `/api/qr?data=` | Rate-limited | Generates a QR code PNG. Returns `{ dataUrl }`. 20 req/IP/min. |

WebSocket connects to `/?s=<sessionId>&role=<controller|player|request>`.
