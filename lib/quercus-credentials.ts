// Server-only credential encryption; bind ciphertext to its owning Ink & Iron account.
export function quercusConfig() {
  const secret = process.env.QUERCUS_TOKEN_SECRET ?? "";
  const owner = process.env.QUERCUS_ALLOWED_USER_ID ?? "";
  return { secret, owner, configured: secret.length >= 32 && Boolean(owner) };
}
async function key(secret: string) {
  return crypto.subtle.importKey("raw", await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret)), "AES-GCM", false, ["encrypt", "decrypt"]);
}
function encode(bytes: Uint8Array) { return btoa(String.fromCharCode(...bytes)); }
function decode(value: string) { return Uint8Array.from(atob(value), (char) => char.charCodeAt(0)); }
export async function encryptQuercusToken(token: string, secret: string, owner: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(owner) }, await key(secret), new TextEncoder().encode(token));
  return `${encode(iv)}.${encode(new Uint8Array(encrypted))}`;
}
export async function decryptQuercusToken(value: string, secret: string, owner: string) {
  const [iv, ciphertext] = value.split(".");
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: decode(iv), additionalData: new TextEncoder().encode(owner) }, await key(secret), decode(ciphertext)));
}
