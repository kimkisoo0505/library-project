/// BLE GATT constants shared with the Raspberry Pi GATT server.
///
/// Source of truth: `docs/BLE_GATT_SPEC.md`. Change both together.
library;

class BleConstants {
  BleConstants._();

  /// Advertised local name of the Raspberry Pi peripheral.
  static const String deviceName = 'LIB-SEAT-PI';

  static const String serviceUuid = '27fb1000-18b4-466c-94a3-08bcf22ef878';

  /// App -> Pi (Write / Write Without Response).
  static const String commandCharUuid = '27fb1001-18b4-466c-94a3-08bcf22ef878';

  /// Pi -> App (Notify).
  static const String responseCharUuid = '27fb1002-18b4-466c-94a3-08bcf22ef878';

  /// App <- Pi (Read).
  static const String statusCharUuid = '27fb1003-18b4-466c-94a3-08bcf22ef878';

  /// Max bytes per message: fits the default ATT MTU (23) without
  /// relying on MTU negotiation (Android 7 compatibility).
  static const int maxMessageBytes = 20;
}
