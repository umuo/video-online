interface Env {
  ROOMS: DurableObjectNamespace;
  ALLOWED_ORIGIN?: string;
  ROOM_EMPTY_TTL_MS?: string;
}

type SourceType = "video" | "live";
type ControlAction = "play" | "pause" | "seek" | "tick" | "rate";

interface RoomRecord {
  id: string;
  title: string;
  sourceUrl: string;
  sourceType: SourceType;
  playing: boolean;
  position: number;
  rate: number;
  updatedAt: number;
  createdAt: number;
  passwordHash: string | null;
  hostTokenHash: string;
}

interface SessionAttachment {
  id: string;
  name: string;
  isHost: boolean;
  authenticated: boolean;
}

interface JoinMessage {
  type: "join";
  name?: string;
  password?: string;
  hostToken?: string;
}

interface ControlMessage {
  type: "control";
  action?: ControlAction;
  position?: number;
  playing?: boolean;
  rate?: number;
}

interface DanmakuMessage {
  type: "danmaku";
  text?: string;
  color?: string;
  mode?: "right" | "top" | "bottom";
  size?: "small" | "medium" | "big";
}

const jsonHeaders = { "Content-Type": "application/json; charset=utf-8" };
const roomAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function json(data: unknown, status = 200, headers: HeadersInit = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...jsonHeaders, ...headers },
  });
}

function roomId() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (byte) => roomAlphabet[byte % roomAlphabet.length]).join("");
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function secretHash(id: string, value: string) {
  return sha256(`${id}:${value}`);
}

function safeEqual(left: string | null, right: string) {
  if (!left || left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function sanitizeName(value: unknown) {
  const name = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  return Array.from(name || "观众").slice(0, 16).join("");
}

function publicRoom(room: RoomRecord) {
  const now = Date.now();
  const elapsed = room.playing && room.sourceType !== "live"
    ? ((now - room.updatedAt) / 1000) * room.rate
    : 0;
  return {
    id: room.id,
    title: room.title,
    sourceUrl: room.sourceUrl,
    sourceType: room.sourceType,
    playing: room.playing,
    position: Math.max(0, room.position + elapsed),
    rate: room.rate,
    updatedAt: now,
    createdAt: room.createdAt,
    passwordRequired: Boolean(room.passwordHash),
  };
}

function validMediaUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function corsHeaders(request: Request, env: Env) {
  const origin = request.headers.get("Origin") || "";
  const allowedOrigins = configuredOrigins(env);
  const responseOrigin = origin && originAllowed(request, env)
    ? origin
    : allowedOrigins[0] || "*";
  return {
    "Access-Control-Allow-Origin": responseOrigin,
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    Vary: "Origin",
  };
}

function configuredOrigins(env: Env) {
  return (env.ALLOWED_ORIGIN || "*")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function matchesAllowedOrigin(origin: string, allowed: string) {
  if (allowed === "*") return true;
  if (!allowed.includes("*")) return origin === allowed;
  const escaped = allowed
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[^./]+");
  return new RegExp(`^${escaped}$`).test(origin);
}

function originAllowed(request: Request, env: Env) {
  const origin = request.headers.get("Origin") || "";
  if (!origin) {
    const hostname = new URL(request.url).hostname;
    return [
      "play.lacknb.com",
      "api.play.lacknb.com",
      "tongying-realtime.gitsilence.workers.dev",
      "localhost",
      "127.0.0.1",
    ].includes(hostname);
  }
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return true;
  return configuredOrigins(env).some((allowed) => matchesAllowedOrigin(origin, allowed));
}

async function withCors(response: Response, request: Request, env: Env) {
  const headers = new Headers(response.headers);
  Object.entries(corsHeaders(request, env)).forEach(([key, value]) => headers.set(key, value));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (!originAllowed(request, env)) {
      return withCors(json({ message: "当前来源未被允许" }, 403), request, env);
    }

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }

    if (request.method === "POST" && url.pathname === "/api/rooms") {
      const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
      if (!body || !validMediaUrl(body.sourceUrl)) {
        return withCors(json({ message: "请填写有效的 HTTP(S) 视频地址" }, 400), request, env);
      }

      const sourceType: SourceType = body.sourceType === "live" ? "live" : "video";
      const title = typeof body.title === "string" ? body.title.trim().slice(0, 60) : "";
      const password = typeof body.password === "string" ? body.password.trim().slice(0, 64) : "";

      for (let attempt = 0; attempt < 4; attempt += 1) {
        const id = roomId();
        const hostToken = randomToken();
        const record: RoomRecord = {
          id,
          title: title || (sourceType === "live" ? "一起看直播" : "今晚的电影"),
          sourceUrl: body.sourceUrl,
          sourceType,
          playing: false,
          position: 0,
          rate: 1,
          updatedAt: Date.now(),
          createdAt: Date.now(),
          passwordHash: password ? await secretHash(id, password) : null,
          hostTokenHash: await secretHash(id, hostToken),
        };

        const response = await env.ROOMS.getByName(id).fetch("https://room.internal/create", {
          method: "POST",
          headers: jsonHeaders,
          body: JSON.stringify(record),
        });

        if (response.ok) {
          return withCors(json({ room: publicRoom(record), hostToken }, 201), request, env);
        }
        if (response.status !== 409) {
          return withCors(json({ message: "房间创建失败，请稍后再试" }, 500), request, env);
        }
      }

      return withCors(json({ message: "房间号生成失败，请再试一次" }, 503), request, env);
    }

    const match = url.pathname.match(/^\/api\/rooms\/([A-Z0-9]{6})(\/ws)?$/i);
    if (!match) {
      return withCors(json({ message: "没有找到这个接口" }, 404), request, env);
    }

    const id = match[1].toUpperCase();
    const stub = env.ROOMS.getByName(id);

    if (match[2] === "/ws") {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return withCors(json({ message: "需要 WebSocket 连接" }, 426), request, env);
      }
      return stub.fetch(new Request("https://room.internal/ws", request));
    }

    if (request.method === "GET") {
      const response = await stub.fetch("https://room.internal/info");
      return withCors(response, request, env);
    }

    return withCors(json({ message: "不支持的请求方式" }, 405), request, env);
  },
} satisfies ExportedHandler<Env>;

