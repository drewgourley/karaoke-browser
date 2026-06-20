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
- A **YouTube Data API v3 key** (free) for song search. URL-paste and the full queue work without one.

### Getting a YouTube API key

1. Go to [console.cloud.google.com](https://console.cloud.google.com/)
2. Create a project → **APIs & Services** → **Enable APIs**
3. Search for **YouTube Data API v3** and enable it
4. Go to **Credentials** → **Create credentials** → **API key**
5. (Recommended) Restrict the key to the YouTube Data API v3 and your server's IP

---

## Quick start

```bash
git clone <repo-url>
cd karaoke-browser
npm install
cp .env.example .env
# open .env and add your YOUTUBE_API_KEY
npm start
```

Open **http://localhost:3444** in your browser.

---

## Configuration

Copy `.env.example` to `.env` and edit as needed.

| Variable | Default | Description |
|---|---|---|
| `YOUTUBE_API_KEY` | — | YouTube Data API v3 key. Required for search. |
| `PORT` | `3444` | HTTP port the server listens on. |
| `AUTH_TOKEN` | _(disabled)_ | Password for the room. See [Auth](#auth-optional) below. |
| `LOG_LEVEL` | `info` | Log verbosity: `error` / `warn` / `info` / `debug`. |

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
- Sessions idle for more than **4 hours** with no active WebSocket connections are cleaned up automatically.
- Queue, now-playing, and song requests all persist in memory for the life of the session. Restarting the server clears them.

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

| Method | Path | Auth required | Description |
|---|---|---|---|
| `GET` | `/api/auth-status` | No | Returns `{ authRequired, authed }` |
| `POST` | `/api/login` | No | Body: `{ hash }`. Sets auth cookie. |
| `POST` | `/api/logout` | No | Expires auth cookie. |
| `POST` | `/api/session/create` | Yes (if auth enabled) | Returns `{ sessionId }` |
| `GET` | `/api/title?url=` | Yes | Resolves a YouTube URL to a clean title. |
| `GET` | `/api/search?q=` | Yes | YouTube search. Returns `{ results }`. |
| `GET` | `/api/qr?data=` | No | Returns `{ dataUrl }` (PNG data URL). |

WebSocket connects to `/?s=<sessionId>&role=<controller|player|request>`.
