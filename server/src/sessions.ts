import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { WebSocket } from "ws";
import type { ClientInfo, DeviceInfo } from "@mobilebridge/protocol";

const ttl = () => Number(process.env.SESSION_TTL_MS ?? 120_000);

export type SessionState = "waiting" | "joined" | "approved" | "closed";

export interface Session {
  id: string;
  tokenHash: Buffer;          // token is never stored in plaintext
  expiresAt: number;
  state: SessionState;
  client: ClientInfo;
  laptop: WebSocket;
  laptopPub: string;
  android?: WebSocket;
  androidPub?: string;
  device?: DeviceInfo;
  timer?: NodeJS.Timeout;
}

const sha = (s: string) => createHash("sha256").update(s).digest();
const sessions = new Map<string, Session>();

export function createSession(laptop: WebSocket, laptopPub: string, client: ClientInfo, onExpire: (s: Session) => void) {
  const id = randomBytes(12).toString("base64url");
  const token = randomBytes(24).toString("base64url");
  const s: Session = { id, tokenHash: sha(token), expiresAt: Date.now() + ttl(), state: "waiting", client, laptop, laptopPub };
  // Only an unpaired session expires; once approved it lives until closed.
  s.timer = setTimeout(() => { if (s.state !== "approved") { onExpire(s); closeSession(s); } }, ttl());
  sessions.set(id, s);
  return { session: s, token };
}

export type JoinResult = { ok: true; session: Session } | { ok: false; code: string; message: string };

/** One-time token: the first successful join burns it. */
export function joinSession(id: string, token: string): JoinResult {
  const s = sessions.get(id);
  if (!s || s.state === "closed") return { ok: false, code: "not_found", message: "Session not found." };
  if (Date.now() > s.expiresAt) return { ok: false, code: "expired", message: "This QR code has expired." };
  if (s.state !== "waiting") return { ok: false, code: "already_used", message: "This QR code was already used." };
  const given = sha(token);
  if (!timingSafeEqual(given, s.tokenHash)) return { ok: false, code: "bad_token", message: "Invalid pairing token." };
  s.tokenHash = Buffer.alloc(32); // burn
  s.state = "joined";
  return { ok: true, session: s };
}

export function closeSession(s: Session) {
  s.state = "closed";
  clearTimeout(s.timer);
  sessions.delete(s.id);
}

export const sessionCount = () => sessions.size;
