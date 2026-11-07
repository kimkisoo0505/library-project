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
    this.reconnectAttempt = 0,
    this.reconnectAt,
    this.reconnectGaveUp = false,
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

  /// Automatic reconnection (step 7): attempt number of the current or
  /// pending try (0 = not reconnecting), when the next try starts, and
  /// whether it stopped after [maxReconnectAttempts].
  final int reconnectAttempt;
  final DateTime? reconnectAt;
  final bool reconnectGaveUp;

  bool get waitingReconnect =>
      state == AppConnectionState.disconnected && reconnectAt != null;

  bool get isConnected => state == AppConnectionState.connected;

  bool isFor(String id) => deviceId == id;
}

/// Pure transition rules for [BleConnection], kept separate from the BLE
/// library so they can be unit-tested.
class ConnectionTransitions {
  static BleConnection connecting(String id, String? name, {int attempt = 0}) =>
      BleConnection(
        state: AppConnectionState.connecting,
        deviceId: id,
        deviceName: name,
        reconnectAttempt: attempt,
      );

  /// Lost link, next automatic try scheduled at [at].
  static BleConnection waitingReconnect(
    BleConnection c, {
    required int attempt,
    required DateTime at,
  }) => _copy(c, reconnectAttempt: attempt, reconnectAt: at);

  /// Automatic reconnection stopped after too many failures.
  static BleConnection reconnectGaveUp(BleConnection c) =>
      _copy(c, clearReconnectAt: true, gaveUp: true);

  /// The user stopped a pending automatic reconnection.
  static BleConnection reconnectCancelled(BleConnection c, DateTime now) =>
      BleConnection(
        state: AppConnectionState.disconnected,
        deviceId: c.deviceId,
        deviceName: c.deviceName,
        connectedAt: c.connectedAt,
        endedAt: now,
        reason: DisconnectReason.user,
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
      reconnectAttempt: c.reconnectAttempt,
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
    int? reconnectAttempt,
    DateTime? reconnectAt,
    bool clearReconnectAt = false,
    bool? gaveUp,
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
    reconnectAttempt: reconnectAttempt ?? c.reconnectAttempt,
    reconnectAt: clearReconnectAt ? null : (reconnectAt ?? c.reconnectAt),
    reconnectGaveUp: gaveUp ?? c.reconnectGaveUp,
  );
}

/// Automatic reconnection gives up after this many tries in a row.
const int maxReconnectAttempts = 10;

/// Wait before reconnect try [attempt] (1-based): 2, 4, 8, 16, then 30 s.
/// About 3.5 minutes in total for 10 tries.
Duration reconnectDelay(int attempt) {
  final seconds = attempt >= 5 ? 30 : 1 << attempt;
  return Duration(seconds: seconds);
}

/// Parses the Status value `OK,<uptime_s>` into seconds; null if malformed.
int? parseStatusUptime(String? value) {
  if (value == null) return null;
  final m = RegExp(r'^OK,(\d{1,12})$').firstMatch(value);
  return m == null ? null : int.parse(m.group(1)!);
}
