import DPlayer from "dplayer";
import Hls from "hls.js";
import {
  ArrowLeft,
  Cast,
  Check,
  ChevronDown,
  Circle,
  CirclePlay,
  Copy,
  Crown,
  Expand,
  Link2,
  LoaderCircle,
  LockKeyhole,
  MessageCircle,
  MonitorUp,
  Radio,
  Send,
  Settings2,
  Share2,
  ShieldCheck,
  Smartphone,
  Sparkles,
  Users,
  Volume2,
  X,
} from "lucide-react";
import {
  CSSProperties,
  FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Wordmark } from "../App";
import { getRoomPreview, getRoomSocketUrl } from "../lib/api";
import { castWithGoogle, castWithNativePicker, prepareGoogleCast } from "../lib/cast";
import type {
  ClientMessage,
  Member,
  RoomPreview,
  RoomState,
  ServerMessage,
} from "../types";

interface RoomProps {
  roomId: string;
  onExit: () => void;
}

interface Identity {
  name: string;
  password: string;
  hostToken: string;
}

const danmakuColors = [
  "#ffffff",
  "#ffe066",
  "#ffb454",
  "#ff6b6b",
  "#ff8fb3",
  "#d58cff",
  "#8ca8ff",
  "#69d5ff",
  "#5ce1c5",
  "#7be495",
  "#b8e85b",
  "#d4d7dd",
];

type DanmakuMode = "right" | "top" | "bottom";

interface DanmakuPreferences {
  visible: boolean;
  displayArea: number;
  opacity: number;
  fontScale: number;
  speed: number;
}

const defaultDanmakuPreferences: DanmakuPreferences = {
  visible: true,
  displayArea: 70,
  opacity: 90,
  fontScale: 100,
  speed: 3,
};

const danmakuPreferenceKey = "tongying:danmaku-preferences:v1";
const progressSyncPreferenceKey = "tongying:guest-progress-sync:v1";

function loadDanmakuPreferences(): DanmakuPreferences {
  try {
    const saved = JSON.parse(localStorage.getItem(danmakuPreferenceKey) || "null") as Partial<DanmakuPreferences> | null;
    if (!saved) return defaultDanmakuPreferences;
    return {
      visible: saved.visible ?? true,
      displayArea: Math.min(100, Math.max(20, Number(saved.displayArea) || 70)),
      opacity: Math.min(100, Math.max(20, Number(saved.opacity) || 90)),
      fontScale: Math.min(150, Math.max(75, Number(saved.fontScale) || 100)),
      speed: Math.min(5, Math.max(1, Number(saved.speed) || 3)),
    };
  } catch {
    return defaultDanmakuPreferences;
  }
}

function danmakuSpeedDuration(speed: number) {
  return [12, 10, 8, 6, 4][Math.min(5, Math.max(1, speed)) - 1];
}

function danmakuSpeedLabel(speed: number) {
  return ["较慢", "慢", "适中", "快", "较快"][Math.min(5, Math.max(1, speed)) - 1];
}

type DanmakuEvent = Extract<ServerMessage, { type: "danmaku" }>;

interface ActiveDanmaku extends DanmakuEvent {
  lane: number;
}

function expectedPosition(room: RoomState) {
  if (room.sourceType === "live") return 0;
  const elapsed = room.playing ? ((Date.now() - room.updatedAt) / 1000) * room.rate : 0;
  return Math.max(0, room.position + elapsed);
}

function localizeRoomClock(room: RoomState): RoomState {
  // Worker 已把 position 推进到消息发送时刻；收到后换成本机时钟，避免两台设备系统时间不同而反复跳转。
  return { ...room, updatedAt: Date.now() };
}

function avatarColor(id: string) {
  const colors = ["#ff7859", "#6b8afd", "#12a879", "#9d72ef", "#dd9a17", "#e05a87"];
  const total = Array.from(id).reduce((sum, character) => sum + character.charCodeAt(0), 0);
  return colors[total % colors.length];
}

function firstCharacter(name: string) {
  return Array.from(name.trim())[0]?.toUpperCase() || "观";
}

