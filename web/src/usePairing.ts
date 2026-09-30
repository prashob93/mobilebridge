import { useCallback, useEffect, useRef, useState } from "react";
import { QrPayload, ServerMessage, type DeviceInfo, type SignalPayload } from "@mobilebridge/protocol";
import { fingerprint, verifyPhoneSignature } from "./crypto";
import { LaptopLink, type LinkState } from "./LaptopLink";

export type PairState =
  | { kind: "connecting" }
  | { kind: "waiting"; qr: string; expiresAt: number }
  | { kind: "joined"; device: DeviceInfo }
  | { kind: "approved"; device: DeviceInfo }
  | { kind: "expired" }
  | { kind: "rejected" }
  | { kind: "error"; message: string };

/** Signaling server origin. Set VITE_SIGNALING_URL (e.g. https://signal.example.com) when the PWA is hosted separately, such as on GitHub Pages. */
export const signalingOrigin = () => (import.meta.env.VITE_SIGNALING_URL as string | undefined)?.replace(/\/$/, "") ?? location.origin;
const signalingWsUrl = () => signalingOrigin().replace(/^http/, "ws") + "/ws";

export function describeBrowser() {
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /Windows NT 10/.test(ua) ? "Windows" : /Mac OS X/.test(ua) ? "macOS" : /CrOS/.test(ua) ? "ChromeOS" : /Linux/.test(ua) ? "Linux" : "Unknown OS";
  return { browser, os };
}

/** Owns one pairing attempt; call `restart` to get a fresh QR. */
export function usePairing() {
  const [state, setState] = useState<PairState>({ kind: "connecting" });
  const [attempt, setAttempt] = useState(0);
  const [link, setLink] = useState<LinkState>({ kind: "idle" });
  const ws = useRef<WebSocket | null>(null);

  useEffect(() => {
    let cancelled = false;
    let device: DeviceInfo | undefined;
    let phonePub: string | undefined;
    let sessionId = "", fp = "";
    let privateKey: CryptoKey | undefined;
    let rtc: LaptopLink | undefined;
    let verifying = false;
    const early: SignalPayload[] = []; // offers can arrive while the approval signature is still being verified
    setState({ kind: "connecting" });
    setLink({ kind: "idle" });
    const socket = new WebSocket(signalingWsUrl());
    ws.current = socket;

    socket.onopen = async () => {
      try {
        // Non-extractable private key: it stays in the browser and is used to sign the WebRTC handshake in M3.
        const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
        const pub = JSON.stringify(await crypto.subtle.exportKey("jwk", pair.publicKey));
        fp = await fingerprint(pub);
        privateKey = pair.privateKey;
        if (cancelled) return;
        socket.send(JSON.stringify({ type: "create-session", pubkey: pub, client: describeBrowser() }));
      } catch { setState({ kind: "error", message: "This browser can't create the pairing keys MobileBridge needs. Use the latest Chrome or Edge over HTTPS." }); }
    };

    socket.onmessage = async (ev) => {
      const parsed = ServerMessage.safeParse(JSON.parse(ev.data));
      if (!parsed.success) return;
      const m = parsed.data;
      if (m.type === "session-created") {
        sessionId = m.sessionId;
        const payload: QrPayload = { v: 1, u: signalingOrigin(), s: m.sessionId, t: m.token, fp };
        setState({ kind: "waiting", qr: JSON.stringify(payload), expiresAt: m.expiresAt });
      } else if (m.type === "peer-joined") { device = m.device; phonePub = m.pubkey; setState({ kind: "joined", device }); }
      else if (m.type === "approved" && device && !rtc && !verifying) {
        verifying = true;
        // The phone signed "this session + this laptop's key fingerprint" with the key it presented when it joined.
        const ok = !!m.signature && m.pubkey === phonePub && !!phonePub &&
          await verifyPhoneSignature(phonePub, `mobilebridge-approve:${sessionId}:${fp}`, m.signature);
        if (cancelled) return;
        if (!ok) { setState({ kind: "error", message: "The phone's approval could not be verified, so the connection was refused." }); socket.close(); return; }
        setState({ kind: "approved", device });
        rtc = new LaptopLink({
          sessionId, privateKey: privateKey!, phonePub: phonePub!,
          send: (payload) => socket.send(JSON.stringify({ type: "signal", payload })),
          onState: setLink,
        });
        early.splice(0).forEach((p) => void rtc!.onSignal(p));
      }
      else if (m.type === "signal") { if (rtc) void rtc.onSignal(m.payload); else early.push(m.payload); }
      else if (m.type === "peer-left") { rtc?.close(); setLink({ kind: "failed", message: "The phone disconnected." }); }
      else if (m.type === "rejected") setState({ kind: "rejected" });
      else if (m.type === "session-expired") setState({ kind: "expired" });
      else if (m.type === "error") setState({ kind: "error", message: m.message });
    };
    socket.onclose = () => { if (!cancelled) setState((s) => (s.kind === "approved" || s.kind === "expired" || s.kind === "rejected" ? s : { kind: "error", message: "Lost the connection to the MobileBridge server." })); };
    return () => { cancelled = true; rtc?.close(); socket.close(); };
  }, [attempt]);

  const restart = useCallback(() => setAttempt((n) => n + 1), []);
  return { state, link, restart };
}
