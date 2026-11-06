package com.libraryseat.library_ble

import android.bluetooth.BluetoothAdapter
import android.content.ActivityNotFoundException
import android.content.Intent
import android.os.Build
import android.provider.Settings
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

/**
 * Small platform channel for things the BLE / permission plugins do not cover:
 * - Android SDK level (permissions differ below / above API 31)
 * - system dialog to turn Bluetooth on
 * - opening the system location settings (needed for scanning on API 24-30)
 *
 * Nothing here scans, connects or talks to any device.
 */
class MainActivity : FlutterActivity() {
    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "library_ble/device")
            .setMethodCallHandler { call, result ->
                when (call.method) {
                    "getSdkInt" -> result.success(Build.VERSION.SDK_INT)
                    "requestEnableBluetooth" -> result.success(
                        startSafely(Intent(BluetoothAdapter.ACTION_REQUEST_ENABLE)),
                    )
                    "openLocationSettings" -> result.success(
                        startSafely(Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS)),
                    )
                    else -> result.notImplemented()
                }
            }
    }

    /** Returns false instead of crashing if the intent cannot be shown. */
    private fun startSafely(intent: Intent): Boolean =
        try {
            startActivity(intent)
            true
        } catch (e: ActivityNotFoundException) {
            false
        } catch (e: SecurityException) {
            // e.g. BLUETOOTH_CONNECT not granted yet on Android 12+.
            false
        }
}
