/** Helpers for the signed WebRTC handshake. Android signs with DER-encoded ECDSA; WebCrypto uses raw r||s. */
export const b64urlEncode = (buf: ArrayBuffer | Uint8Array) => {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bin = ""; for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
export const b64urlDecode = (s: string) => {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

/** Fingerprint shown in the QR: first 22 chars of base64url(SHA-256(public key JWK string)). */
export async function fingerprint(pubJwkString: string) {
  return b64urlEncode(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(pubJwkString))).slice(0, 22);
}

/** DER SEQUENCE { INTEGER r, INTEGER s } -> 64-byte raw r||s. */
export function derToRaw(der: Uint8Array): Uint8Array {
  let i = 0;
  if (der[i++] !== 0x30) throw new Error("bad DER");
  if (der[i] & 0x80) i += der[i] & 0x7f; // long-form length
  i++;
  const readInt = () => {
    if (der[i++] !== 0x02) throw new Error("bad DER");
    const len = der[i++];
    let v = der.slice(i, i + len); i += len;
    while (v.length > 32 && v[0] === 0) v = v.slice(1);
    if (v.length > 32) throw new Error("bad DER");
    const out = new Uint8Array(32); out.set(v, 32 - v.length); return out;
  };
  const r = readInt(), s = readInt();
  const raw = new Uint8Array(64); raw.set(r, 0); raw.set(s, 32); return raw;
}

export const importPublic = (jwkString: string) =>
  crypto.subtle.importKey("jwk", JSON.parse(jwkString), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);

/** Verifies a phone signature (DER, base64url) over `message`. */
export async function verifyPhoneSignature(pubJwkString: string, message: string, sigB64: string) {
  try {
    const key = await importPublic(pubJwkString);
    return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, derToRaw(b64urlDecode(sigB64)) as BufferSource, new TextEncoder().encode(message));
  } catch { return false; }
}

export async function signWithLaptopKey(priv: CryptoKey, message: string) {
  return b64urlEncode(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, priv, new TextEncoder().encode(message)));
}
