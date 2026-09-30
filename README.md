# MobileBridge (Android-first MVP)

Status: **M0 + M1 complete** (protocol, signaling server, PWA QR pairing page).

```bash
npm install
npm test               # 6 pairing tests using a simulated Android client
npm run build          # builds web/dist
npm run dev:server     # :8080, also serves web/dist
npm run dev:web        # Vite dev server, proxies /ws to :8080
```

Set `VITE_PUBLIC_URL=https://<laptop-lan-host>:<port>` when building/running the PWA so the QR
contains an address the phone can reach (`localhost` is useless to the phone). The phone needs TLS
in real use; put the server behind a trusted cert (e.g. mkcert or a tunnel).

## Pairing rules enforced by the server
- Token is random, stored only as a hash, and burned on first successful join.
- Sessions expire after 120s (`SESSION_TTL_MS`) unless approved.
- WebRTC signals are relayed only after the phone explicitly approves.

## Not done yet (deliberately)
- The server relays the phone's `approve.signature` but does not verify it. The laptop verifies it
  against the pinned Android key in M3, alongside SDP signing.
- No TLS termination in the Node server; use a reverse proxy.

## Hosting on GitHub
GitHub Pages hosts only the static PWA. The signaling server (`server/`) is a Node WebSocket
process and must run elsewhere (Render, Fly.io, Railway, a VPS), behind HTTPS/WSS.

1. Deploy `server/` and set `ALLOWED_ORIGINS=https://<user>.github.io`.
2. In the repo: Settings -> Pages -> Source: GitHub Actions.
3. In Settings -> Variables, add `SIGNALING_URL=https://<your-server>`.
4. Push to `main`; `.github/workflows/pages.yml` tests, builds and deploys the PWA.

## Android app (M2)
See `android/README.md`. Open the `android/` folder in Android Studio.

## M3: direct link (WebRTC data channel)

After the phone approves, it sends a signed WebRTC offer through the server. The laptop checks the signature against the
phone key pinned at pairing, answers with its own signature, and the phone checks that against the key whose fingerprint was
in the QR. Both sides then exchange ping/pong over a peer-to-peer DataChannel and show the round-trip time.
No video yet (that is M4). STUN servers are set in `web/src/LaptopLink.ts` and `android/.../rtc/PeerLink.kt`;
add a TURN entry in both if a network blocks direct connections.
