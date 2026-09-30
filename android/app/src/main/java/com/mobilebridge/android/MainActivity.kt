package com.mobilebridge.android

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.viewModels
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning
import com.mobilebridge.android.pairing.PairState
import com.mobilebridge.android.pairing.PairingViewModel
import com.mobilebridge.android.rtc.LinkState

private val Paper = Color(0xFFEEF2F4)
private val Ink = Color(0xFF12202B)
private val Signal = Color(0xFF0B7A75)
private val Mute = Color(0xFF5B6B77)
private val Amber = Color(0xFFB26A00)

class MainActivity : ComponentActivity() {
    private val vm: PairingViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            MaterialTheme(colorScheme = lightColorScheme(primary = Ink, onPrimary = Paper, background = Paper, onBackground = Ink, surface = Paper, onSurface = Ink)) {
                App(vm, onScan = ::scan)
            }
        }
    }

    private fun scan() {
        val options = GmsBarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).build()
        GmsBarcodeScanning.getClient(this, options).startScan()
            .addOnSuccessListener { vm.onScanned(it.rawValue.orEmpty()) }
            .addOnFailureListener { vm.showError("The QR scanner couldn't start. Make sure Google Play services is up to date.") }
        // Cancelling the scanner is not an error: the user simply stays on the current screen.
    }
}

@Composable
private fun App(vm: PairingViewModel, onScan: () -> Unit) {
    val state by vm.state.collectAsStateWithLifecycle()
    val link by vm.link.collectAsStateWithLifecycle()
    Surface(Modifier.fillMaxSize(), color = Paper) {
        Column(Modifier.fillMaxSize().systemBarsPadding().padding(28.dp)) {
            Text("MobileBridge", fontSize = 18.sp, fontWeight = FontWeight.Bold)
            Spacer(Modifier.weight(1f))
            when (val s = state) {
                PairState.Idle -> {
                    Heading("Connect your phone to your laptop")
                    Body("Open MobileBridge on your laptop, then scan the QR code it shows.")
                    Spacer(Modifier.height(28.dp))
                    Button(onClick = onScan) { Text("Connect to Laptop") }
                }
                PairState.Connecting -> Waiting("Contacting the server…", "The first connection can take up to a minute.")
                is PairState.Confirm -> {
                    Heading("Connect to this laptop?")
                    Text("${s.browser} on ${s.os}", fontSize = 20.sp, color = Signal, fontWeight = FontWeight.Medium)
                    Spacer(Modifier.height(12.dp))
                    Body("Only continue if you just opened MobileBridge on your own laptop.")
                    Spacer(Modifier.height(28.dp))
                    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        OutlinedButton(onClick = vm::decline) { Text("Cancel") }
                        Button(onClick = vm::approve) { Text("Connect") }
                    }
                }
                PairState.Approving -> Waiting("Waiting for your laptop…", null)
                is PairState.Connected -> {
                    Heading("Connected ✓")
                    Body("${s.laptop} is paired with this phone.")
                    Spacer(Modifier.height(12.dp))
                    when (val l = link) {
                        is LinkState.Direct -> Text(if (l.rttMs == null) "Direct link open. Measuring speed…" else "Direct link ✓  ·  round trip ${l.rttMs} ms", fontSize = 16.sp, color = Signal, fontWeight = FontWeight.Medium)
                        is LinkState.Failed -> Text(l.message, fontSize = 16.sp, color = Amber)
                        else -> Body("Opening a direct, encrypted link to your laptop…")
                    }
                    Spacer(Modifier.height(28.dp))
                    OutlinedButton(onClick = vm::disconnect) { Text("Disconnect") }
                }
                is PairState.Failed -> {
                    Heading("Couldn't connect")
                    Text(s.message, fontSize = 16.sp, color = Amber)
                    Spacer(Modifier.height(28.dp))
                    Button(onClick = { vm.reset(); onScan() }) { Text("Scan again") }
                }
            }
            Spacer(Modifier.weight(1f))
            Text(
                if (state is PairState.Connected) "Connection: Connected" else "Connection: Offline",
                fontSize = 14.sp, color = Mute, modifier = Modifier.align(Alignment.CenterHorizontally)
            )
        }
    }
}

@Composable private fun Heading(t: String) { Text(t, fontSize = 30.sp, lineHeight = 36.sp, fontWeight = FontWeight.Bold); Spacer(Modifier.height(12.dp)) }
@Composable private fun Body(t: String) { Text(t, fontSize = 16.sp, lineHeight = 23.sp, color = Mute) }
@Composable private fun Waiting(title: String, hint: String?) {
    CircularProgressIndicator(color = Signal); Spacer(Modifier.height(20.dp))
    Heading(title); hint?.let { Body(it) }
}