function JoinGate({
  preview,
  roomId,
  error,
  onJoin,
  onExit,
}: {
  preview: RoomPreview;
  roomId: string;
  error: string;
  onJoin: (identity: Identity) => void;
  onExit: () => void;
}) {
  const [name, setName] = useState(() => localStorage.getItem("tongying:nickname") || "");
  const [password, setPassword] = useState("");

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    const cleanName = name.trim().slice(0, 16);
    localStorage.setItem("tongying:nickname", cleanName);
    onJoin({
      name: cleanName,
      password,
      hostToken: localStorage.getItem(`tongying:host:${roomId}`) || "",
    });
  }

  return (
    <main className="join-page">
      <div className="join-noise" />
      <header className="join-header page-width">
        <Wordmark inverse />
        <button className="ghost-button dark" onClick={onExit}>
          <ArrowLeft size={16} /> 返回首页
        </button>
      </header>
      <section className="join-card">
        <div className="join-ticket-top">
          <span>ROOM {roomId}</span>
          <span>{preview.sourceType === "live" ? "LIVE" : "SCREENING"}</span>
        </div>
        <div className="join-icon">
          {preview.sourceType === "live" ? <Radio size={30} /> : <Circle size={30} fill="currentColor" />}
        </div>
        <p className="join-kicker">你收到了一张放映票</p>
        <h1>{preview.title}</h1>
        <div className="join-meta">
          <span><Users size={15} /> {preview.onlineCount} 人在线</span>
          <span>
            {preview.passwordRequired ? <LockKeyhole size={15} /> : <ShieldCheck size={15} />}
            {preview.passwordRequired ? "需要密码" : "公开房间"}
          </span>
        </div>
        <form onSubmit={submit}>
          <label className="field field-dark">
            <span>怎么称呼你？</span>
            <input
              autoFocus
              type="text"
              maxLength={16}
              placeholder="输入昵称"
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
            />
          </label>
          {preview.passwordRequired && (
            <label className="field field-dark">
              <span>房间密码</span>
              <input
                type="password"
                maxLength={64}
                autoComplete="current-password"
                placeholder="向房主询问密码"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
              />
            </label>
          )}
          {error && <p className="join-error" role="alert">{error}</p>}
          <button className="join-button" type="submit">
            入场 <ArrowLeft size={18} className="join-arrow" />
          </button>
        </form>
        <p className="join-fineprint">入场后，你的播放进度会自动跟随房主</p>
      </section>
    </main>
  );
}

