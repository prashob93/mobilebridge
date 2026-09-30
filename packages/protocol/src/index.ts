import { z } from "zod";

export const PROTOCOL_VERSION = 1;

/** Contents of the pairing QR. Short-lived; never holds permanent credentials. */
export const QrPayload = z.object({
  v: z.literal(PROTOCOL_VERSION),
  u: z.string(),   // server origin, e.g. https://host:8443
  s: z.string(),   // session id
  t: z.string(),   // one-time pairing token
  fp: z.string(),  // fingerprint of laptop public key (pinned by Android)
});
export type QrPayload = z.infer<typeof QrPayload>;

/**
 * WebRTC handshake messages relayed by the server. `sig` is an ECDSA P-256 / SHA-256 signature (base64url) over
 * `mobilebridge-sdp:<kind>:<sessionId>:<sdp>`. The phone sends DER; the laptop sends raw r||s (WebCrypto format).
 * Because both sides verify it against the keys pinned at pairing, the relay can't swap DTLS fingerprints.
 */
export const SignalPayload = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("offer"), sdp: z.string().max(32_000), sig: z.string().max(512) }),
  z.object({ kind: z.literal("answer"), sdp: z.string().max(32_000), sig: z.string().max(512) }),
  z.object({ kind: z.literal("ice"), candidate: z.string().max(2048), sdpMid: z.string().nullable(), sdpMLineIndex: z.number().int().nullable() }),
]);
export type SignalPayload = z.infer<typeof SignalPayload>;

/** Messages on the peer-to-peer control DataChannel. */
export const ControlMessage = z.discriminatedUnion("t", [
  z.object({ t: z.literal("ping"), id: z.number(), ts: z.number() }),
  z.object({ t: z.literal("pong"), id: z.number(), ts: z.number() }),
]);
export type ControlMessage = z.infer<typeof ControlMessage>;

const ClientInfo = z.object({ browser: z.string().max(64), os: z.string().max(64) });
const DeviceInfo = z.object({ name: z.string().max(64), model: z.string().max(64).optional() });
export type ClientInfo = z.infer<typeof ClientInfo>;
export type DeviceInfo = z.infer<typeof DeviceInfo>;

/** Messages sent to the server. */
export const ClientMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("create-session"), pubkey: z.string().max(2048), client: ClientInfo }),
  z.object({ type: z.literal("join"), sessionId: z.string(), token: z.string(), pubkey: z.string().max(2048), device: DeviceInfo }),
  // `signature` is verified by the laptop in M3 (server only relays it).
  z.object({ type: z.literal("approve"), signature: z.string().max(512) }),
  z.object({ type: z.literal("reject") }),
  z.object({ type: z.literal("signal"), payload: SignalPayload }), // SDP / ICE relay
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

/** Messages sent by the server. */
export const ServerMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("session-created"), sessionId: z.string(), token: z.string(), expiresAt: z.number() }),
  // to Android. laptopPubkey lets the phone check it against the fingerprint in the QR.
  z.object({ type: z.literal("joined"), client: ClientInfo, expiresAt: z.number(), laptopPubkey: z.string() }),
  z.object({ type: z.literal("peer-joined"), device: DeviceInfo, pubkey: z.string() }),      // to laptop
  z.object({ type: z.literal("approved"), signature: z.string().optional(), pubkey: z.string().optional() }),
  z.object({ type: z.literal("rejected") }),
  z.object({ type: z.literal("session-expired") }),
  z.object({ type: z.literal("peer-left") }),
  z.object({ type: z.literal("signal"), payload: SignalPayload }),
  z.object({ type: z.literal("error"), code: z.string(), message: z.string() }),
]);
export type ServerMessage = z.infer<typeof ServerMessage>;
