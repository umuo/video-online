import type { CreateRoomInput, CreateRoomResponse, RoomPreview } from "../types";

const FALLBACK_API = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"
  ? "http://localhost:8787"
  : window.location.hostname === "play.lacknb.com"
    ? window.location.origin
    : "https://tongying-realtime.gitsilence.workers.dev";

export const API_BASE = (import.meta.env.VITE_REALTIME_URL || FALLBACK_API).replace(/\/$/, "");

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 10_000);
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
      throw new Error("连接放映室超时，请检查网络后重试");
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

export function createRoom(input: CreateRoomInput) {
  return request<CreateRoomResponse>("/api/rooms", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function getRoomPreview(roomId: string) {
  return request<RoomPreview>(`/api/rooms/${encodeURIComponent(roomId)}`);
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
