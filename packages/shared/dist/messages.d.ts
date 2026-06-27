import type { QueueItem, PublicSongRequest, StandbyTrack, PlayerMode, RequestMode } from './session.js';
export type ClientMessage = {
    type: 'hello';
    deviceToken: string;
} | {
    type: 'add';
    url: string;
    title: string;
    singer: string;
} | {
    type: 'play-index';
    index: number;
} | {
    type: 'next';
} | {
    type: 'pause';
} | {
    type: 'resume';
} | {
    type: 'toggle-pause';
} | {
    type: 'restart';
} | {
    type: 'requeue';
} | {
    type: 'remove';
    index: number;
} | {
    type: 'reorder';
    from: number;
    to: number;
} | {
    type: 'video-ended';
} | {
    type: 'video-error';
    videoId: string;
} | {
    type: 'request';
    name: string;
    artist: string;
    title: string;
    deviceToken: string;
} | {
    type: 'dismiss-request';
    id: number;
} | {
    type: 'ban-device';
    id: number;
} | {
    type: 'clear-blocked-devices';
} | {
    type: 'reset-requester-presence';
} | {
    type: 'unban-all-devices';
} | {
    type: 'set-request-mode';
    mode: RequestMode;
} | {
    type: 'set-standby-playlist';
    url: string;
    title: string;
    thumbnail: string;
} | {
    type: 'clear-standby';
} | {
    type: 'standby-skip';
} | {
    type: 'standby-pause';
} | {
    type: 'standby-resume';
} | {
    type: 'standby-toggle-pause';
} | {
    type: 'standby-track';
    videoId: string;
    title?: string;
} | {
    type: 'set-mic-volume';
    volume: number;
} | {
    type: 'mic-mute';
    muted: boolean;
} | {
    type: 'set-standby-volume';
    volume: number;
} | {
    type: 'set-video-volume';
    volume: number;
} | {
    type: 'player-mode';
    mode: PlayerMode;
} | {
    type: 'set-player-mode';
    mode: PlayerMode;
} | {
    type: 'toggle-player-mode';
} | {
    type: 'player-ios';
    isIOS: boolean;
} | {
    type: 'set-standby-settings';
    title?: string;
    subtitle?: string;
    colors?: string[];
    titleColor?: string;
    titleOutline?: string;
    titleFont?: string;
    titleSize?: number;
    titleOutlineSize?: number;
    subtitleColor?: string;
    subtitleOutline?: string;
    subtitleFont?: string;
    subtitleSize?: number;
    subtitleOutlineSize?: number;
};
export type ServerMessage = StateMessage | DeviceStatusMessage | DeviceClearedMessage | DeviceBannedMessage | TransientMessage;
export interface StateMessage {
    type: 'state';
    queue: QueueItem[];
    nowPlaying: QueueItem | null;
    paused: boolean;
    playerConnected: boolean;
    controllerConnected: boolean;
    requesterCount: number;
    requests: PublicSongRequest[];
    requestMode: RequestMode;
    blockedCount: number;
    bannedCount: number;
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
    playerIsIOS: boolean;
}
export interface DeviceStatusMessage {
    type: 'device-status';
    mode: RequestMode;
    blocked: boolean;
    banned: boolean;
}
/** `token` matches the wire format used by the backend. */
export interface DeviceClearedMessage {
    type: 'device-cleared';
    token: string;
}
export interface DeviceBannedMessage {
    type: 'device-banned';
    token: string;
}
/** Transient messages that trigger an action without carrying full state. */
export type TransientMessage = {
    type: 'restart';
} | {
    type: 'standby-skip';
} | {
    type: 'standby-pause';
} | {
    type: 'standby-resume';
};
//# sourceMappingURL=messages.d.ts.map