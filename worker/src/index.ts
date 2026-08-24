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
  webdavSource?: WebDavUpstream;
}

interface WebDavUpstream {
  url: string;
  authorization?: string;
}

interface WebDavInput {
  baseUrl: string;
  username: string;
  password: string;
  path: string;
  contentType: string;
}

interface EncryptedWebDavCredentials {
  encryptedKey: string;
  iv: string;
  ciphertext: string;
}

interface StoredCredentialKeys {
  publicJwk: JsonWebKey;
  privateJwk: JsonWebKey;
}

interface WebDavEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  isVideo: boolean;
  size: number | null;
  modifiedAt: string | null;
  contentType: string;
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
const credentialVaultName = "__TONGYING_WEBDAV_CREDENTIALS_V1__";

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

const redirectStatuses = new Set([301, 302, 303, 307, 308]);

function safeMediaRedirect(location: string | null, sourceUrl: string) {
  if (!location) return null;
  try {
    const source = new URL(sourceUrl);
    const target = new URL(location, source);
    if (
      !["http:", "https:"].includes(target.protocol)
      || isPrivateHostname(target.hostname)
      || target.username
      || target.password
      || (source.protocol === "https:" && target.protocol !== "https:")
    ) return null;
    return target.toString();
  } catch {
    return null;
  }
}

function isPrivateHostname(hostname: string) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    normalized === "localhost"
    || normalized === "::1"
    || normalized.endsWith(".localhost")
    || normalized.endsWith(".local")
  ) return true;

  const parts = normalized.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe80:");
  }
  return parts[0] === 10
    || parts[0] === 127
    || (parts[0] === 169 && parts[1] === 254)
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168);
}

function normalizeWebDavBase(value: unknown) {
  if (typeof value !== "string" || value.length > 2048) throw new Error("请填写有效的 WebDAV 地址");
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || isPrivateHostname(url.hostname)) {
    throw new Error("WebDAV 必须是可公网访问的 HTTP(S) 地址");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("请将账号密码单独填写，WebDAV 地址不能包含凭据、查询参数或锚点");
  }
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/`;
  return url;
}

function normalizeWebDavPath(value: unknown, directory = false) {
  if (typeof value !== "string" || value.length > 2048 || value.includes("\0")) {
    throw new Error("WebDAV 路径无效");
  }
  const segments = value.replace(/\\/g, "/").split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error("WebDAV 路径不能包含相对路径");
  }
  const path = `/${segments.join("/")}`;
  return directory && path !== "/" ? `${path}/` : path;
}

function webDavUrl(baseUrl: URL, path: string, directory = false) {
  const normalized = normalizeWebDavPath(path, directory);
  const encoded = normalized.split("/").map((segment) => encodeURIComponent(segment)).join("/");
  const result = new URL(baseUrl.toString());
  result.pathname = `${baseUrl.pathname}${encoded.replace(/^\//, "")}`;
  return result;
}

function basicAuthorization(username: string, password: string) {
  if (!username && !password) return undefined;
  const bytes = new TextEncoder().encode(`${username}:${password}`);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `Basic ${btoa(binary)}`;
}

function base64Bytes(value: unknown, maxBytes: number) {
  if (typeof value !== "string" || value.length > maxBytes * 2 || !/^[a-z0-9+/]*={0,2}$/i.test(value)) {
    throw new Error("加密凭据格式无效");
  }
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new Error("加密凭据格式无效");
  }
  if (binary.length > maxBytes) throw new Error("加密凭据过长");
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function decryptWebDavInput(value: unknown, env: Env) {
  if (!value || typeof value !== "object") return value;
  const input = value as Record<string, unknown>;
  if (!input.credentials) return input;
  const response = await env.ROOMS.getByName(credentialVaultName).fetch("https://room.internal/decrypt-credentials", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      ...(input.credentials as Record<string, unknown>),
      context: typeof input.baseUrl === "string" ? input.baseUrl : "",
    }),
  });
  const body = await response.json().catch(() => null) as { username?: unknown; password?: unknown; message?: string } | null;
  if (!response.ok || typeof body?.username !== "string" || typeof body.password !== "string") {
    throw new Error(body?.message || "WebDAV 凭据解密失败，请刷新页面后重试");
  }
  const { credentials: _credentials, ...rest } = input;
  void _credentials;
  return { ...rest, username: body.username, password: body.password };
}