function ShareDialog({ room, onClose }: { room: RoomState; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const shareUrl = `${window.location.origin}/room/${room.id}`;
  const nativeShare = (navigator as unknown as {
    share?: (data: ShareData) => Promise<void>;
  }).share;

  async function copyLink() {
    await navigator.clipboard.writeText(shareUrl);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  async function systemShare() {
    if (nativeShare) {
      await nativeShare.call(navigator, {
        title: `${room.title} · 同映放映室`,
        text: `来同映一起看「${room.title}」`,
        url: shareUrl,
      });
      return;
    }
    await copyLink();
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <div className="modal-card share-dialog" role="dialog" aria-modal="true" aria-labelledby="share-title" onMouseDown={(event) => event.stopPropagation()}>
        <button className="modal-close" onClick={onClose} aria-label="关闭邀请窗口"><X size={18} /></button>
        <div className="modal-icon"><Link2 size={24} /></div>
        <p className="modal-kicker">INVITE FRIENDS</p>
        <h2 id="share-title">把朋友请进来</h2>
        <p>分享链接即可加入。房主身份只保存在你的浏览器里，不会随链接分享。</p>
        <div className="share-link">
          <span>{shareUrl}</span>
          <button onClick={copyLink} aria-label="复制房间链接">
            {copied ? <Check size={17} /> : <Copy size={17} />}
          </button>
        </div>
        <div className="share-room-code">
          <span>房间号</span>
          <strong>{room.id}</strong>
        </div>
        {room.passwordRequired && (
          <p className="password-reminder"><LockKeyhole size={15} /> 记得单独告诉朋友房间密码</p>
        )}
        <button className="primary-button" onClick={systemShare}>
          <Share2 size={17} /> {nativeShare ? "打开分享菜单" : "复制邀请链接"}
        </button>
      </div>
    </div>
  );
}

function CastMenu({
  getPlayer,
  room,
  onClose,
  onMessage,
}: {
  getPlayer: () => DPlayer | null;
  room: RoomState;
  onClose: () => void;
  onMessage: (message: string) => void;
}) {
  async function run(action: () => Promise<void>, success: string) {
    const player = getPlayer();
    if (!player) return;
    try {
      await action();
      onMessage(success);
      onClose();
    } catch (caught) {
      onMessage(caught instanceof Error ? caught.message : "投屏连接失败");
    }
  }

  return (
    <div className="cast-popover">
      <div className="cast-popover-heading">
        <span>投到大屏</span>
        <button onClick={onClose} aria-label="关闭投屏菜单"><X size={15} /></button>
      </div>
      <button onClick={() => run(() => castWithNativePicker(getPlayer()!.video), "已打开系统投屏设备列表") }>
        <span className="cast-device-icon"><MonitorUp size={19} /></span>
        <span><strong>系统无线播放</strong><small>AirPlay / 浏览器设备</small></span>
      </button>
      <button onClick={() => run(() => castWithGoogle(getPlayer()!.video, room.title, room.sourceUrl, room.sourceType === "live"), "已连接 Chromecast") }>
        <span className="cast-device-icon"><Cast size={19} /></span>
        <span><strong>Chromecast</strong><small>投到 Google Cast 设备</small></span>
      </button>
      <p><Smartphone size={13} /> 手机和电视需在同一网络</p>
    </div>
  );
}

function RoomExperience({
  roomId,
  identity,
  onExit,
  onIdentityError,
}: {
  roomId: string;
  identity: Identity;
  onExit: () => void;
  onIdentityError: (message: string) => void;
}) {
  const playerContainerRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<DPlayer | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const roomRef = useRef<RoomState | null>(null);
  const applyStateRef = useRef<((room: RoomState, action?: string) => void) | null>(null);
  const applyingRemoteUntilRef = useRef(0);
  const danmakuLaneRef = useRef(0);
  const progressSyncEnabledRef = useRef(localStorage.getItem(progressSyncPreferenceKey) === "1");
  const [room, setRoom] = useState<RoomState | null>(null);
  const [self, setSelf] = useState<Member | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [connection, setConnection] = useState<"connecting" | "online" | "reconnecting">("connecting");
  const [shareOpen, setShareOpen] = useState(false);
  const [castOpen, setCastOpen] = useState(false);
  const [toast, setToast] = useState("");
  const [needsGesture, setNeedsGesture] = useState(false);
  const [danmakuText, setDanmakuText] = useState("");
  const [danmakuColor, setDanmakuColor] = useState(danmakuColors[0]);
  const [danmakuMode, setDanmakuMode] = useState<DanmakuMode>("right");
  const [danmakuSettingsOpen, setDanmakuSettingsOpen] = useState(false);
  const [danmakuPreferences, setDanmakuPreferences] = useState(loadDanmakuPreferences);
  const danmakuPreferencesRef = useRef(danmakuPreferences);
  const [danmakuFeed, setDanmakuFeed] = useState<DanmakuEvent[]>([]);
  const [activeDanmaku, setActiveDanmaku] = useState<ActiveDanmaku[]>([]);
  const [mediaAspect, setMediaAspect] = useState(16 / 9);
  const [progressSyncEnabled, setProgressSyncEnabled] = useState(
    () => localStorage.getItem(progressSyncPreferenceKey) === "1",
  );

  const send = useCallback((message: ClientMessage) => {
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify(message));
    }
  }, []);

  const sendControl = useCallback((action: "play" | "pause" | "seek" | "tick" | "rate", player: DPlayer) => {
    send({
      type: "control",
      action,
      position: player.video.currentTime || 0,
      playing: !player.video.paused,
      rate: player.video.playbackRate || 1,
    });
  }, [send]);

  const getPlayer = useCallback(() => playerRef.current, []);
  const playerRoomId = room?.id ?? "";
  const playerSourceType = room?.sourceType ?? "video";
  const playerSourceUrl = room?.sourceUrl ?? "";

  useEffect(() => {
    danmakuPreferencesRef.current = danmakuPreferences;
    localStorage.setItem(danmakuPreferenceKey, JSON.stringify(danmakuPreferences));
  }, [danmakuPreferences]);

  useEffect(() => {
    let disposed = false;
    let reconnectTimer = 0;
    let heartbeatTimer = 0;
    let attempts = 0;
    let joinedOnce = false;

    const connect = () => {
      if (disposed) return;
      setConnection(attempts ? "reconnecting" : "connecting");
      const socket = new WebSocket(getRoomSocketUrl(roomId));
      socketRef.current = socket;

      socket.addEventListener("open", () => {
        if (disposed) return;
        socket.send(JSON.stringify({
          type: "join",
          name: identity.name,
          password: identity.password,
          hostToken: identity.hostToken,
        } satisfies ClientMessage));
        window.clearInterval(heartbeatTimer);
        heartbeatTimer = window.setInterval(() => send({ type: "ping" }), 25_000);
      });

      socket.addEventListener("message", (event) => {
        const message = JSON.parse(event.data as string) as ServerMessage;
        if (message.type === "hello") {
          const localizedRoom = localizeRoomClock(message.room);
          joinedOnce = true;
          attempts = 0;
          roomRef.current = localizedRoom;
          setRoom(localizedRoom);
          setSelf(message.self);
          setMembers(message.members);
          setConnection("online");
          sessionStorage.setItem(`tongying:joined:${roomId}`, "1");
          applyStateRef.current?.(localizedRoom, "hello");
          return;
        }
        if (message.type === "members") {
          setMembers(message.members);
          return;
        }
        if (message.type === "sync") {
          const localizedRoom = localizeRoomClock(message.room);
          roomRef.current = localizedRoom;
          setRoom(localizedRoom);
          applyStateRef.current?.(localizedRoom, message.action);
          return;
        }
        if (message.type === "danmaku") {
          const preferences = danmakuPreferencesRef.current;
          const laneCount = Math.max(2, Math.round(preferences.displayArea / 12.5));
          const lane = danmakuLaneRef.current % laneCount;
          danmakuLaneRef.current += 1;
          setDanmakuFeed((current) => [message, ...current].slice(0, 50));
          if (preferences.visible) {
            setActiveDanmaku((current) => [...current.slice(-23), { ...message, lane }]);
          }
          return;
        }
        if (message.type === "error") {
          if (message.code === "BAD_PASSWORD") {
            onIdentityError(message.message);
          } else {
            setToast(message.message);
          }
        }
      });

      socket.addEventListener("close", (event) => {
        window.clearInterval(heartbeatTimer);
        if (disposed) return;
        if (!joinedOnce && event.code === 1008) return;
        attempts += 1;
        setConnection("reconnecting");
        reconnectTimer = window.setTimeout(connect, Math.min(1000 * attempts, 5000));
      });
    };

    connect();
    return () => {
      disposed = true;
      window.clearTimeout(reconnectTimer);
      window.clearInterval(heartbeatTimer);
      socketRef.current?.close(1000, "离开房间");
      socketRef.current = null;
    };
  }, [identity, onIdentityError, roomId, send]);

  useEffect(() => {
    if (!playerRoomId || !self || !playerContainerRef.current) return;
    window.Hls = Hls;

    const isHlsSource = /\.m3u8(?:$|[?#])/i.test(playerSourceUrl);
    let hlsInstance: Hls | null = null;

    const player = new DPlayer({
      container: playerContainerRef.current,
      live: playerSourceType === "live",
      autoplay: false,
      theme: "#ff6b4a",
      lang: "zh-cn",
      hotkey: self.isHost,
      airplay: true,
      pictureInPicture: true,
      preload: "auto",
      video: {
        url: playerSourceUrl,
        type: isHlsSource ? "tongying-hls" : "auto",
        customType: isHlsSource ? {
          "tongying-hls": (video) => {
            const nativeHls = video.canPlayType("application/vnd.apple.mpegurl")
              || video.canPlayType("application/x-mpegURL");
            if (nativeHls) {
              // Safari 的原生视频管线能更完整地保留 HDR / Dolby Vision 元数据。
              video.src = playerSourceUrl;
              return;
            }
            if (Hls.isSupported()) {
              hlsInstance = new Hls({
                enableWorker: true,
                lowLatencyMode: playerSourceType === "live",
                backBufferLength: 90,
              });
              hlsInstance.loadSource(playerSourceUrl);
              hlsInstance.attachMedia(video);
              return;
            }
            video.src = playerSourceUrl;
          },
        } : undefined,
      },
      contextmenu: [
        { text: "同映 · 一起看", link: window.location.origin },
        { text: "DPlayer", link: "https://github.com/tsukumijima/DPlayer" },
      ],
    });
    playerRef.current = player;
    let lastTickAt = 0;
    let correctionTimer = 0;

    const markRemoteChange = (duration = 1000) => {
      applyingRemoteUntilRef.current = performance.now() + duration;
    };

    const restorePlaybackRate = (rate: number) => {
      window.clearTimeout(correctionTimer);
      if (Math.abs(player.video.playbackRate - rate) > 0.005) {
        markRemoteChange(600);
        player.video.playbackRate = rate;
      }
    };

    const applyRoomState = (nextRoom: RoomState, action = "sync") => {
      const position = expectedPosition(nextRoom);
      const shouldSyncProgress = self.isHost
        || progressSyncEnabledRef.current
        || action === "hello"
        || action === "guard"
        || action === "manual";

      if (nextRoom.sourceType !== "live" && shouldSyncProgress) {
        const drift = position - (player.video.currentTime || 0);
        const absoluteDrift = Math.abs(drift);

        if (action === "tick") {
          if (absoluteDrift > 5) {
            restorePlaybackRate(nextRoom.rate);
            markRemoteChange(1200);
            player.seek(position, true);
          } else if (nextRoom.playing && absoluteDrift > 0.45) {
            window.clearTimeout(correctionTimer);
            const correction = Math.max(
              Math.max(0.25, nextRoom.rate * 0.97),
              Math.min(Math.min(2, nextRoom.rate * 1.03), nextRoom.rate + drift * 0.015),
            );
            markRemoteChange(700);
            player.video.playbackRate = correction;
            correctionTimer = window.setTimeout(() => restorePlaybackRate(nextRoom.rate), 4000);
          } else {
            restorePlaybackRate(nextRoom.rate);
          }
        } else {
          restorePlaybackRate(nextRoom.rate);
          const seekThreshold = action === "hello" || action === "seek" || action === "manual" ? 0.35 : 1.5;
          if (absoluteDrift > seekThreshold) {
            markRemoteChange(1200);
            player.seek(position, true);
          }
        }

        if (action !== "tick" && Math.abs(player.video.playbackRate - nextRoom.rate) > 0.01) {
          markRemoteChange(600);
          player.video.playbackRate = nextRoom.rate;
        }
      }

      if (nextRoom.playing && player.video.paused) {
        markRemoteChange(1000);
        player.play();
        window.setTimeout(() => {
          if (player.video.paused && roomRef.current?.playing) setNeedsGesture(true);
        }, 350);
      } else if (!nextRoom.playing && !player.video.paused) {
        markRemoteChange(1000);
        player.pause();
        setNeedsGesture(false);
      } else if (!nextRoom.playing) {
        setNeedsGesture(false);
      }
    };
    applyStateRef.current = applyRoomState;

    const updateMediaAspect = () => {
      if (!player.video.videoWidth || !player.video.videoHeight) return;
      const aspect = player.video.videoWidth / player.video.videoHeight;
      if (Number.isFinite(aspect) && aspect >= 0.5 && aspect <= 3) {
        setMediaAspect(aspect);
        window.requestAnimationFrame(() => player.resize());
      }
    };

    const isRemoteChange = () => performance.now() < applyingRemoteUntilRef.current;
    const returnGuestToRoomState = () => {
      if (!self.isHost && roomRef.current && !isRemoteChange()) {
        applyRoomState(roomRef.current, "guard");
        setToast("播放由房主统一控制");
      }
    };

    player.on("loadedmetadata", () => {
      updateMediaAspect();
      if (roomRef.current) applyRoomState(roomRef.current, "hello");
    });
    player.on("canplay", updateMediaAspect);
    player.on("play", () => {
      if (isRemoteChange()) return;
      if (self.isHost) sendControl("play", player);
      else returnGuestToRoomState();
    });
    player.on("pause", () => {
      if (isRemoteChange()) return;
      if (self.isHost) sendControl("pause", player);
      else returnGuestToRoomState();
    });
    player.on("seeked", () => {
      if (isRemoteChange()) return;
      if (self.isHost) sendControl("seek", player);
      else returnGuestToRoomState();
    });
    player.on("ratechange", () => {
      if (isRemoteChange()) return;
      if (self.isHost) sendControl("rate", player);
      else returnGuestToRoomState();
    });
    player.on("timeupdate", () => {
      if (!self.isHost || isRemoteChange() || player.video.paused) return;
      if (performance.now() - lastTickAt > 15_000) {
        lastTickAt = performance.now();
        sendControl("tick", player);
      }
    });

    prepareGoogleCast().catch(() => undefined);
    if (roomRef.current) applyRoomState(roomRef.current, "hello");

    return () => {
      window.clearTimeout(correctionTimer);
      hlsInstance?.destroy();
      applyStateRef.current = null;
      playerRef.current = null;
      player.destroy();
    };
  }, [identity.name, playerRoomId, playerSourceType, playerSourceUrl, self, sendControl]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 2600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const sortedMembers = useMemo(
    () => [...members].sort((left, right) => Number(right.isHost) - Number(left.isHost)),
    [members],
  );

  const danmakuLaneCount = Math.max(2, Math.round(danmakuPreferences.displayArea / 12.5));
  const danmakuDuration = danmakuSpeedDuration(danmakuPreferences.speed);

  function updateDanmakuPreference<Key extends keyof DanmakuPreferences>(
    key: Key,
    value: DanmakuPreferences[Key],
  ) {
    setDanmakuPreferences((current) => ({ ...current, [key]: value }));
  }

  function submitDanmaku(event: FormEvent) {
    event.preventDefault();
    const text = danmakuText.trim();
    if (!text) return;
    send({
      type: "danmaku",
      text,
      color: danmakuColor,
      mode: danmakuMode,
      size: "medium",
    });
    setDanmakuText("");
  }

  function unlockPlayback() {
    const player = playerRef.current;
    if (!player) return;
    if (roomRef.current?.playing) {
      player.play();
      setNeedsGesture(false);
    } else {
      setToast("正在等待房主开始播放");
    }
  }

  function toggleProgressSync() {
    const enabled = !progressSyncEnabledRef.current;
    progressSyncEnabledRef.current = enabled;
    setProgressSyncEnabled(enabled);
    localStorage.setItem(progressSyncPreferenceKey, enabled ? "1" : "0");
    if (enabled && roomRef.current) {
      applyStateRef.current?.(roomRef.current, "manual");
      setToast("已追上房主当前进度");
    } else {
      setToast("已关闭持续进度跟随");
    }
  }

  function enterMobileFullscreen() {
    const player = playerRef.current;
    if (!player) return;
    const video = player.video as HTMLVideoElement & {
      webkitEnterFullscreen?: () => void;
    };
    const isAppleTouchDevice = /iPad|iPhone|iPod/.test(navigator.userAgent)
      || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

    try {
      if (isAppleTouchDevice && video.webkitEnterFullscreen) {
        video.webkitEnterFullscreen();
        return;
      }
      player.fullScreen.request("browser");
    } catch {
      try {
        player.fullScreen.request("web");
      } catch {
        setToast("当前浏览器不支持全屏播放");
      }
    }
  }

  if (!room || !self) {
    return (
      <main className="room-loading">
        <Wordmark inverse />
        <LoaderCircle className="spin" size={28} />
        <p>{connection === "reconnecting" ? "正在重新连回放映室…" : "正在为你开门…"}</p>
      </main>
    );
  }

  return (
    <main className="room-page">
      <header className="room-header">
        <div className="room-header-left">
          <Wordmark inverse />
          <span className="header-divider" />
          <div className="header-room-title">
            <span>{room.sourceType === "live" ? "正在直播" : "正在放映"}</span>
            <strong>{room.title}</strong>
          </div>
        </div>
        <div className="room-actions">
          <span className={`connection-pill ${connection}`}>
            <i /> {connection === "online" ? `${members.length} 人在线` : "重新连接中"}
          </span>
          <div className="cast-anchor">
            <button className="room-action-button" onClick={() => setCastOpen((open) => !open)}>
              <Cast size={17} /> <span>投屏</span>
            </button>
            {castOpen && (
              <CastMenu
                getPlayer={getPlayer}
                room={room}
                onClose={() => setCastOpen(false)}
                onMessage={setToast}
              />
            )}
          </div>
          <button className="room-action-button accent" onClick={() => setShareOpen(true)}>
            <Share2 size={17} /> <span>邀请朋友</span>
          </button>
          <button className="exit-button" onClick={onExit} aria-label="离开放映室"><X size={18} /></button>
        </div>
      </header>

      <div className="room-layout">
        <section className="screening-column">
          <div className={`player-frame ${self.isHost ? "is-host" : "is-guest"}`}>
            <div className="player-topline">
              <span className={room.sourceType === "live" ? "live" : ""}>
                {room.sourceType === "live" ? <><i /> LIVE</> : "FEATURE PRESENTATION"}
              </span>
              <div className="player-topline-actions">
                <span>{self.isHost ? <><Crown size={13} /> 房主控场</> : <><ShieldCheck size={13} /> 播放跟随</>}</span>
                <button type="button" className="mobile-fullscreen-button" onClick={enterMobileFullscreen}>
                  <Expand size={13} /> 全屏
                </button>
              </div>
            </div>
            <div
              ref={playerContainerRef}
              className="player-mount"
              style={{ aspectRatio: `${mediaAspect}` }}
            />
            <div
              className={`realtime-danmaku-layer ${danmakuPreferences.visible ? "" : "is-hidden"}`}
              aria-live="polite"
              style={{
                height: `${danmakuPreferences.displayArea}%`,
                opacity: danmakuPreferences.opacity / 100,
              }}
            >
              {activeDanmaku.map((item) => (
                <span
                  key={item.id}
                  className={`realtime-danmaku-item mode-${item.mode} size-${item.size}`}
                  style={{
                    color: item.color,
                    top: item.mode === "right"
                      ? `${4 + (item.lane % danmakuLaneCount) * (88 / danmakuLaneCount)}%`
                      : `${7 + (item.lane % Math.min(3, danmakuLaneCount)) * 18}%`,
                    fontSize: item.size === "small"
                      ? `clamp(${Math.round(14 * danmakuPreferences.fontScale / 100)}px, ${1.25 * danmakuPreferences.fontScale / 100}vw, ${Math.round(21 * danmakuPreferences.fontScale / 100)}px)`
                      : item.size === "big"
                        ? `clamp(${Math.round(20 * danmakuPreferences.fontScale / 100)}px, ${1.9 * danmakuPreferences.fontScale / 100}vw, ${Math.round(32 * danmakuPreferences.fontScale / 100)}px)`
                        : `clamp(${Math.round(17 * danmakuPreferences.fontScale / 100)}px, ${1.55 * danmakuPreferences.fontScale / 100}vw, ${Math.round(27 * danmakuPreferences.fontScale / 100)}px)`,
                    animationDuration: `${item.mode === "right" ? danmakuDuration : Math.max(3, danmakuDuration * 0.625)}s`,
                  } satisfies CSSProperties}
                  onAnimationEnd={() => setActiveDanmaku((current) => current.filter((entry) => entry.id !== item.id))}
                >
                  {item.text}
                </span>
              ))}
            </div>
            {!self.isHost && (
              <button className={`guest-lock-layer ${needsGesture ? "needs-gesture" : ""}`} onClick={unlockPlayback}>
                {needsGesture && <span><CirclePlay size={22} /> 点击开始同步播放</span>}
              </button>
            )}
            <span className="frame-corner corner-one" />
            <span className="frame-corner corner-two" />
            <span className="frame-corner corner-three" />
            <span className="frame-corner corner-four" />
          </div>

          <form className="danmaku-composer" onSubmit={submitDanmaku}>
            {danmakuSettingsOpen && (
              <section className="danmaku-settings-panel" aria-label="弹幕显示设置">
                <div className="danmaku-settings-heading">
                  <div>
                    <Settings2 size={17} />
                    <strong>弹幕设置</strong>
                  </div>
                  <button type="button" onClick={() => setDanmakuSettingsOpen(false)} aria-label="关闭弹幕设置">
                    <X size={16} />
                  </button>
                </div>

                <div className="danmaku-visibility-row">
                  <div>
                    <strong>显示弹幕</strong>
                    <span>关闭后仍可在右侧查看实时列表</span>
                  </div>
                  <button
                    type="button"
                    className={`setting-switch ${danmakuPreferences.visible ? "active" : ""}`}
                    role="switch"
                    aria-checked={danmakuPreferences.visible}
                    onClick={() => updateDanmakuPreference("visible", !danmakuPreferences.visible)}
                  >
                    <i />
                  </button>
                </div>

                <div className="danmaku-mode-setting">
                  <span>发送样式</span>
                  <div>
                    {([
                      ["right", "滚动"],
                      ["top", "顶部"],
                      ["bottom", "底部"],
                    ] as const).map(([mode, label]) => (
                      <button
                        type="button"
                        key={mode}
                        className={danmakuMode === mode ? "active" : ""}
                        onClick={() => setDanmakuMode(mode)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="danmaku-setting-sliders">
                  <label>
                    <span>显示区域</span>
                    <input
                      type="range"
                      min="20"
                      max="100"
                      step="10"
                      value={danmakuPreferences.displayArea}
                      onChange={(event) => updateDanmakuPreference("displayArea", Number(event.target.value))}
                      style={{ "--range-progress": `${(danmakuPreferences.displayArea - 20) / 80 * 100}%` } as CSSProperties}
                    />
                    <output>{danmakuPreferences.displayArea}%</output>
                  </label>
                  <label>
                    <span>不透明度</span>
                    <input
                      type="range"
                      min="20"
                      max="100"
                      step="5"
                      value={danmakuPreferences.opacity}
                      onChange={(event) => updateDanmakuPreference("opacity", Number(event.target.value))}
                      style={{ "--range-progress": `${(danmakuPreferences.opacity - 20) / 80 * 100}%` } as CSSProperties}
                    />
                    <output>{danmakuPreferences.opacity}%</output>
                  </label>
                  <label>
                    <span>弹幕字号</span>
                    <input
                      type="range"
                      min="75"
                      max="150"
                      step="5"
                      value={danmakuPreferences.fontScale}
                      onChange={(event) => updateDanmakuPreference("fontScale", Number(event.target.value))}
                      style={{ "--range-progress": `${(danmakuPreferences.fontScale - 75) / 75 * 100}%` } as CSSProperties}
                    />
                    <output>{danmakuPreferences.fontScale}%</output>
                  </label>
                  <label>
                    <span>弹幕速度</span>
                    <input
                      type="range"
                      min="1"
                      max="5"
                      step="1"
                      value={danmakuPreferences.speed}
                      onChange={(event) => updateDanmakuPreference("speed", Number(event.target.value))}
                      style={{ "--range-progress": `${(danmakuPreferences.speed - 1) / 4 * 100}%` } as CSSProperties}
                    />
                    <output>{danmakuSpeedLabel(danmakuPreferences.speed)}</output>
                  </label>
                </div>

                <div className="danmaku-color-setting">
                  <span>弹幕颜色</span>
                  <div>
                    {danmakuColors.map((color) => (
                      <button
                        type="button"
                        key={color}
                        aria-label={`选择颜色 ${color}`}
                        className={color === danmakuColor ? "selected" : ""}
                        style={{ backgroundColor: color }}
                        onClick={() => setDanmakuColor(color)}
                      >
                        {color === danmakuColor && <Check size={11} />}
                      </button>
                    ))}
                  </div>
                </div>

                <button
                  type="button"
                  className="danmaku-settings-reset"
                  onClick={() => setDanmakuPreferences(defaultDanmakuPreferences)}
                >
                  恢复默认显示设置
                </button>
              </section>
            )}
            <div className="danmaku-label">
              <MessageCircle size={17} />
              <span>发条弹幕</span>
            </div>
            <input
              type="text"
              maxLength={80}
              placeholder="这一刻，你想说点什么？"
              value={danmakuText}
              onChange={(event) => setDanmakuText(event.target.value)}
            />
            <div className="danmaku-tools">
              <div className="color-picker">
                <button type="button" style={{ backgroundColor: danmakuColor }} aria-label="选择弹幕颜色" />
                <div className="color-options">
                  {danmakuColors.map((color) => (
                    <button
                      type="button"
                      key={color}
                      aria-label={`选择颜色 ${color}`}
                      className={color === danmakuColor ? "selected" : ""}
                      style={{ backgroundColor: color }}
                      onClick={() => setDanmakuColor(color)}
                    />
                  ))}
                </div>
              </div>
              <button
                type="button"
                className="mode-button"
                onClick={() => setDanmakuMode((mode) => mode === "right" ? "top" : mode === "top" ? "bottom" : "right")}
              >
                {danmakuMode === "right" ? "滚动" : danmakuMode === "top" ? "顶部" : "底部"} <ChevronDown size={13} />
              </button>
              <button
                type="button"
                className={`danmaku-settings-button ${danmakuSettingsOpen ? "active" : ""}`}
                aria-label="打开弹幕设置"
                aria-expanded={danmakuSettingsOpen}
                onClick={() => setDanmakuSettingsOpen((open) => !open)}
              >
                <Settings2 size={16} />
              </button>
              <button className="danmaku-send" type="submit" disabled={!danmakuText.trim()}>
                <Send size={16} /> <span>发送</span>
              </button>
            </div>
          </form>

          {!self.isHost && (
            <div className="guest-sync-control">
              <div>
                <ShieldCheck size={15} />
                <span>
                  <strong>持续进度跟随</strong>
                  <small>{progressSyncEnabled ? "正在持续对齐房主进度" : "已关闭；仅进入或刷新时对齐一次"}</small>
                </span>
              </div>
              <button
                type="button"
                className={`setting-switch ${progressSyncEnabled ? "active" : ""}`}
                role="switch"
                aria-checked={progressSyncEnabled}
                aria-label="持续跟随房主进度"
                onClick={toggleProgressSync}
              >
                <i />
              </button>
            </div>
          )}
        </section>

        <aside className="room-sidebar">
          <section className="now-playing-card">
            <div className="section-label">
              <span>NOW SHOWING</span>
              <span>{room.sourceType === "live" ? "直播" : "影片"}</span>
            </div>
            <h1>{room.title}</h1>
            <div className="room-code-line">
              <span>ROOM</span>
              <strong>{room.id}</strong>
              <button onClick={() => navigator.clipboard.writeText(room.id)} aria-label="复制房间号"><Copy size={14} /></button>
            </div>
            <div className="host-control-note">
              {self.isHost ? <Crown size={17} /> : <ShieldCheck size={17} />}
              <div>
                <strong>{self.isHost ? "你是房主" : "房主正在控场"}</strong>
                <span>{self.isHost ? "播放、暂停和快进会同步给所有人" : "普通观众无法暂停或快进"}</span>
              </div>
            </div>
          </section>

          <section className="audience-card">
            <div className="audience-heading">
              <div><Users size={17} /><strong>放映厅</strong></div>
              <span>{members.length} / 在线</span>
            </div>
            <div className="member-list">
              {sortedMembers.map((member) => (
                <div className="member-row" key={member.id}>
                  <span className="member-avatar" style={{ backgroundColor: avatarColor(member.id) }}>
                    {firstCharacter(member.name)}
                    <i />
                  </span>
                  <div>
                    <strong>{member.name}{member.id === self.id ? "（你）" : ""}</strong>
                    <span>{member.isHost ? "房主" : "观众"}</span>
                  </div>
                  {member.isHost && <Crown size={15} className="member-crown" />}
                </div>
              ))}
            </div>
          </section>

          <section className="danmaku-feed-card">
            <div className="danmaku-feed-heading">
              <div><MessageCircle size={17} /><strong>实时弹幕</strong></div>
              <span>仅本场在线可见</span>
            </div>
            <div className="danmaku-feed-list">
              {danmakuFeed.length ? danmakuFeed.map((item) => (
                <div className="danmaku-feed-row" key={item.id}>
                  <span className="danmaku-feed-avatar" style={{ backgroundColor: item.color }}>
                    {firstCharacter(item.name)}
                  </span>
                  <div>
                    <span><strong>{item.name}</strong><time>{new Date(item.sentAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</time></span>
                    <p>{item.text}</p>
                  </div>
                </div>
              )) : (
                <div className="danmaku-feed-empty">
                  <MessageCircle size={20} />
                  <span>还没有弹幕，来发第一条吧</span>
                </div>
              )}
            </div>
          </section>

          <section className="privacy-card">
            <Sparkles size={17} />
            <div>
              <strong>弹幕，散场即散</strong>
              <span>所有弹幕只在在线用户间实时转发，服务端不会保存。</span>
            </div>
          </section>

          <div className="player-shortcuts">
            <span><Volume2 size={14} /> 音量</span>
            <span><Expand size={14} /> 全屏</span>
            <span><Cast size={14} /> 投屏</span>
          </div>
        </aside>
      </div>

      {shareOpen && <ShareDialog room={room} onClose={() => setShareOpen(false)} />}
      {toast && <div className="toast" role="status">{toast}</div>}
    </main>
  );
}

export default function Room({ roomId, onExit }: RoomProps) {
  const [preview, setPreview] = useState<RoomPreview | null>(null);
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [loadingError, setLoadingError] = useState("");
  const [joinError, setJoinError] = useState("");
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    let active = true;
    getRoomPreview(roomId)
      .then((roomPreview) => {
        if (!active) return;
        setPreview(roomPreview);
        const hostToken = localStorage.getItem(`tongying:host:${roomId}`) || "";
        const savedName = localStorage.getItem("tongying:nickname") || "";
        const alreadyJoined = sessionStorage.getItem(`tongying:joined:${roomId}`) === "1";
        const justCreated = sessionStorage.getItem(`tongying:auto:${roomId}`) === "1";
        if (savedName && (hostToken || (alreadyJoined && !roomPreview.passwordRequired) || justCreated)) {
          setIdentity({ name: savedName, password: "", hostToken });
          sessionStorage.removeItem(`tongying:auto:${roomId}`);
        }
      })
      .catch((caught) => {
        if (active) setLoadingError(caught instanceof Error ? caught.message : "找不到这个房间");
      });
    return () => {
      active = false;
    };
  }, [retryKey, roomId]);

  const handleIdentityError = useCallback((message: string) => {
    setJoinError(message);
    setIdentity(null);
  }, []);

  if (loadingError) {
    const isNetworkError = /连接|网络|超时/.test(loadingError);
    return (
      <main className="room-error-page">
        <Wordmark inverse />
        <div>
          <span>{isNetworkError ? "NETWORK / RETRY" : "404 / NO SCREENING"}</span>
          <h1>{isNetworkError ? "暂时连不上放映室。" : "这场放映好像已经散场了。"}</h1>
          <p>{loadingError}</p>
          <div className="room-error-actions">
            {isNetworkError && (
              <button
                className="join-button"
                onClick={() => {
                  setLoadingError("");
                  setPreview(null);
                  setRetryKey((key) => key + 1);
                }}
              >
                <Radio size={17} /> 重新连接
              </button>
            )}
            <button className="join-button secondary" onClick={onExit}><ArrowLeft size={17} /> 回到首页</button>
          </div>
        </div>
      </main>
    );
  }

  if (!preview) {
    return (
      <main className="room-loading">
        <Wordmark inverse />
        <LoaderCircle className="spin" size={28} />
        <p>正在寻找放映室…</p>
      </main>
    );
  }

  if (!identity) {
    return (
      <JoinGate
        preview={preview}
        roomId={roomId}
        error={joinError}
        onJoin={(nextIdentity) => {
          setJoinError("");
          setIdentity(nextIdentity);
        }}
        onExit={onExit}
      />
    );
  }

  return (
    <RoomExperience
      roomId={roomId}
      identity={identity}
      onExit={onExit}
      onIdentityError={handleIdentityError}
    />
  );
}
