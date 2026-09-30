package com.mobilebridge.android.pairing

import org.json.JSONObject

/** Mirrors QrPayload in packages/protocol. Only https origins are accepted. */
data class QrPayload(val origin: String, val sessionId: String, val token: String, val fingerprint: String) {
    val wsUrl: String get() = origin.trimEnd('/').replaceFirst("https://", "wss://") + "/ws"

    companion object {
        fun parse(raw: String): QrPayload? = runCatching {
            val j = JSONObject(raw)
            require(j.getInt("v") == 1)
            val u = j.getString("u"); require(u.startsWith("https://"))
            QrPayload(u, j.getString("s"), j.getString("t"), j.getString("fp"))
                .also { require(it.sessionId.isNotBlank() && it.token.isNotBlank()) }
        }.getOrNull()
    }
}
