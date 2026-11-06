import '../utils/ble_constants.dart';

/// App-level connection state (independent of the BLE library's types).
enum AppConnectionState { disconnected, connecting, connected, disconnecting }

/// Why the last connection ended. Distinguishes a user's choice from a loss.
enum DisconnectReason {
  /// The user pressed "연결 해제".
  user,

  /// Was connected, then the link dropped (out of range, Pi off, ...).
  lost,

  /// Connecting did not finish within the timeout.
  timeout,

  /// Connecting failed with an error from the Bluetooth stack.
  failed,
}

/// One GATT characteristic as discovered on the peer.
class GattCharInfo {
  const GattCharInfo({
    required this.uuid,
    this.readable = false,
    this.writable = false,
    this.writableWithoutResponse = false,
    this.notifiable = false,
  });

  final String uuid; // lowercase
  final bool readable, writable, writableWithoutResponse, notifiable;
}

class GattServiceInfo {
  const GattServiceInfo({required this.uuid, required this.characteristics});

  final String uuid; // lowercase
  final List<GattCharInfo> characteristics;
}

/// Does the connected peer expose the library service as specified in
/// docs/BLE_GATT_SPEC.md?
class GattCheck {
  const GattCheck({
    required this.serviceFound,
    required this.commandOk,
    required this.responseOk,
    required this.statusOk,
    required this.serviceCount,
  });

  final bool serviceFound, commandOk, responseOk, statusOk;
  final int serviceCount;

  bool get isLibraryPi => serviceFound && commandOk && responseOk && statusOk;

  static GattCheck evaluate(List<GattServiceInfo> services) {
    GattServiceInfo? svc;
    for (final s in services) {
      if (s.uuid == BleConstants.serviceUuid) svc = s;
    }
    GattCharInfo? find(String uuid) {
      for (final c in svc?.characteristics ?? const <GattCharInfo>[]) {
        if (c.uuid == uuid) return c;
      }
      return null;
    }

    final cmd = find(BleConstants.commandCharUuid);
    final resp = find(BleConstants.responseCharUuid);
    final status = find(BleConstants.statusCharUuid);
    return GattCheck(
      serviceFound: svc != null,
      commandOk: cmd != null && (cmd.writable || cmd.writableWithoutResponse),
      responseOk: resp != null && resp.notifiable,
      statusOk: status != null && status.readable,
      serviceCount: services.length,
    );
  }
}

/// Snapshot of the (single) BLE connection the app manages.
class BleConnection {
  const BleConnection({
    this.state = AppConnectionState.disconnected,
    this.deviceId,
    this.deviceName,
    this.connectedAt,
    this.endedAt,
    this.reason,
    this.error,
    this.gatt,
    this.status,
    this.statusReadAt,
    this.statusError,
  });

  final AppConnectionState state;
  final String? deviceId;
  final String? deviceName;
  final DateTime? connectedAt;

  /// When the last connection (or attempt) ended, and why.
  final DateTime? endedAt;
  final DisconnectReason? reason;
  final String? error;

  /// Result of service discovery; null until done.
  final GattCheck? gatt;

  /// Raw value read from the Status characteristic (e.g. "OK,3600").
  final String? status;
  final DateTime? statusReadAt;
  final String? statusError;

  bool get isConnected => state == AppConnectionState.connected;

  bool isFor(String id) => deviceId == id;
}

/// Pure transition rules for [BleConnection], kept separate from the BLE
/// library so they can be unit-tested.
class ConnectionTransitions {
  static BleConnection connecting(String id, String? name) => BleConnection(
    state: AppConnectionState.connecting,
    deviceId: id,
    deviceName: name,
  );

  static BleConnection connected(BleConnection c, DateTime now) =>
      BleConnection(
        state: AppConnectionState.connected,
        deviceId: c.deviceId,
        deviceName: c.deviceName,
        connectedAt: now,
      );

  static BleConnection withGatt(BleConnection c, GattCheck gatt) =>
      _copy(c, gatt: gatt);

  static BleConnection withStatus(
    BleConnection c, {
    String? value,
    String? error,
    required DateTime at,
  }) => _copy(
    c,
    status: value,
    statusError: error,
    statusReadAt: at,
    keepStatus: false,
  );

  static BleConnection disconnecting(BleConnection c) =>
      _copy(c, state: AppConnectionState.disconnecting);

  /// The link is gone. [userRequested] wins over everything else; otherwise
  /// a drop after being connected is a loss, and a drop while still
  /// connecting is a failure.
  static BleConnection ended(
    BleConnection c, {
    required DateTime now,
    required bool userRequested,
    bool timedOut = false,
    String? error,
  }) {
    final DisconnectReason reason;
    if (userRequested) {
      reason = DisconnectReason.user;
    } else if (timedOut) {
      reason = DisconnectReason.timeout;
    } else if (c.connectedAt != null) {
      reason = DisconnectReason.lost;
    } else {
      reason = DisconnectReason.failed;
    }
    return BleConnection(
      state: AppConnectionState.disconnected,
      deviceId: c.deviceId,
      deviceName: c.deviceName,
      connectedAt: c.connectedAt,
      endedAt: now,
      reason: reason,
      error: userRequested ? null : error,
    );
  }

  static BleConnection _copy(
    BleConnection c, {
    AppConnectionState? state,
    GattCheck? gatt,
    String? status,
    String? statusError,
    DateTime? statusReadAt,
    bool keepStatus = true,
  }) => BleConnection(
    state: state ?? c.state,
    deviceId: c.deviceId,
    deviceName: c.deviceName,
    connectedAt: c.connectedAt,
    endedAt: c.endedAt,
    reason: c.reason,
    error: c.error,
    gatt: gatt ?? c.gatt,
    status: keepStatus ? c.status : status,
    statusReadAt: keepStatus ? c.statusReadAt : statusReadAt,
    statusError: keepStatus ? c.statusError : statusError,
  );
}

/// Parses the Status value `OK,<uptime_s>` into seconds; null if malformed.
int? parseStatusUptime(String? value) {
  if (value == null) return null;
  final m = RegExp(r'^OK,(\d{1,12})$').firstMatch(value);
  return m == null ? null : int.parse(m.group(1)!);
}
