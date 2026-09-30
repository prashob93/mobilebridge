package com.mobilebridge.android.pairing

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONObject
import java.math.BigInteger
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec

/** Device identity: an ECDSA P-256 key pair whose private half never leaves the Android Keystore. */
object DeviceKeys {
    private const val ALIAS = "mobilebridge_device_key"

    private fun store(): KeyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    private fun ensureKey() {
        if (store().containsAlias(ALIAS)) return
        val gen = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore")
        gen.initialize(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_SIGN)
                .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
                .setDigests(KeyProperties.DIGEST_SHA256)
                .build()
        )
        gen.generateKeyPair()
    }

    private fun b64url(b: ByteArray) =
        Base64.encodeToString(b, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)

    private fun fixed32(v: BigInteger): ByteArray {
        val raw = v.toByteArray()
        val src = if (raw.size > 32) raw.copyOfRange(raw.size - 32, raw.size) else raw
        return ByteArray(32).also { System.arraycopy(src, 0, it, 32 - src.size, src.size) }
    }

    /** Public key as a JWK string, the same format the laptop sends. */
    fun publicJwk(): String {
        ensureKey()
        val pub = store().getCertificate(ALIAS).publicKey as ECPublicKey
        return JSONObject()
            .put("kty", "EC").put("crv", "P-256")
            .put("x", b64url(fixed32(pub.w.affineX)))
            .put("y", b64url(fixed32(pub.w.affineY)))
            .toString()
    }

    /** Returns a DER-encoded ECDSA signature (base64url). The laptop converts DER to raw r||s for WebCrypto in M3. */
    fun sign(message: String): String {
        ensureKey()
        val key = store().getKey(ALIAS, null) as PrivateKey
        val sig = Signature.getInstance("SHA256withECDSA").apply { initSign(key); update(message.toByteArray()) }
        return b64url(sig.sign())
    }
}
