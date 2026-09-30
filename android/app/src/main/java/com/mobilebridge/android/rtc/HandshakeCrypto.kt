package com.mobilebridge.android.rtc

import android.util.Base64
import org.json.JSONObject
import java.math.BigInteger
import java.security.AlgorithmParameters
import java.security.KeyFactory
import java.security.MessageDigest
import java.security.PublicKey
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECParameterSpec
import java.security.spec.ECPoint
import java.security.spec.ECPublicKeySpec

/** Verifies the laptop's identity. The laptop signs with WebCrypto (raw r||s); Java expects DER. */
object HandshakeCrypto {
    private const val FLAGS = Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP

    private fun decode(s: String): ByteArray = Base64.decode(s, FLAGS)

    /** Same rule as the laptop: first 22 chars of base64url(SHA-256(public key JWK string)). */
    fun fingerprint(pubJwk: String): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(pubJwk.toByteArray(Charsets.UTF_8))
        return Base64.encodeToString(digest, FLAGS).take(22)
    }

    private fun derInt(v: BigInteger): ByteArray {
        val b = v.toByteArray() // minimal two's complement, already has a leading 0 when the top bit is set
        return byteArrayOf(0x02, b.size.toByte()) + b
    }

    fun rawToDer(raw: ByteArray): ByteArray {
        require(raw.size == 64) { "bad signature length" }
        val body = derInt(BigInteger(1, raw.copyOfRange(0, 32))) + derInt(BigInteger(1, raw.copyOfRange(32, 64)))
        return byteArrayOf(0x30, body.size.toByte()) + body // body is at most 70 bytes, so short-form length is enough
    }

    private fun publicKeyFromJwk(jwk: String): PublicKey {
        val j = JSONObject(jwk)
        val x = BigInteger(1, decode(j.getString("x")))
        val y = BigInteger(1, decode(j.getString("y")))
        val params = AlgorithmParameters.getInstance("EC").apply { init(ECGenParameterSpec("secp256r1")) }
        val spec = params.getParameterSpec(ECParameterSpec::class.java)
        return KeyFactory.getInstance("EC").generatePublic(ECPublicKeySpec(ECPoint(x, y), spec))
    }

    /** True only if [sigRawB64] is a valid signature of [message] by the key in [pubJwk]. */
    fun verifyLaptop(pubJwk: String, message: String, sigRawB64: String): Boolean = runCatching {
        Signature.getInstance("SHA256withECDSA").run {
            initVerify(publicKeyFromJwk(pubJwk))
            update(message.toByteArray(Charsets.UTF_8))
            verify(rawToDer(decode(sigRawB64)))
        }
    }.getOrDefault(false)
}