export class RoomHub implements DurableObject {
  private readonly state: DurableObjectState;
  private readonly emptyRoomTtlMs: number;
  private room: RoomRecord | null | undefined;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    const configuredTtl = Number(env.ROOM_EMPTY_TTL_MS);
    this.emptyRoomTtlMs = Number.isFinite(configuredTtl) && configuredTtl >= 1000
      ? configuredTtl
      : 60 * 60 * 1000;
  }

  private async getRoom() {
    if (this.room === undefined) {
      this.room = (await this.state.storage.get<RoomRecord>("room")) ?? null;
    }
    return this.room;
  }

  private authenticatedSockets() {
    return this.state.getWebSockets().filter((socket) => {
      const session = socket.deserializeAttachment() as SessionAttachment | null;
      return session?.authenticated && socket.readyState === WebSocket.OPEN;
    });
  }

  private members() {
    return this.authenticatedSockets().map((socket) => {
      const session = socket.deserializeAttachment() as SessionAttachment;
      return { id: session.id, name: session.name, isHost: session.isHost };
    });
  }

  private broadcast(message: unknown, except?: WebSocket) {
    const payload = JSON.stringify(message);
    const exceptSession = except?.deserializeAttachment() as SessionAttachment | null | undefined;
    for (const socket of this.authenticatedSockets()) {
      const session = socket.deserializeAttachment() as SessionAttachment;
      if (exceptSession && session.id === exceptSession.id) continue;
      try {
        socket.send(payload);
      } catch {
        socket.close(1011, "消息发送失败");
      }
    }
  }

  private broadcastMembers() {
    this.broadcast({ type: "members", members: this.members() });
  }

  private async scheduleCleanupIfEmpty() {
    if (this.authenticatedSockets().length > 0 || !(await this.getRoom())) return;
    await this.state.storage.setAlarm(Date.now() + this.emptyRoomTtlMs);
  }

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;

    if (path === "/create" && request.method === "POST") {
      if (await this.getRoom()) return json({ message: "房间号已存在" }, 409);
      const record = (await request.json()) as RoomRecord;
      this.room = record;
      await this.state.storage.put("room", record);
      await this.scheduleCleanupIfEmpty();
      return json({ ok: true }, 201);
    }

    const room = await this.getRoom();
    if (!room) return json({ message: "房间不存在或已经结束" }, 404);

    if (path === "/info") {
      await this.scheduleCleanupIfEmpty();
      return json({
        id: room.id,
        title: room.title,
        sourceType: room.sourceType,
        passwordRequired: Boolean(room.passwordHash),
        onlineCount: this.members().length,
      });
    }

    if (path !== "/ws" || request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return json({ message: "无效的房间请求" }, 400);
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const attachment: SessionAttachment = {
      id: crypto.randomUUID(),
      name: "观众",
      isHost: false,
      authenticated: false,
    };
    server.serializeAttachment(attachment);
    this.state.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket: WebSocket, rawMessage: string | ArrayBuffer) {
    const session = socket.deserializeAttachment() as SessionAttachment | null;
    if (!session) {
      socket.close(1011, "会话状态丢失");
      return;
    }

    const text = typeof rawMessage === "string" ? rawMessage : new TextDecoder().decode(rawMessage);
    if (text.length > 4096) {
      socket.close(1009, "消息过长");
      return;
    }

    let message: JoinMessage | ControlMessage | DanmakuMessage | { type?: string };
    try {
      message = JSON.parse(text) as typeof message;
    } catch {
      socket.send(JSON.stringify({ type: "error", code: "BAD_MESSAGE", message: "消息格式错误" }));
      return;
    }

    const room = await this.getRoom();
    if (!room) {
      socket.close(1008, "房间不存在");
      return;
    }

    if (!session.authenticated) {
      if (message.type !== "join") {
        socket.send(JSON.stringify({ type: "error", code: "JOIN_REQUIRED", message: "请先加入房间" }));
        return;
      }

      const join = message as JoinMessage;
      const passwordHash = await secretHash(room.id, join.password || "");
      if (room.passwordHash && !safeEqual(room.passwordHash, passwordHash)) {
        socket.send(JSON.stringify({ type: "error", code: "BAD_PASSWORD", message: "房间密码不正确" }));
        socket.close(1008, "密码错误");
        return;
      }

      const hostTokenHash = await secretHash(room.id, join.hostToken || "");
      session.authenticated = true;
      session.name = sanitizeName(join.name);
      session.isHost = safeEqual(room.hostTokenHash, hostTokenHash);
      socket.serializeAttachment(session);
      await this.state.storage.deleteAlarm();

      const members = this.members();
      socket.send(
        JSON.stringify({
          type: "hello",
          room: publicRoom(room),
          self: { id: session.id, name: session.name, isHost: session.isHost },
          members,
        }),
      );
      this.broadcastMembers();
      return;
    }

    if (message.type === "ping") {
      socket.send(JSON.stringify({ type: "pong" }));
      return;
    }

    if (message.type === "control") {
      if (!session.isHost) {
        socket.send(JSON.stringify({ type: "error", code: "HOST_ONLY", message: "只有房主可以控制播放" }));
        return;
      }

      const control = message as ControlMessage;
      const action = control.action;
      if (!action || !["play", "pause", "seek", "tick", "rate"].includes(action)) return;

      const position = Number.isFinite(control.position)
        ? Math.max(0, Math.min(Number(control.position), 60 * 60 * 24 * 7))
        : room.position;
      const rate = Number.isFinite(control.rate)
        ? Math.max(0.25, Math.min(Number(control.rate), 2))
        : room.rate;

      room.position = room.sourceType === "live" ? 0 : position;
      room.playing = Boolean(control.playing);
      room.rate = rate;
      room.updatedAt = Date.now();
      this.room = room;
      await this.state.storage.put("room", room);
      // 房主已经处于权威播放状态，不把控制消息回发给房主，避免本地播放器反复校正自己。
      this.broadcast({ type: "sync", action, room: publicRoom(room) }, socket);
      return;
    }

    if (message.type === "danmaku") {
      const danmaku = message as DanmakuMessage;
      const danmakuText = typeof danmaku.text === "string" ? danmaku.text.trim() : "";
      if (!danmakuText) return;
      if (Array.from(danmakuText).length > 80) {
        socket.send(JSON.stringify({ type: "error", code: "DANMAKU_TOO_LONG", message: "弹幕最多 80 个字" }));
        return;
      }

      const color = /^#[0-9a-f]{6}$/i.test(danmaku.color || "") ? danmaku.color : "#ffffff";
      const mode = ["right", "top", "bottom"].includes(danmaku.mode || "") ? danmaku.mode : "right";
      const size = ["small", "medium", "big"].includes(danmaku.size || "") ? danmaku.size : "medium";

      // 弹幕只发送给当前在线连接，绝不写入 Durable Object Storage。
      this.broadcast({
        type: "danmaku",
        id: crypto.randomUUID(),
        name: session.name,
        text: Array.from(danmakuText).slice(0, 80).join(""),
        color,
        mode,
        size,
        sentAt: Date.now(),
      });
    }
  }

  async webSocketClose(socket: WebSocket, code: number, reason: string) {
    void socket;
    void code;
    void reason;
    this.broadcastMembers();
    await this.scheduleCleanupIfEmpty();
  }

  async webSocketError(socket: WebSocket) {
    try {
      socket.close(1011, "连接异常");
    } catch {
      // 连接可能已经由运行时关闭。
    }
    this.broadcastMembers();
    await this.scheduleCleanupIfEmpty();
  }

  async alarm() {
    if (this.authenticatedSockets().length > 0) return;
    for (const socket of this.state.getWebSockets()) {
      try {
        socket.close(1001, "房间已自动解散");
      } catch {
        // 连接可能已经关闭。
      }
    }
    this.room = null;
    await this.state.storage.deleteAll();
  }
}
