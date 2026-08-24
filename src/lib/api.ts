import type {
  CreateRoomInput,
  CreateRoomResponse,
  EncryptedWebDavCredentials,
  RoomPreview,
  WebDavBrowseInput,
  WebDavBrowseResponse,
  WebDavSourceInput,
} from "../types";

const FALLBACK_API = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"
  ? window.location.origin
  : window.location.hostname === "play.lacknb.com"
    ? window.location.origin
    : "https://tongying-realtime.gitsilence.workers.dev";

export const API_BASE = (import.meta.env.VITE_REALTIME_URL || FALLBACK_API).replace(/\/$/, "");
let webDavPublicKeyPromise: Promise<CryptoKey> | null = null;

function bytesToBase64(value: ArrayBuffer) {
  const bytes = new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function request<T>(
  path: string,
  init?: RequestInit,
  options: { timeoutMs?: number; timeoutMessage?: string } = {},
): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
  const abortFromCaller = () => controller.abort();
  init?.signal?.addEventListener("abort", abortFromCaller, { once: true });

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...init?.headers,
      },
    });
  } catch (caught) {
    if (controller.signal.aborted && !init?.signal?.aborted) {
      throw new Error(options.timeoutMessage || "连接放映室超时，请检查网络后重试");
    }
    throw new Error(caught instanceof Error && caught.name !== "TypeError"
      ? caught.message
      : "无法连接放映室，请检查网络后重试");
  } finally {
    window.clearTimeout(timeout);
    init?.signal?.removeEventListener("abort", abortFromCaller);
  }

  const body = (await response.json().catch(() => null)) as
    | (T & { message?: string })
    | null;

  if (!response.ok) {
    throw new Error(body?.message || "请求失败，请稍后再试");
  }

  return body as T;
}

async function getWebDavPublicKey() {
  if (webDavPublicKeyPromise) return webDavPublicKeyPromise;
  webDavPublicKeyPromise = (async () => {
    const response = await request<{ key: JsonWebKey }>("/api/webdav/key");
    return crypto.subtle.importKey(
      "jwk",
      response.key,
      { name: "RSA-OAEP", hash: "SHA-256" },
      false,
      ["encrypt"],
    );
  })().catch((caught) => {
    webDavPublicKeyPromise = null;
    throw caught;
  });
  return webDavPublicKeyPromise;
}

async function encryptWebDavCredentials(
  username: string,
  password: string,
  context: string,
): Promise<EncryptedWebDavCredentials> {
  const publicKey = await getWebDavPublicKey();
  const aesKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt"]);
  const rawKey = await crypto.subtle.exportKey("raw", aesKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(`tongying:webdav:${context}`) },
    aesKey,
    new TextEncoder().encode(JSON.stringify({ username, password })),
  );
  const encryptedKey = await crypto.subtle.encrypt({ name: "RSA-OAEP" }, publicKey, rawKey);
  return {
    encryptedKey: bytesToBase64(encryptedKey),
    iv: bytesToBase64(iv.buffer),
    ciphertext: bytesToBase64(ciphertext),
  };
}

async function sealWebDavInput<T extends WebDavSourceInput>(input: T): Promise<T> {
  const { username = "", password = "", ...rest } = input;
  if (!username && !password) return rest as T;
  return {
    ...rest,
    credentials: await encryptWebDavCredentials(username, password, input.baseUrl),
  } as T;
}

export async function createRoom(input: CreateRoomInput) {
  const body = input.webdav
    ? { ...input, webdav: await sealWebDavInput(input.webdav) }
    : input;
  return request<CreateRoomResponse>("/api/rooms", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function getRoomPreview(roomId: string) {
  return request<RoomPreview>(`/api/rooms/${encodeURIComponent(roomId)}`);
}

export async function browseWebDav(input: WebDavBrowseInput, signal?: AbortSignal) {
  const body = await sealWebDavInput({ ...input, path: input.path || "/" });
  return request<WebDavBrowseResponse>("/api/webdav/files", {
    method: "POST",
    body: JSON.stringify(body),
    signal,
  }, {
    timeoutMs: 30_000,
    timeoutMessage: "读取 WebDAV 目录超时，请检查服务地址和网络",
  });
}

export function getRoomSocketUrl(roomId: string) {
  const url = new URL(API_BASE);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `/api/rooms/${encodeURIComponent(roomId)}/ws`;
  url.search = "";
  return url.toString();
}

export function normalizeRoomCode(value: string) {
  return value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
}
