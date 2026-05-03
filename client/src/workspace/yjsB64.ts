/**
 * @fileoverview Кодирование бинарного Yjs update в Base64 для JSON API (`y-seed` и т.п.) без Buffer в браузере.
 */

/** Yjs update → Base64 (побайтовый `btoa`). */
export function yjsUpdateToBase64(update: Uint8Array): string {
  let s = '';
  for (let i = 0; i < update.length; i++) s += String.fromCharCode(update[i]);
  return btoa(s);
}

/** Base64 → `Uint8Array` для применения update на клиенте. */
export function base64ToUint8Array(b64: string): Uint8Array {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}