function parseWebDavInput(value: unknown, directory = false): WebDavInput {
  if (!value || typeof value !== "object") throw new Error("WebDAV 配置不完整");
  const input = value as Record<string, unknown>;
  const baseUrl = normalizeWebDavBase(input.baseUrl).toString();
  const username = typeof input.username === "string" ? input.username : "";
  const password = typeof input.password === "string" ? input.password : "";
  if (username.length > 256 || password.length > 1024) throw new Error("WebDAV 账号或密码过长");
  return {
    baseUrl,
    username,
    password,
    path: normalizeWebDavPath(typeof input.path === "string" ? input.path : "/", directory),
    contentType: typeof input.contentType === "string" ? input.contentType.slice(0, 256) : "",
  };
}

function decodeXml(value: string) {
  return value
    .replace(/&#(\d+);/g, (entity, code: string) => {
      const point = Number(code);
      return Number.isInteger(point) && point >= 0 && point <= 0x10ffff ? String.fromCodePoint(point) : entity;
    })
    .replace(/&#x([0-9a-f]+);/gi, (entity, code: string) => {
      const point = Number.parseInt(code, 16);
      return Number.isInteger(point) && point >= 0 && point <= 0x10ffff ? String.fromCodePoint(point) : entity;
    })
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function xmlValue(block: string, tag: string) {
  const match = block.match(new RegExp(`<(?:[\\w-]+:)?${tag}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w-]+:)?${tag}>`, "i"));
  return match ? decodeXml(match[1].replace(/<[^>]+>/g, "").trim()) : "";
}

function decodedPathname(pathname: string) {
  return `/${pathname.split("/").filter(Boolean).map((segment) => {
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment;
    }
  }).join("/")}`;
}

const videoExtensions = new Set([
  "3gp", "avi", "flv", "m2ts", "m4v", "mkv", "mov", "mp4", "mpeg", "mpg", "mts", "ogv", "ts", "webm", "wmv",
]);

function isVideoResource(path: string, contentType: string) {
  const extension = path.match(/\.([^./]+)$/)?.[1]?.toLowerCase() || "";
  return contentType.toLowerCase().startsWith("video/") || videoExtensions.has(extension);
}

function parseWebDavEntries(xml: string, baseUrl: URL, requestedPath: string) {
  const basePath = decodedPathname(baseUrl.pathname);
  const requested = normalizeWebDavPath(requestedPath, true);
  const responses = xml.match(/<(?:[\w-]+:)?response\b[^>]*>[\s\S]*?<\/(?:[\w-]+:)?response>/gi) || [];
  const entries: WebDavEntry[] = [];

  for (const response of responses) {
    const hrefValue = xmlValue(response, "href");
    if (!hrefValue) continue;
    let href: URL;
    try {
      href = new URL(hrefValue, baseUrl);
    } catch {
      continue;
    }
    if (href.origin !== baseUrl.origin) continue;
    const decodedHref = decodedPathname(href.pathname);
    const normalizedBase = basePath === "/" ? "/" : `${basePath.replace(/\/$/, "")}/`;
    if (!decodedHref.startsWith(normalizedBase)) continue;
    const relative = normalizeWebDavPath(decodedHref.slice(normalizedBase.length - 1));
    const isDirectory = /<(?:[\w-]+:)?collection\b/i.test(response);
    const path = normalizeWebDavPath(relative, isDirectory);
    if (normalizeWebDavPath(path, true) === requested) continue;
    if (!path.startsWith(requested)) continue;
    const childPath = path.slice(requested.length).replace(/\/$/, "");
    if (!childPath || childPath.includes("/")) continue;

    const fallbackName = path.split("/").filter(Boolean).at(-1) || "未命名资源";
    const sizeText = xmlValue(response, "getcontentlength");
    const rawSize = Number(sizeText);
    const modified = xmlValue(response, "getlastmodified");
    const contentType = xmlValue(response, "getcontenttype");
    entries.push({
      name: xmlValue(response, "displayname") || fallbackName,
      path,
      isDirectory,
      isVideo: !isDirectory && isVideoResource(path, contentType),
      size: !isDirectory && sizeText !== "" && Number.isFinite(rawSize) && rawSize >= 0 ? rawSize : null,
      modifiedAt: modified && !Number.isNaN(Date.parse(modified)) ? new Date(modified).toISOString() : null,
      contentType,
    });
  }

  return entries.sort((left, right) => {
    if (left.isDirectory !== right.isDirectory) return left.isDirectory ? -1 : 1;
    return left.name.localeCompare(right.name, "zh-CN", { numeric: true, sensitivity: "base" });
  });
}

