import type { RequestMode } from './session.js';

// ── REST API shapes ────────────────────────────────────────────────────────

export interface AuthStatusResponse {
  authRequired: boolean;
  authed: boolean;
}

export interface LoginRequest {
  hash: string;
}
export interface LoginResponse {
  ok: boolean;
}

export interface CreateSessionResponse {
  sessionId: string;
  requestMode: RequestMode;
}

export interface GetSessionResponse {
  sessionId: string;
  requestMode: RequestMode;
}

export interface SetModeRequest {
  sessionId: string;
  mode: RequestMode;
}

export interface ResetSessionRequest {
  sessionId: string;
}

export interface OkResponse {
  ok: boolean;
}

export interface SearchResult {
  videoId: string;
  title: string;
  /** Thumbnail URL (key is `thumb` on the wire). */
  thumb: string;
  url: string;
  channel: string;
}

export interface SearchResponse {
  results: SearchResult[];
  error?: string;
  cached?: boolean;
}

export interface TitleResponse {
  title: string;
}

export interface PlaylistSearchResult {
  playlistId: string;
  title: string;
  thumbnail: string;
  channelTitle: string;
  videoCount: number;
}

export interface PlaylistSearchResponse {
  items: PlaylistSearchResult[];
  error?: string;
}

export interface PlaylistItem {
  videoId: string;
  title: string;
  thumbnail: string;
}

export interface PlaylistItemsResponse {
  items: PlaylistItem[];
  nextPageToken?: string | null;
}

export interface StandbyThemeResponse {
  standbyTitle: string;
  standbySubtitle: string;
  standbyColors: string[];
  standbyTitleColor: string;
  standbyTitleOutline: string;
  standbyTitleFont: string;
  standbyTitleSize: number;
  standbyTitleOutlineSize: number;
  standbySubtitleColor: string;
  standbySubtitleOutline: string;
  standbySubtitleFont: string;
  standbySubtitleSize: number;
  standbySubtitleOutlineSize: number;
}
