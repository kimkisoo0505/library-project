import 'package:flutter/services.dart';
import 'package:permission_handler/permission_handler.dart';

/// Result of checking the runtime permissions BLE scanning needs.
enum BlePermissionState {
  granted,

  /// Not granted yet; asking again can show the system dialog.
  denied,

  /// User chose "don't ask again" — only the app settings screen can fix it.
  permanentlyDenied,
}

/// Android version–aware BLE permission handling.
///
/// - Android 7 ~ 11 (API 24–30): location permission, and the system
///   location service must be ON or scans return nothing.
/// - Android 12+ (API 31+): BLUETOOTH_SCAN + BLUETOOTH_CONNECT, no location.
class PermissionManager {
  PermissionManager({MethodChannel? channel})
    : _channel = channel ?? const MethodChannel('library_ble/device');

  final MethodChannel _channel;
  int? _sdkInt;

  /// Android SDK level of this device (e.g. 24 = Android 7.0).
  Future<int> sdkInt() async {
    return _sdkInt ??= await _channel.invokeMethod<int>('getSdkInt') ?? 0;
  }

  /// True when this device uses the legacy (location-based) BLE permissions.
  Future<bool> usesLocationForBle() async => (await sdkInt()) < 31;

  Future<List<Permission>> _required() async {
    return await usesLocationForBle()
        ? [Permission.location]
        : [Permission.bluetoothScan, Permission.bluetoothConnect];
  }

  Future<BlePermissionState> check() async {
    return _combine([for (final p in await _required()) await p.status]);
  }

  /// Shows the system permission dialog(s) for whatever is still missing.
  Future<BlePermissionState> request() async {
    final results = await (await _required()).request();
    return _combine(results.values.toList());
  }

  /// Only meaningful on API 24–30; always true on Android 12+.
  Future<bool> isLocationServiceOn() async {
    if (!await usesLocationForBle()) return true;
    return (await Permission.location.serviceStatus).isEnabled;
  }

  Future<bool> openSettingsForApp() => openAppSettings();

  Future<bool> openLocationSettings() async =>
      await _channel.invokeMethod<bool>('openLocationSettings') ?? false;

  /// Shows the system "turn on Bluetooth?" dialog. Returns false if it
  /// could not be shown (the user can still turn Bluetooth on manually).
  Future<bool> requestEnableBluetooth() async =>
      await _channel.invokeMethod<bool>('requestEnableBluetooth') ?? false;

  static BlePermissionState _combine(List<PermissionStatus> statuses) {
    if (statuses.every((s) => s.isGranted || s.isLimited)) {
      return BlePermissionState.granted;
    }
    if (statuses.any((s) => s.isPermanentlyDenied || s.isRestricted)) {
      return BlePermissionState.permanentlyDenied;
    }
    return BlePermissionState.denied;
  }
}
