const nicknameAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function normalizeNickname(value: string) {
  return Array.from(value.trim().replace(/\s+/g, " ")).slice(0, 16).join("");
}

export function resolveNickname(value: string) {
  const nickname = normalizeNickname(value);
  if (nickname) return nickname;

  const random = crypto.getRandomValues(new Uint8Array(4));
  const suffix = Array.from(random, (byte) => nicknameAlphabet[byte % nicknameAlphabet.length]).join("");
  return `观众-${suffix}`;
}
