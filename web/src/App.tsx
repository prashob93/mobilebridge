import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { usePairing } from "./usePairing";
import type { LinkState } from "./LaptopLink";

function useCountdown(expiresAt?: number) {
  const [left, setLeft] = useState(0);
  useEffect(() => {
    if (!expiresAt) return;
    const tick = () => setLeft(Math.max(0, Math.round((expiresAt - Date.now()) / 1000)));
    tick(); const id = setInterval(tick, 500); return () => clearInterval(id);
  }, [expiresAt]);
  return `${String(Math.floor(left / 60)).padStart(2, "0")}:${String(left % 60).padStart(2, "0")}`;
}

function Qr({ value, dim }: { value: string; dim?: boolean }) {
  const [src, setSrc] = useState("");
  useEffect(() => { QRCode.toDataURL(value, { margin: 1, width: 288, errorCorrectionLevel: "M", color: { dark: "#12202B", light: "#FFFFFF" } }).then(setSrc); }, [value]);
  return <img src={src} alt="Pairing QR code" width={288} height={288} className={`rounded-2xl bg-white p-3 shadow-[0_0_0_2px_#12202B] transition-opacity ${dim ? "opacity-20" : ""}`} />;
}

function Button({ children, onClick, quiet }: { children: React.ReactNode; onClick: () => void; quiet?: boolean }) {
  return <button onClick={onClick} className={`rounded-full px-6 py-3 font-medium ${quiet ? "text-ink shadow-[inset_0_0_0_2px_#12202B]" : "bg-ink text-paper"}`}>{children}</button>;
}

function linkText(l: LinkState) {
  if (l.kind === "direct") return l.rttMs === undefined ? "Direct link open. Measuring speed…" : `Direct link to your phone ✓  ·  round trip ${l.rttMs} ms`;
  if (l.kind === "failed") return l.message;
  return "Opening a direct, encrypted link to your phone…";
}

export default function App() {
  const { state, link, restart } = usePairing();
  const timer = useCountdown(state.kind === "waiting" ? state.expiresAt : undefined);
  const showQr = state.kind === "waiting" || state.kind === "expired";

  return (
    <main className="mx-auto flex min-h-dvh max-w-5xl flex-col px-6 py-8">
      <header className="flex items-center justify-between">
        <span className="text-lg font-bold tracking-tight">MobileBridge</span>
        <span className="flex items-center gap-2 text-sm text-mute" role="status">
          <span className={`size-2.5 rounded-full ${state.kind === "approved" ? "bg-signal" : state.kind === "joined" ? "bg-amber" : "bg-mute/50"}`} />
          {state.kind === "approved" ? "Connected" : state.kind === "joined" ? "Waiting for approval" : "Not connected"}
        </span>
      </header>

      <section className="grid flex-1 items-center gap-12 py-10 md:grid-cols-[1fr_auto]">
        <div className="max-w-md">
          {state.kind === "approved" ? (
            <>
              <h1 className="text-4xl font-bold leading-tight tracking-tight">{state.device.name} is paired.</h1>
              <p className="mt-4 text-lg text-mute">{linkText(link)}</p>
              {link.kind === "direct" && link.path && <p className="mt-2 text-sm text-mute">{link.path}</p>}
              {link.kind === "failed" && <div className="mt-8"><Button onClick={restart}>Start over</Button></div>}
            </>
          ) : state.kind === "joined" ? (
            <>
              <h1 className="text-4xl font-bold leading-tight tracking-tight">Approve on your phone</h1>
              <p className="mt-4 text-lg text-mute">{state.device.name} scanned the code. Tap Connect on the phone to continue.</p>
            </>
          ) : state.kind === "rejected" ? (
            <>
              <h1 className="text-4xl font-bold leading-tight tracking-tight">Connection declined</h1>
              <p className="mt-4 text-lg text-mute">The phone declined this laptop. Generate a new code to try again.</p>
              <div className="mt-8"><Button onClick={restart}>Generate new QR</Button></div>
            </>
          ) : state.kind === "error" ? (
            <>
              <h1 className="text-4xl font-bold leading-tight tracking-tight">Can't start pairing</h1>
              <p className="mt-4 text-lg text-mute">{state.message}</p>
              <div className="mt-8"><Button onClick={restart}>Try again</Button></div>
            </>
          ) : (
            <>
              <h1 className="text-4xl font-bold leading-tight tracking-tight">Connect your Android phone</h1>
              <p className="mt-4 text-lg text-mute">Open MobileBridge on your phone, tap Connect to Laptop, and scan this code.</p>
              {state.kind === "waiting" && <p className="mt-8 text-sm text-amber" role="timer">Code expires in {timer}</p>}
              {state.kind === "expired" && (
                <div className="mt-8"><p className="mb-4 text-amber">This QR code has expired.</p><Button onClick={restart}>Generate new QR</Button></div>
              )}
            </>
          )}
        </div>

        {showQr && (
          <div className="justify-self-center">
            <Qr value={state.kind === "waiting" ? state.qr : "expired"} dim={state.kind === "expired"} />
          </div>
        )}
      </section>
    </main>
  );
}
