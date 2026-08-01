export type SourceType = "video" | "live";

export interface RoomState {
  id: string;
  title: string;
  sourceUrl: string;
  sourceType: SourceType;
  playing: boolean;
  position: number;
  rate: number;
  updatedAt: number;
  createdAt: number;
  passwordRequired: boolean;
}

export interface RoomPreview {
  id: string;
  title: string;
  sourceType: SourceType;
  passwordRequired: boolean;
  onlineCount: number;
}

export interface Member {
  id: string;
  name: string;
  isHost: boolean;
}

export interface CreateRoomInput {
  title: string;
  sourceUrl: string;
  sourceType: SourceType;
  password?: string;
}

export interface CreateRoomResponse {
  room: RoomState;
  hostToken: string;
}

export type ServerMessage =
  | {
      type: "hello";
      room: RoomState;
      self: Member;
      members: Member[];
    }
  | { type: "members"; members: Member[] }
  | { type: "sync"; room: RoomState; action: "play" | "pause" | "seek" | "tick" | "rate" }
  | {
      type: "danmaku";
      id: string;
      name: string;
      text: string;
      color: string;
      mode: "right" | "top" | "bottom";
      size: "small" | "medium" | "big";
      sentAt: number;
    }
  | { type: "error"; code: string; message: string }
  | { type: "pong" };

export type ClientMessage =
  | { type: "join"; name: string; password?: string; hostToken?: string }
  | {
      type: "control";
      action: "play" | "pause" | "seek" | "tick" | "rate";
      position: number;
      playing: boolean;
      rate: number;
    }
  | {
      type: "danmaku";
      text: string;
      color: string;
      mode: "right" | "top" | "bottom";
      size: "small" | "medium" | "big";
    }
  | { type: "ping" };

declare global {
  interface HTMLVideoElement {
    webkitShowPlaybackTargetPicker?: () => void;
  }

  interface Window {
    Hls: typeof import("hls.js").default;
    __onGCastApiAvailable?: (isAvailable: boolean) => void;
    cast?: {
      framework: {
        CastContext: {
          getInstance: () => {
            setOptions: (options: Record<string, unknown>) => void;
            requestSession: () => Promise<void>;
            getCurrentSession: () => {
              loadMedia: (request: unknown) => Promise<unknown>;
            } | null;
          };
        };
      };
    };
    chrome?: {
      cast?: {
        AutoJoinPolicy: { ORIGIN_SCOPED: string };
        media: {
          DEFAULT_MEDIA_RECEIVER_APP_ID: string;
          MediaInfo: new (url: string, contentType: string) => {
            metadata: unknown;
            streamType: string;
          };
          GenericMediaMetadata: new () => { title: string; subtitle: string };
          LoadRequest: new (mediaInfo: unknown) => {
            autoplay: boolean;
            currentTime: number;
          };
          StreamType: { LIVE: string; BUFFERED: string };
        };
      };
    };
  }
}
