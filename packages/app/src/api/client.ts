import type {
  AuthStatusResponse,
  LoginRequest,
  LoginResponse,
  CreateSessionResponse,
  GetSessionResponse,
  OkResponse,
  SearchResponse,
  TitleResponse,
  PlaylistSearchResponse,
  PlaylistItemsResponse,
  StandbyThemeResponse,
} from '@karaoke-browser/shared';

const BASE = import.meta.env.VITE_API_URL ?? '';

async function get<T>(path: string): Promise<T> {
  const r = await fetch(BASE + path);
  if (!r.ok) throw new Error(`GET ${path} → ${r.status}`);
  return r.json() as Promise<T>;
}

async function post<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`POST ${path} → ${r.status}`);
  return r.json() as Promise<T>;
}

export const api = {
  getAuthStatus: () =>
    get<AuthStatusResponse>('/api/auth-status'),

  login: (hash: string) =>
    post<LoginResponse>('/api/login', { hash } satisfies LoginRequest),

  logout: () =>
    post<OkResponse>('/api/logout'),

  createSession: () =>
    post<CreateSessionResponse>('/api/session/create'),

  getSession: (s: string) =>
    get<GetSessionResponse>(`/api/session?s=${encodeURIComponent(s)}`),

  setSessionMode: (sessionId: string, mode: 'kiosk' | 'crowd') =>
    post<OkResponse>('/api/session/mode', { sessionId, mode }),

  resetSession: (sessionId: string) =>
    post<OkResponse>('/api/session/reset', { sessionId }),

  search: (q: string) =>
    get<SearchResponse>(`/api/search?q=${encodeURIComponent(q)}`),

  getTitle: (url: string) =>
    get<TitleResponse>(`/api/title?url=${encodeURIComponent(url)}`),

  getQr: (sessionId: string, data: string) =>
    get<{ dataUrl: string }>(`/api/qr?s=${encodeURIComponent(sessionId)}&data=${encodeURIComponent(data)}`),

  getStandbyTheme: (sessionId: string) =>
    get<StandbyThemeResponse>(`/api/standby-theme?s=${encodeURIComponent(sessionId)}`),

  mixerSearch: (q: string) =>
    get<PlaylistSearchResponse>(`/api/mixer/search?q=${encodeURIComponent(q)}`),

  mixerPlaylistItems: (sessionId: string, id: string) =>
    get<PlaylistItemsResponse>(`/api/mixer/playlist-items?s=${encodeURIComponent(sessionId)}&id=${encodeURIComponent(id)}`),
};
