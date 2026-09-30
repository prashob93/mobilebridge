package com.mobilebridge.android.pairing

import android.os.Build
import androidx.lifecycle.ViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.concurrent.TimeUnit

sealed interface PairState {
    data object Idle : PairState
    data object Connecting : PairState
    data class Confirm(val browser: String, val os: String) : PairState
    data object Approving : PairState
    data class Connected(val laptop: String) : PairState
    data class Failed(val message: String) : PairState
}

class PairingViewModel : ViewModel() {
    private val _state = MutableStateFlow<PairState>(PairState.Idle)
    val state: StateFlow<PairState> = _state.asStateFlow()

    private val http = OkHttpClient.Builder()
        .connectTimeout(60, TimeUnit.SECONDS) // free hosting can take ~1 minute to wake up
        .pingInterval(20, TimeUnit.SECONDS)
        .build()

    private var socket: WebSocket? = null
    private var session: QrPayload? = null
    @Volatile private var generation = 0     // ignores callbacks from sockets we already closed
    @Volatile private var laptopLabel = "Your laptop"

    fun onScanned(raw: String) {
        val qr = QrPayload.parse(raw)
            ?: return showError("That isn't a MobileBridge QR code. Scan the code shown on your laptop.")
        close()
        session = qr
        _state.value = PairState.Connecting
        val gen = generation
        socket = http.newWebSocket(Request.Builder().url(qr.wsUrl).build(), Listener(qr, gen))
    }

    /** User tapped Connect on the confirmation screen. */
    fun approve() {
        val qr = session ?: return
        if (_state.value !is PairState.Confirm) return
        _state.value = PairState.Approving
        // Signs the session and the laptop key fingerprint from the QR, so approval is bound to this exact laptop.
        val signature = DeviceKeys.sign("mobilebridge-approve:${qr.sessionId}:${qr.fingerprint}")
        socket?.send(JSONObject().put("type", "approve").put("signature", signature).toString())
    }

    /** User tapped Cancel on the confirmation screen. */
    fun decline() {
        socket?.send(JSONObject().put("type", "reject").toString())
        close(); _state.value = PairState.Idle
    }

    fun disconnect() { close(); _state.value = PairState.Idle }
    fun reset() { _state.value = PairState.Idle }

    fun showError(message: String) { close(); _state.value = PairState.Failed(message) }

    private fun close() {
        generation++
        socket?.close(1000, null)
        socket = null
    }

    override fun onCleared() { close(); http.dispatcher.executorService.shutdown() }

    private inner class Listener(val qr: QrPayload, val gen: Int) : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            if (gen != generation) return
            val join = JSONObject()
                .put("type", "join").put("sessionId", qr.sessionId).put("token", qr.token)
                .put("pubkey", DeviceKeys.publicJwk())
                .put("device", JSONObject().put("name", Build.MODEL.take(64)).put("model", Build.MODEL.take(64)))
            webSocket.send(join.toString())
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            if (gen != generation) return
            val m = runCatching { JSONObject(text) }.getOrNull() ?: return
            when (m.optString("type")) {
                "joined" -> {
                    val c = m.getJSONObject("client")
                    val browser = c.optString("browser", "Browser"); val os = c.optString("os", "Unknown OS")
                    laptopLabel = "$browser on $os"
                    _state.value = PairState.Confirm(browser, os)
                }
                "approved" -> _state.value = PairState.Connected(laptopLabel)
                "rejected" -> { close(); _state.value = PairState.Idle }
                "session-expired" -> showError("This QR code expired. Generate a new one on your laptop and scan again.")
                "peer-left" -> showError("The laptop disconnected.")
                "error" -> showError(m.optString("message", "Pairing failed."))
            }
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            if (gen != generation) return
            showError("Couldn't reach the MobileBridge server. Check your internet connection and try again.")
        }
    }
}
