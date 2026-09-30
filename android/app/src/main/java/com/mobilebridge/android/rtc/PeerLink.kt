package com.mobilebridge.android.rtc

import android.content.Context
import android.os.SystemClock
import com.mobilebridge.android.pairing.DeviceKeys
import org.json.JSONObject
import org.webrtc.DataChannel
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.MediaStream
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.RtpReceiver
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import java.nio.ByteBuffer
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

sealed interface LinkState {
    data object Idle : LinkState
    data object Negotiating : LinkState
    data class Direct(val rttMs: Long?) : LinkState
    data class Failed(val message: String) : LinkState
}

private open class SdpAdapter : SdpObserver {
    override fun onCreateSuccess(desc: SessionDescription?) {}
    override fun onSetSuccess() {}
    override fun onCreateFailure(error: String?) {}
    override fun onSetFailure(error: String?) {}
}

/**
 * Phone side of the direct link. The phone makes the offer and signs it; the laptop's answer must carry a valid
 * signature from the key whose fingerprint was in the QR code. Then both sides ping/pong over a DataChannel.
 */
class PeerLink(
    context: Context,
    private val sessionId: String,
    private val laptopPub: String,
    private val sendSignal: (JSONObject) -> Unit,
    private val onState: (LinkState) -> Unit,
) {
    private val exec = Executors.newSingleThreadScheduledExecutor()
    private var pc: PeerConnection? = null
    private var channel: DataChannel? = null
    private val lock = Any()
    private val localQueue = mutableListOf<IceCandidate>()
    private val remoteQueue = mutableListOf<JSONObject>()
    private var offerSent = false
    private var remoteSet = false
    @Volatile private var closed = false
    @Volatile private var rtt: Long? = null
    private var nextId = 1

    companion object {
        private var inited = false
        private val factory: PeerConnectionFactory by lazy { PeerConnectionFactory.builder().createPeerConnectionFactory() }

        @Synchronized private fun init(context: Context) {
            if (inited) return
            PeerConnectionFactory.initialize(PeerConnectionFactory.InitializationOptions.builder(context.applicationContext).createInitializationOptions())
            inited = true
        }

        // To add a relay later: PeerConnection.IceServer.builder("turn:host:3478").setUsername("...").setPassword("...")
        private val ICE = listOf(
            PeerConnection.IceServer.builder("stun:stun.l.google.com:19302").createIceServer(),
            PeerConnection.IceServer.builder("stun:stun1.l.google.com:19302").createIceServer(),
        )
    }

    init { init(context) }

    fun start() {
        onState(LinkState.Negotiating)
        val cfg = PeerConnection.RTCConfiguration(ICE).apply { sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN }
        val connection = factory.createPeerConnection(cfg, PcObserver()) ?: return fail("Couldn't start the WebRTC engine.")
        pc = connection
        channel = connection.createDataChannel("control", DataChannel.Init()).also { it.registerObserver(ChObserver(it)) }

        connection.createOffer(object : SdpAdapter() {
            override fun onCreateSuccess(desc: SessionDescription?) {
                val offer = desc ?: return
                connection.setLocalDescription(object : SdpAdapter() {
                    override fun onSetSuccess() = sendOffer(offer.description)
                    override fun onSetFailure(error: String?) = fail("Couldn't prepare the connection offer: $error")
                }, offer)
            }
            override fun onCreateFailure(error: String?) = fail("Couldn't create the connection offer: $error")
        }, MediaConstraints())

        exec.schedule({ if (rtt == null && !closed) fail("The direct connection timed out. Check that both devices have internet access.") }, 30, TimeUnit.SECONDS)
        exec.scheduleWithFixedDelay({ ping() }, 2, 2, TimeUnit.SECONDS)
    }

    private fun sendOffer(sdp: String) {
        val sig = DeviceKeys.sign("mobilebridge-sdp:offer:$sessionId:$sdp")
        sendSignal(JSONObject().put("kind", "offer").put("sdp", sdp).put("sig", sig))
        val pending = synchronized(lock) { offerSent = true; localQueue.toList().also { localQueue.clear() } }
        pending.forEach(::sendIce)
    }

    private fun sendIce(c: IceCandidate) = sendSignal(
        JSONObject().put("kind", "ice").put("candidate", c.sdp)
            .put("sdpMid", c.sdpMid ?: JSONObject.NULL).put("sdpMLineIndex", c.sdpMLineIndex)
    )

    /** A signal relayed from the laptop. */
    fun onSignal(p: JSONObject) {
        if (closed) return
        when (p.optString("kind")) {
            "answer" -> {
                val sdp = p.optString("sdp"); val sig = p.optString("sig")
                if (!HandshakeCrypto.verifyLaptop(laptopPub, "mobilebridge-sdp:answer:$sessionId:$sdp", sig))
                    return fail("The laptop's reply failed its identity check, so the connection was refused.")
                pc?.setRemoteDescription(object : SdpAdapter() {
                    override fun onSetSuccess() {
                        val queued = synchronized(lock) { remoteSet = true; remoteQueue.toList().also { remoteQueue.clear() } }
                        queued.forEach(::addRemoteCandidate)
                    }
                    override fun onSetFailure(error: String?) = fail("Couldn't apply the laptop's reply: $error")
                }, SessionDescription(SessionDescription.Type.ANSWER, sdp))
            }
            "ice" -> {
                val ready = synchronized(lock) { if (!remoteSet) { remoteQueue.add(p); false } else true }
                if (ready) addRemoteCandidate(p)
            }
        }
    }

    private fun addRemoteCandidate(p: JSONObject) {
        val mid = if (p.isNull("sdpMid")) null else p.getString("sdpMid")
        pc?.addIceCandidate(IceCandidate(mid, p.optInt("sdpMLineIndex", 0), p.optString("candidate")))
    }

    private fun ping() {
        val ch = channel ?: return
        if (ch.state() != DataChannel.State.OPEN) return
        val m = JSONObject().put("t", "ping").put("id", nextId++).put("ts", SystemClock.elapsedRealtime())
        ch.send(DataChannel.Buffer(ByteBuffer.wrap(m.toString().toByteArray()), false))
    }

    private fun fail(message: String) {
        if (closed) return
        onState(LinkState.Failed(message)); close()
    }

    fun close() {
        if (closed) return
        closed = true
        exec.shutdownNow()
        runCatching { channel?.close(); channel?.dispose() }
        runCatching { pc?.close(); pc?.dispose() }
    }

    private inner class ChObserver(private val ch: DataChannel) : DataChannel.Observer {
        override fun onBufferedAmountChange(previousAmount: Long) {}
        override fun onStateChange() {
            if (closed) return
            when (ch.state()) {
                DataChannel.State.OPEN -> onState(LinkState.Direct(rtt))
                DataChannel.State.CLOSED -> fail("The direct connection closed.")
                else -> {}
            }
        }
        override fun onMessage(buffer: DataChannel.Buffer?) {
            val buf = buffer?.data ?: return
            val bytes = ByteArray(buf.remaining()).also { buf.get(it) }
            val m = runCatching { JSONObject(String(bytes)) }.getOrNull() ?: return
            when (m.optString("t")) {
                "ping" -> ch.send(DataChannel.Buffer(ByteBuffer.wrap(
                    JSONObject().put("t", "pong").put("id", m.get("id")).put("ts", m.get("ts")).toString().toByteArray()), false))
                "pong" -> { rtt = SystemClock.elapsedRealtime() - m.getLong("ts"); onState(LinkState.Direct(rtt)) }
            }
        }
    }

    private inner class PcObserver : PeerConnection.Observer {
        override fun onIceCandidate(c: IceCandidate?) {
            val cand = c ?: return
            val now = synchronized(lock) { if (!offerSent) { localQueue.add(cand); false } else true }
            if (now) sendIce(cand)
        }
        override fun onIceConnectionChange(s: PeerConnection.IceConnectionState?) {
            if (s == PeerConnection.IceConnectionState.FAILED)
                fail("Couldn't open a direct connection to the laptop. The two networks may need a TURN relay.")
        }
        override fun onSignalingChange(s: PeerConnection.SignalingState?) {}
        override fun onIceConnectionReceivingChange(receiving: Boolean) {}
        override fun onIceGatheringChange(s: PeerConnection.IceGatheringState?) {}
        override fun onIceCandidatesRemoved(c: Array<out IceCandidate>?) {}
        override fun onAddStream(s: MediaStream?) {}
        override fun onRemoveStream(s: MediaStream?) {}
        override fun onDataChannel(dc: DataChannel?) {}
        override fun onRenegotiationNeeded() {}
        override fun onAddTrack(receiver: RtpReceiver?, streams: Array<out MediaStream>?) {}
    }
}
