# MobileBridge Android (M2: pairing)

1. Open this `android/` folder in Android Studio (File > Open) and wait for Gradle sync.
2. Run on a physical phone (USB debugging on). Emulators can't scan a laptop screen easily.
3. Tap **Connect to Laptop**, scan the QR on your laptop page, then tap **Connect**.

Notes
- Pairing signs `mobilebridge-approve:<sessionId>:<laptopFingerprint>` with a Keystore key (DER signature).
- The QR scanner is Google's Code Scanner, which needs Google Play services and no camera permission.