async function browseWebDav(request: Request, env: Env) {
  const encryptedBody = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  let body: Record<string, unknown> | null;
  let input: WebDavInput;
  try {
    body = await decryptWebDavInput(encryptedBody, env) as Record<string, unknown> | null;
    input = parseWebDavInput(body, true);
  } catch (caught) {
    return json({ message: caught instanceof Error ? caught.message : "WebDAV 配置无效" }, 400);
  }

  const pageValue = Number(body?.page);
  const pageSizeValue = Number(body?.pageSize);
  const requestedPage = Number.isInteger(pageValue) && pageValue > 0 ? pageValue : 1;
  const pageSize = Number.isInteger(pageSizeValue) ? Math.min(50, Math.max(5, pageSizeValue)) : 12;
  const baseUrl = new URL(input.baseUrl);
  const headers = new Headers({
    Depth: "1",
    "Content-Type": "application/xml; charset=utf-8",
  });
  const authorization = basicAuthorization(input.username, input.password);
  if (authorization) headers.set("Authorization", authorization);

  let response: Response;
  try {
    response = await fetch(webDavUrl(baseUrl, input.path, true), {
      method: "PROPFIND",
      headers,
      body: '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:displayname/><d:resourcetype/><d:getcontentlength/><d:getlastmodified/><d:getcontenttype/></d:prop></d:propfind>',
    });
  } catch {
    return json({ message: "无法连接 WebDAV 服务，请检查地址和网络" }, 502);
  }

  if (!response.ok) {
    const message = response.status === 401 || response.status === 403
      ? "WebDAV 认证失败，请检查账号和密码"
      : response.status === 404
        ? "WebDAV 目录不存在"
        : response.status === 405
          ? "该地址不接受 WebDAV PROPFIND，请填写 WebDAV 根目录而不是普通网页地址"
          : `WebDAV 服务返回了 ${response.status}`;
    return json({ message }, response.status === 401 || response.status === 403 ? 401 : 502);
  }
  const contentLength = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(contentLength) && contentLength > 5_000_000) {
    return json({ message: "这个 WebDAV 目录内容过多，请先整理为较小的子目录" }, 413);
  }
  const xml = await response.text();
  if (xml.length > 5_000_000) {
    return json({ message: "这个 WebDAV 目录内容过多，请先整理为较小的子目录" }, 413);
  }
  if (!/<(?:[\w-]+:)?multistatus\b/i.test(xml)) {
    return json({ message: "上游没有返回有效的 WebDAV 目录，请检查服务地址是否为 WebDAV 根目录" }, 502);
  }
  const entries = parseWebDavEntries(xml, baseUrl, input.path);
  const total = entries.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(requestedPage, totalPages);
  const start = (page - 1) * pageSize;
  const path = normalizeWebDavPath(input.path, true);
  const segments = path.split("/").filter(Boolean);
  const parentPath = segments.length
    ? normalizeWebDavPath(`/${segments.slice(0, -1).join("/")}`, true)
    : null;
  return json({
    path,
    parentPath,
    items: entries.slice(start, start + pageSize),
    page,
    pageSize,
    total,
    totalPages,
  });
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
    "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
    "Access-Control-Expose-Headers": "Accept-Ranges, Content-Length, Content-Range, Content-Type, ETag, Last-Modified",
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
  const requestUrl = new URL(request.url);
  if (!origin) {
    const hostname = requestUrl.hostname;
    return [
      "play.lacknb.com",
      "api.play.lacknb.com",
      "tongying-realtime.gitsilence.workers.dev",
      "localhost",
      "127.0.0.1",
    ].includes(hostname);
  }
  try {
    if (new URL(origin).origin === requestUrl.origin) return true;
  } catch {
    return false;
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

    if (request.method === "GET" && url.pathname === "/api/webdav/key") {
      const response = await env.ROOMS.getByName(credentialVaultName).fetch("https://room.internal/credential-key");
      return withCors(response, request, env);
    }

    if (url.pathname === "/api/webdav/key") {
      return withCors(json({ message: "WebDAV 公钥接口只支持 GET 请求" }, 405, { Allow: "GET, OPTIONS" }), request, env);
    }

    if (request.method === "POST" && url.pathname === "/api/webdav/files") {
      return withCors(await browseWebDav(request, env), request, env);
    }

    if (url.pathname === "/api/webdav/files") {
      return withCors(json({ message: "WebDAV 资源浏览接口只支持 POST 请求" }, 405, { Allow: "POST, OPTIONS" }), request, env);
    }

    if (request.method === "POST" && url.pathname === "/api/rooms") {
      const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
      const hasDirectSource = body && validMediaUrl(body.sourceUrl);
      let webdavInput: WebDavInput | null = null;
      if (body?.webdav) {
        try {
          webdavInput = parseWebDavInput(await decryptWebDavInput(body.webdav, env));
        } catch (caught) {
          return withCors(json({ message: caught instanceof Error ? caught.message : "WebDAV 配置无效" }, 400), request, env);
        }
        if (!isVideoResource(webdavInput.path, webdavInput.contentType)) {
          return withCors(json({ message: "请选择 WebDAV 中的视频文件" }, 400), request, env);
        }
      }
      if (!body || (!hasDirectSource && !webdavInput)) {
        return withCors(json({ message: "请填写有效的 HTTP(S) 视频地址" }, 400), request, env);
      }

      const sourceType: SourceType = webdavInput ? "video" : body.sourceType === "live" ? "live" : "video";
      const title = typeof body.title === "string" ? body.title.trim().slice(0, 60) : "";
      const password = typeof body.password === "string" ? body.password.trim().slice(0, 64) : "";

      for (let attempt = 0; attempt < 4; attempt += 1) {
        const id = roomId();
        const hostToken = randomToken();
        const selectedName = webdavInput?.path.split("/").filter(Boolean).at(-1) || "video";
        const sourceUrl = webdavInput
          ? `/api/rooms/${id}/media/${encodeURIComponent(selectedName)}`
          : body.sourceUrl as string;
        const upstreamUrl = webdavInput
          ? webDavUrl(new URL(webdavInput.baseUrl), webdavInput.path).toString()
          : null;
        const record: RoomRecord = {
          id,
          title: title || (sourceType === "live" ? "一起看直播" : "今晚的电影"),
          sourceUrl,
          sourceType,
          playing: false,
          position: 0,
          rate: 1,
          updatedAt: Date.now(),
          createdAt: Date.now(),
          passwordHash: password ? await secretHash(id, password) : null,
          hostTokenHash: await secretHash(id, hostToken),
          webdavSource: upstreamUrl ? {
            url: upstreamUrl,
            authorization: basicAuthorization(webdavInput!.username, webdavInput!.password),
          } : undefined,
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

    const match = url.pathname.match(/^\/api\/rooms\/([A-Z0-9]{6})(\/ws|\/media(?:\/[^/]*)?)?$/i);
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

    if (match[2]?.startsWith("/media")) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return withCors(json({ message: "媒体地址只支持读取" }, 405), request, env);
      }
      const headers = new Headers();
      for (const name of ["Range", "If-Range", "If-None-Match", "If-Modified-Since"]) {
        const value = request.headers.get(name);
        if (value) headers.set(name, value);
      }
      const response = await stub.fetch("https://room.internal/media", {
        method: request.method,
        headers,
        redirect: "manual",
      });
      return withCors(response, request, env);
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
  private credentialKeyPromise: Promise<{ publicJwk: JsonWebKey; privateKey: CryptoKey }> | null = null;

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

  private getCredentialKeys() {
    if (this.credentialKeyPromise) return this.credentialKeyPromise;
    this.credentialKeyPromise = (async () => {
      let stored = await this.state.storage.get<StoredCredentialKeys>("webdav-credential-keys:v1");
      if (!stored) {
        const pair = await crypto.subtle.generateKey(
          {
            name: "RSA-OAEP",
            modulusLength: 2048,
            publicExponent: new Uint8Array([1, 0, 1]),
            hash: "SHA-256",
          },
          true,
          ["encrypt", "decrypt"],
        ) as CryptoKeyPair;
        stored = {
          publicJwk: await crypto.subtle.exportKey("jwk", pair.publicKey) as JsonWebKey,
          privateJwk: await crypto.subtle.exportKey("jwk", pair.privateKey) as JsonWebKey,
        };
        await this.state.storage.put("webdav-credential-keys:v1", stored);
      }
      if (!stored) throw new Error("WebDAV 凭据密钥初始化失败");
      const privateKey = await crypto.subtle.importKey(
        "jwk",
        stored.privateJwk,
        { name: "RSA-OAEP", hash: "SHA-256" },
        false,
        ["decrypt"],
      );
      return { publicJwk: stored.publicJwk, privateKey };
    })().catch((caught) => {
      this.credentialKeyPromise = null;
      throw caught;
    });
    return this.credentialKeyPromise;
  }

  private async decryptCredentials(request: Request) {
    try {
      const input = await request.json() as Partial<EncryptedWebDavCredentials>;
      const encryptedKey = base64Bytes(input.encryptedKey, 512);
      const iv = base64Bytes(input.iv, 32);
      const ciphertext = base64Bytes(input.ciphertext, 4096);
      const context = typeof (input as Record<string, unknown>).context === "string"
        ? String((input as Record<string, unknown>).context)
        : "";
      if (!context || context.length > 2048) throw new Error("加密凭据上下文无效");
      if (iv.length !== 12) throw new Error("加密凭据的随机向量无效");
      const { privateKey } = await this.getCredentialKeys();
      const rawKey = await crypto.subtle.decrypt({ name: "RSA-OAEP" }, privateKey, encryptedKey);
      const aesKey = await crypto.subtle.importKey("raw", rawKey, { name: "AES-GCM" }, false, ["decrypt"]);
      const plaintext = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(`tongying:webdav:${context}`) },
        aesKey,
        ciphertext,
      );
      const credentials = JSON.parse(new TextDecoder().decode(plaintext)) as Record<string, unknown>;
      const username = typeof credentials.username === "string" ? credentials.username : "";
      const password = typeof credentials.password === "string" ? credentials.password : "";
      if (username.length > 256 || password.length > 1024) throw new Error("WebDAV 账号或密码过长");
      return json({ username, password });
    } catch {
      return json({ message: "WebDAV 凭据解密失败，请刷新页面后重试" }, 400);
    }
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

    if (path === "/credential-key" && request.method === "GET") {
      const { publicJwk } = await this.getCredentialKeys();
      return json({ key: publicJwk }, 200, { "Cache-Control": "public, max-age=3600" });
    }

    if (path === "/decrypt-credentials" && request.method === "POST") {
      return this.decryptCredentials(request);
    }

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

    if (path === "/media") {
      if (!room.webdavSource) return json({ message: "这个房间没有 WebDAV 媒体" }, 404);
      const headers = new Headers();
      for (const name of ["Range", "If-Range", "If-None-Match", "If-Modified-Since"]) {
        const value = request.headers.get(name);
        if (value) headers.set(name, value);
      }
      if (room.webdavSource.authorization) headers.set("Authorization", room.webdavSource.authorization);
      let upstream: Response;
      try {
        upstream = await fetch(room.webdavSource.url, {
          method: request.method === "HEAD" ? "HEAD" : "GET",
          headers,
          redirect: "manual",
        });
      } catch {
        return json({ message: "WebDAV 视频暂时无法读取" }, 502);
      }
      if (redirectStatuses.has(upstream.status)) {
        const location = safeMediaRedirect(upstream.headers.get("Location"), room.webdavSource.url);
        if (!location) return json({ message: "WebDAV 返回了不安全或无效的媒体跳转地址" }, 502);
        return new Response(null, {
          status: upstream.status,
          headers: {
            Location: location,
            "Cache-Control": "private, no-store",
            "Referrer-Policy": "no-referrer",
          },
        });
      }
      const responseHeaders = new Headers(upstream.headers);
      responseHeaders.delete("Set-Cookie");
      responseHeaders.set("Cache-Control", "private, no-store");
      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: responseHeaders,
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
