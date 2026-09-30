import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { ClientMessage, type ServerMessage } from "@mobilebridge/protocol";
import { closeSession, createSession, joinSession, sessionCount, type Session } from "./sessions.js";

const MIME: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json", ".json": "application/json" };

export function startServer(port = Number(process.env.PORT ?? 8080), webDist = join(process.cwd(), "../web/dist")) {
  const http = createServer((req, res) => {
    if (req.url === "/healthz") { res.end(JSON.stringify({ ok: true, sessions: sessionCount() })); return; }
    // Serve the built PWA when present (path traversal guarded).
    const url = new URL(req.url ?? "/", "http://x").pathname;
    let file = normalize(join(webDist, url === "/" ? "index.html" : url));
    if (!file.startsWith(webDist) || !existsSync(file)) file = join(webDist, "index.html");
    if (!existsSync(file)) { res.statusCode = 404; res.end("Web client not built"); return; }
    res.setHeader("Content-Type", MIME[extname(file)] ?? "application/octet-stream");
    res.end(readFileSync(file));
  });

  const wss = new WebSocketServer({
    server: http, path: "/ws", maxPayload: 64 * 1024,
    // Set ALLOWED_ORIGINS="https://<user>.github.io" to accept the hosted PWA. Native Android sends no Origin header.
    verifyClient: ({ origin }: { origin?: string }) => {
      const allowed = (process.env.ALLOWED_ORIGINS ?? "").split(",").filter(Boolean);
      return !origin || allowed.length === 0 || allowed.includes(origin);
    },
  });
  const send = (ws: WebSocket | undefined, m: ServerMessage) => ws?.readyState === 1 && ws.send(JSON.stringify(m));

  wss.on("connection", (ws) => {
    let session: Session | undefined;
    let role: "laptop" | "android" | undefined;
    const peer = () => (role === "laptop" ? session?.android : session?.laptop);

    ws.on("message", (raw) => {
      let msg: ClientMessage;
      try { msg = ClientMessage.parse(JSON.parse(raw.toString())); }
      catch { return send(ws, { type: "error", code: "bad_message", message: "Malformed message." }); }

      switch (msg.type) {
        case "create-session": {
          if (session) return;
          const { session: s, token } = createSession(ws, msg.pubkey, msg.client, (x) => { send(x.laptop, { type: "session-expired" }); send(x.android, { type: "session-expired" }); });
          session = s; role = "laptop";
          send(ws, { type: "session-created", sessionId: s.id, token, expiresAt: s.expiresAt });
          break;
        }
        case "join": {
          if (session) return;
          const r = joinSession(msg.sessionId, msg.token);
          if (!r.ok) return send(ws, { type: "error", code: r.code, message: r.message });
          session = r.session; role = "android";
          session.android = ws; session.androidPub = msg.pubkey; session.device = msg.device;
          send(ws, { type: "joined", client: session.client, expiresAt: session.expiresAt, laptopPubkey: session.laptopPub });
          send(session.laptop, { type: "peer-joined", device: msg.device, pubkey: msg.pubkey });
          break;
        }
        case "approve": {
          if (role !== "android" || session?.state !== "joined") return;
          session.state = "approved";
          send(session.laptop, { type: "approved", signature: msg.signature, pubkey: session.androidPub });
          send(ws, { type: "approved" });
          break;
        }
        case "reject": {
          if (role !== "android" || session?.state !== "joined") return;
          send(session.laptop, { type: "rejected" }); send(ws, { type: "rejected" });
          closeSession(session);
          break;
        }
        case "signal": {
          if (session?.state !== "approved") return; // relay only after explicit approval
          send(peer(), { type: "signal", payload: msg.payload });
          break;
        }
      }
    });

    ws.on("close", () => {
      if (!session || session.state === "closed") return;
      send(peer(), { type: "peer-left" });
      if (role === "laptop") closeSession(session);
      else if (session.state !== "approved") { session.android = undefined; closeSession(session); send(session.laptop, { type: "session-expired" }); }
    });
  });

  return new Promise<{ port: number; close: () => Promise<void> }>((resolve) =>
    http.listen(port, () => resolve({
      port: (http.address() as { port: number }).port,
      close: () => new Promise((r) => { wss.clients.forEach((c) => c.terminate()); wss.close(() => http.close(() => r())); }),
    })));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startServer().then((s) => console.log(`MobileBridge signaling on :${s.port}`));
}
