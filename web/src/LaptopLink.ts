import type { ControlMessage, SignalPayload } from "@mobilebridge/protocol";
import { signWithLaptopKey, verifyPhoneSignature } from "./crypto";

export type LinkState =
  | { kind: "idle" }
  | { kind: "negotiating" }
  | { kind: "direct"; rttMs?: number; path?: string }
  | { kind: "failed"; message: string };

export const ICE_SERVERS: RTCIceServer[] = [{ urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }];
// To add a relay later: { urls: "turn:your.host:3478", username: "...", credential: "..." }

interface Deps {
  sessionId: string;
  privateKey: CryptoKey;
  phonePub: string;                 // JWK string pinned at pairing
  send: (p: SignalPayload) => void; // relay via signaling server
  onState: (s: LinkState) => void;
}

/** Laptop side of the direct link. The phone offers; we verify, answer, then ping/pong over the DataChannel. */
export class LaptopLink {
  private pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  private pendingLocal: RTCIceCandidateInit[] = [];
  private answerSent = false;
  private timers: number[] = [];
  private nextId = 1;
  private rtt?: number;
  private path?: string;
  private closed = false;

  constructor(private d: Deps) {
    d.onState({ kind: "negotiating" });
    this.pc.onicecandidate = (e) => {
      if (!e.candidate) return;
      const c = e.candidate.toJSON();
      this.answerSent ? this.sendIce(c) : this.pendingLocal.push(c);
    };
    this.pc.oniceconnectionstatechange = () => {
      const st = this.pc.iceConnectionState;
      if (st === "failed") this.fail("Couldn't open a direct connection to the phone. The two networks may need a TURN relay.");
      else if (st === "disconnected") this.publish();
    };
    this.pc.ondatachannel = (e) => this.attach(e.channel);
    // Fail if nothing connects within 30 seconds.
    this.timers.push(window.setTimeout(() => { if (!this.rtt && !this.closed) this.fail("The direct connection timed out. Check that both devices have internet access."); }, 30_000));
  }

  private sendIce(c: RTCIceCandidateInit) {
    this.d.send({ kind: "ice", candidate: c.candidate ?? "", sdpMid: c.sdpMid ?? null, sdpMLineIndex: c.sdpMLineIndex ?? null });
  }

  private chain: Promise<void> = Promise.resolve();

  /** Signals are handled strictly in order: the phone's ICE candidates arrive right behind its offer,
   *  while the offer is still being verified, and must wait for it instead of being dropped. */
  onSignal(p: SignalPayload) {
    this.chain = this.chain.then(() => this.handle(p));
  }

  private async handle(p: SignalPayload) {
    try {
      if (p.kind === "offer") {
        const ok = await verifyPhoneSignature(this.d.phonePub, `mobilebridge-sdp:offer:${this.d.sessionId}:${p.sdp}`, p.sig);
        if (!ok) return this.fail("The phone's connection offer failed its signature check, so it was ignored.");
        await this.pc.setRemoteDescription({ type: "offer", sdp: p.sdp });
        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);
        const sdp = this.pc.localDescription!.sdp;
        const sig = await signWithLaptopKey(this.d.privateKey, `mobilebridge-sdp:answer:${this.d.sessionId}:${sdp}`);
        this.d.send({ kind: "answer", sdp, sig });
        this.answerSent = true;
        this.pendingLocal.splice(0).forEach((c) => this.sendIce(c));
      } else if (p.kind === "ice" && this.pc.remoteDescription) {
        await this.pc.addIceCandidate({ candidate: p.candidate, sdpMid: p.sdpMid, sdpMLineIndex: p.sdpMLineIndex });
      }
    } catch (e) { this.fail(`Handshake error: ${(e as Error).message}`); }
  }

  private attach(ch: RTCDataChannel) {
    ch.onopen = () => {
      this.publish();
      this.timers.push(window.setInterval(() => {
        if (ch.readyState === "open") ch.send(JSON.stringify({ t: "ping", id: this.nextId++, ts: performance.now() } satisfies ControlMessage));
        this.readPath();
      }, 2000));
    };
    ch.onclose = () => { if (!this.closed) this.fail("The direct connection closed."); };
    ch.onmessage = (e) => {
      let m: ControlMessage; try { m = JSON.parse(String(e.data)); } catch { return; }
      if (m.t === "ping") ch.send(JSON.stringify({ t: "pong", id: m.id, ts: m.ts }));
      else if (m.t === "pong") { this.rtt = Math.round(performance.now() - m.ts); this.publish(); }
    };
  }

  /** Reports whether the selected route is local (host), through STUN (srflx) or relayed. */
  private async readPath() {
    try {
      const stats = await this.pc.getStats();
      let pair: any;
      stats.forEach((r: any) => { if (r.type === "transport" && r.selectedCandidatePairId) pair = stats.get(r.selectedCandidatePairId); });
      if (!pair) stats.forEach((r: any) => { if (r.type === "candidate-pair" && r.nominated && r.state === "succeeded") pair = r; });
      if (!pair) return;
      const l: any = stats.get(pair.localCandidateId), r: any = stats.get(pair.remoteCandidateId);
      const types = [l?.candidateType, r?.candidateType];
      this.path = types.includes("relay") ? "Relayed (TURN)" : types.every((t) => t === "host") ? "Direct on local network" : "Direct over internet";
      this.publish();
    } catch { /* stats are best-effort */ }
  }

  private publish() { if (!this.closed) this.d.onState({ kind: "direct", rttMs: this.rtt, path: this.path }); }
  private fail(message: string) { if (this.closed) return; this.d.onState({ kind: "failed", message }); this.close(); }

  close() {
    this.closed = true;
    this.timers.forEach((t) => { clearTimeout(t); clearInterval(t); });
    this.pc.close();
  }
}
