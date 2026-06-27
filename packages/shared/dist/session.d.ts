export interface QueueItem {
    id: number;
    videoId: string;
    title: string;
    singer: string;
    url: string;
    embedError?: boolean;
}
export interface SongRequest {
    id: number;
    name: string;
    artist: string;
    title: string;
    deviceToken: string;
}
/** SongRequest as broadcast to clients — deviceToken is stripped server-side. */
export type PublicSongRequest = Omit<SongRequest, 'deviceToken'>;
export interface StandbyTrack {
    videoId: string;
    title: string;
}
export type PlayerMode = 'karaoke' | 'standby';
export type RequestMode = 'kiosk' | 'crowd';
export interface SessionState {
    queue: QueueItem[];
    nowPlaying: QueueItem | null;
    paused: boolean;
    nextId: number;
    requests: SongRequest[];
    nextRequestId: number;
    requestMode: RequestMode;
    blockedDevices: string[];
    bannedDevices: string[];
    standbyPlaylistId: string | null;
    standbyPlaylistTitle: string | null;
    standbyPlaylistThumbnail: string | null;
    standbyTrack: StandbyTrack | null;
    standbyVolume: number;
    videoVolume: number;
    fadeDuration: number;
    micVolume: number;
    micMuted: boolean;
    standbyPaused: boolean;
    playerMode: PlayerMode;
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
    lastActivity: number;
}
//# sourceMappingURL=session.d.ts.map