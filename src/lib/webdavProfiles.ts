export interface WebDavProfile {
  id: string;
  name: string;
  baseUrl: string;
  username: string;
  password: string;
}

interface StoredProfiles {
  version: 1;
  iv: string;
  ciphertext: string;
}

const storageKey = "tongying:webdav-profiles:v1";
const databaseName = "tongying-secure-storage";
const objectStoreName = "crypto-keys";
const profileKeyName = "webdav-profiles:v1";
let deviceKeyPromise: Promise<CryptoKey> | null = null;

function bytesToBase64(value: ArrayBuffer) {
  const bytes = new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function openKeyDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(objectStoreName)) {
        request.result.createObjectStore(objectStoreName);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("无法打开安全存储"));
  });
}

function idbRequest<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("安全存储操作失败"));
  });
}

async function getDeviceKey() {
  if (deviceKeyPromise) return deviceKeyPromise;
  deviceKeyPromise = (async () => {
    if (!window.crypto?.subtle || !window.indexedDB) {
      throw new Error("当前浏览器不支持安全保存 WebDAV 配置");
    }
    const database = await openKeyDatabase();
    const existing = await idbRequest<CryptoKey | undefined>(
      database.transaction(objectStoreName, "readonly").objectStore(objectStoreName).get(profileKeyName),
    );
    if (existing) return existing;

    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    try {
      await idbRequest(
        database.transaction(objectStoreName, "readwrite").objectStore(objectStoreName).add(key, profileKeyName),
      );
      return key;
    } catch {
      const winner = await idbRequest<CryptoKey | undefined>(
        database.transaction(objectStoreName, "readonly").objectStore(objectStoreName).get(profileKeyName),
      );
      if (winner) return winner;
      throw new Error("无法初始化安全存储密钥");
    }
  })().catch((caught) => {
    deviceKeyPromise = null;
    throw caught;
  });
  return deviceKeyPromise;
}

export async function loadWebDavProfiles(): Promise<WebDavProfile[]> {
  const saved = localStorage.getItem(storageKey);
  if (!saved) return [];
  try {
    const envelope = JSON.parse(saved) as StoredProfiles;
    if (envelope.version !== 1 || !envelope.iv || !envelope.ciphertext) throw new Error("配置格式无效");
    const key = await getDeviceKey();
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: base64ToBytes(envelope.iv),
        additionalData: new TextEncoder().encode(storageKey),
      },
      key,
      base64ToBytes(envelope.ciphertext),
    );
    const profiles = JSON.parse(new TextDecoder().decode(plaintext)) as WebDavProfile[];
    if (!Array.isArray(profiles)) throw new Error("配置格式无效");
    return profiles.filter((profile) => (
      profile
      && typeof profile.id === "string"
      && typeof profile.name === "string"
      && typeof profile.baseUrl === "string"
      && typeof profile.username === "string"
      && typeof profile.password === "string"
    ));
  } catch {
    throw new Error("已保存的 WebDAV 配置无法解密，可重新保存当前配置进行覆盖");
  }
}

export async function saveWebDavProfiles(profiles: WebDavProfile[]) {
  const key = await getDeviceKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(storageKey) },
    key,
    new TextEncoder().encode(JSON.stringify(profiles)),
  );
  const envelope: StoredProfiles = {
    version: 1,
    iv: bytesToBase64(iv.buffer),
    ciphertext: bytesToBase64(ciphertext),
  };
  localStorage.setItem(storageKey, JSON.stringify(envelope));
}
