import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { startServer } from "../src/server.js";

let srv: Awaited<ReturnType<typeof startServer>>;
before(async () => { process.env.SESSION_TTL_MS = "1500"; srv = await startServer(0, "/nonexistent"); });
after(() => srv.close());

/** Tiny client that queues messages so tests can await them by type. */
function client() {
  const ws = new WebSocket(`ws://localhost:${srv.port}/ws`);
  const queue: any[] = []; const waiters: Array<(m: any) => void> = [];
  ws.on("message", (d) => { const m = JSON.parse(d.toString()); const w = waiters.shift(); w ? w(m) : queue.push(m); });
  const next = (type: string, ms = 3000) => new Promise<any>((res, rej) => {
    const t = setTimeout(() => rej(new Error(`timeout waiting for ${type}`)), ms);
    const take = (m: any) => { clearTimeout(t); m.type === type ? res(m) : rej(new Error(`expected ${type}, got ${JSON.stringify(m)}`)); };
    const m = queue.shift(); m ? take(m) : waiters.push(take);
  });
  const send = (m: object) => ws.send(JSON.stringify(m));
  const open = new Promise<void>((r) => ws.on("open", () => r()));
  return { ws, send, next, open };
}
const laptopSession = async () => {
  const l = client(); await l.open;
  l.send({ type: "create-session", pubkey: "LAPTOP_KEY", client: { browser: "Chrome", os: "Windows 11" } });
  return { l, created: await l.next("session-created") };
};
const join = async (id: string, token: string) => {
  const a = client(); await a.open;
  a.send({ type: "join", sessionId: id, token, pubkey: "ANDROID_KEY", device: { name: "Pixel 9" } });
  return a;
};

test("happy path: create → join → approve → signal relay", async () => {
  const { l, created } = await laptopSession();
  const a = await join(created.sessionId, created.token);
  assert.deepEqual((await a.next("joined")).client, { browser: "Chrome", os: "Windows 11" });
  const pj = await l.next("peer-joined");
  assert.equal(pj.device.name, "Pixel 9"); assert.equal(pj.pubkey, "ANDROID_KEY");
  a.send({ type: "approve", signature: "sig" });
  assert.equal((await l.next("approved")).signature, "sig");
  await a.next("approved");
  a.send({ type: "signal", payload: { sdp: "offer" } });
  assert.deepEqual((await l.next("signal")).payload, { sdp: "offer" });
});

test("wrong token is rejected and does not burn the session", async () => {
  const { l, created } = await laptopSession();
  const bad = await join(created.sessionId, "nope");
  assert.equal((await bad.next("error")).code, "bad_token");
  const good = await join(created.sessionId, created.token);
  await good.next("joined"); await l.next("peer-joined");
});

test("token is one-time: second scan is refused", async () => {
  const { l, created } = await laptopSession();
  const a = await join(created.sessionId, created.token); await a.next("joined");
  const b = await join(created.sessionId, created.token);
  assert.equal((await b.next("error")).code, "already_used");
});

test("QR expires and later joins are refused", async () => {
  const { l, created } = await laptopSession();
  await l.next("session-expired", 4000);
  const a = await join(created.sessionId, created.token);
  assert.equal((await a.next("error")).code, "not_found");
});

test("signals are not relayed before approval", async () => {
  const { l, created } = await laptopSession();
  const a = await join(created.sessionId, created.token); await a.next("joined");
  a.send({ type: "signal", payload: 1 });
  await assert.rejects(l.next("signal", 400), /timeout|expected/);
});

test("reject closes the session", async () => {
  const { l, created } = await laptopSession();
  const a = await join(created.sessionId, created.token); await a.next("joined"); await l.next("peer-joined");
  a.send({ type: "reject" });
  await l.next("rejected");
});

test("phone is told when a scanned session expires unapproved", async () => {
  const { created } = await laptopSession();
  const a = await join(created.sessionId, created.token); await a.next("joined");
  await a.next("session-expired", 4000);
});
