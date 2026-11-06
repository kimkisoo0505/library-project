import '../utils/ble_constants.dart';

/// A BLE device seen during a scan. Independent of the BLE library's types.
///
/// [rssi] is always a value actually reported by the phone's Bluetooth stack
/// for the advertisement received at [lastSeen]; nothing is estimated.
class BleDevice {
  const BleDevice({
    required this.id,
    required this.name,
    required this.rssi,
    required this.lastSeen,
    required this.serviceUuids,
    required this.connectable,
  });

  /// Android: the device's Bluetooth MAC address (may be randomized by the
  /// peer for privacy, so it can change between sessions).
  final String id;

  /// Advertised local name; empty when the device does not advertise one.
  final String name;

  /// Signal strength in dBm (e.g. -60 strong, -90 weak).
  final int rssi;

  /// When the last advertisement (and therefore [rssi]) was received.
  final DateTime lastSeen;

  /// Advertised 128-bit service UUIDs, lowercase.
  final List<String> serviceUuids;

  /// null when the phone cannot tell (older Android).
  final bool? connectable;

  bool get hasName => name.trim().isNotEmpty;

  /// True for the library Raspberry Pi GATT server (see BLE_GATT_SPEC.md).
  bool get isLibraryPi =>
      serviceUuids.contains(BleConstants.serviceUuid) ||
      name == BleConstants.deviceName;

  /// How long ago [rssi] was measured.
  Duration age(DateTime now) => now.difference(lastSeen);
}
