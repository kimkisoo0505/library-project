import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter_reactive_ble/flutter_reactive_ble.dart';

import '../models/ble_connection.dart';
import '../models/ble_device.dart';
import '../utils/ble_constants.dart';
import '../utils/scan_throttle.dart';

/// Bluetooth adapter state as the app understands it.
enum AdapterState {
  unknown,
  unsupported,
  unauthorized,
  poweredOff,
  locationServicesDisabled,
  ready,
}

/// The only place that talks to flutter_reactive_ble. Screens use this class
/// and the models in `models/`, never the library types directly.
///
/// Holds the app's single BLE connection so it survives screen changes;
/// listeners are notified on every [connection] change.
class BleService extends ChangeNotifier {
  BleService({
    FlutterReactiveBle? ble,
    Duration Function(int attempt) reconnectDelayOf = reconnectDelay,
  }) : _injected = ble,
       _delayOf = reconnectDelayOf;

  /// Wait before each automatic reconnect try (tests shorten it).
  final Duration Function(int attempt) _delayOf;

  static const connectTimeout = Duration(seconds: 10);

  final FlutterReactiveBle? _injected;

  /// Created on first use: constructing FlutterReactiveBle touches the
  /// platform plugin, which must not happen just by building the app.
  late final FlutterReactiveBle _ble = _injected ?? FlutterReactiveBle();

  /// Shared by every screen: Android counts scan starts per app.
  final ScanThrottle _throttle = ScanThrottle();

  // ---------------------------------------------------------------- scanning

  /// Time until another scan may start ([Duration.zero] = now). Check this
  /// before [scan]; a 6th start within 30 s would silently find nothing.
  Duration waitBeforeNextScan() =>
      _throttle.waitBeforeNextStart(DateTime.now());

  /// Emits on Bluetooth on/off and location-service changes.
  /// Note: on Android this does NOT re-emit when the user grants a
  /// permission, so permission state is checked by PermissionManager instead.
  Stream<AdapterState> get adapterState => _ble.statusStream.map(_mapStatus);

  /// Scans until the returned stream's subscription is cancelled.
  ///
  /// [libraryPiOnly] filters by the library service UUID in the Bluetooth
  /// stack itself (cheaper than filtering in Dart).
  /// [requireLocationService] should be true on API 24–30 so that a disabled
  /// location service is reported as an error instead of silently finding
  /// nothing.
  Stream<BleDevice> scan({
    required bool libraryPiOnly,
    required bool requireLocationService,
  }) {
    _throttle.recordStart(DateTime.now());
    return _ble
        .scanForDevices(
          withServices: libraryPiOnly
              ? [Uuid.parse(BleConstants.serviceUuid)]
              : const [],
          scanMode: ScanMode.lowLatency,
          requireLocationServicesEnabled: requireLocationService,
        )
        .map(_mapDevice);
  }

  // -------------------------------------------------------------- connection

  BleConnection _connection = const BleConnection();
  StreamSubscription<ConnectionStateUpdate>? _connSub;
  bool _userDisconnect = false;

  // Step 7: automatic reconnection after an unexpected loss.
  BleDevice? _lastDevice;
  Timer? _reconnectTimer;
  int _attempt = 0;

  /// Reconnect automatically when the link drops unexpectedly
  /// (never after the user's own disconnect).
  bool get autoReconnect => _autoReconnect;
  bool _autoReconnect = true;
  set autoReconnect(bool v) {
    _autoReconnect = v;
    if (!v) _cancelReconnect();
    notifyListeners();
  }

  /// Counters for this app run (shown on the communication screen).
  int connectCount = 0;
  int lossCount = 0;
  int reconnectSuccessCount = 0;

  /// Current connection snapshot (one device at a time).
  BleConnection get connection => _connection;

  void _set(BleConnection c) {
    _connection = c;
    notifyListeners();
  }

  /// Connects to [device]. Any existing connection is closed first.
  /// Progress, success and failure are reported through [connection].
  Future<void> connect(BleDevice device) => _connect(device, retry: false);

  Future<void> _connect(BleDevice device, {required bool retry}) async {
    if (!retry) {
      _cancelReconnect();
      _attempt = 0;
    }
    if (_connSub != null) await _closeQuietly();
    _userDisconnect = false;
    _lastDevice = device;
    _set(
      ConnectionTransitions.connecting(
        device.id,
        device.hasName ? device.name : null,
        attempt: _attempt,
      ),
    );

    _connSub = _ble
        .connectToDevice(id: device.id, connectionTimeout: connectTimeout)
        .listen(
          (u) => _onUpdate(device.id, u),
          onError: (Object e) => _onEnded(
            device.id,
            timedOut: e is TimeoutException,
            error: e is TimeoutException ? null : e.toString(),
          ),
        );
  }

  /// Closes the current link without reporting it as the user's choice.
  Future<void> _closeQuietly() async {
    final sub = _connSub;
    _connSub = null;
    _userDisconnect = true;
    await sub?.cancel();
  }

  /// User-requested disconnect. Cancelling the subscription closes the link.
  /// Also stops a pending automatic reconnection.
  Future<void> disconnect() async {
    if (_reconnectTimer != null || _connection.waitingReconnect) {
      _cancelReconnect();
      if (_connSub == null) {
        _set(
          ConnectionTransitions.reconnectCancelled(_connection, DateTime.now()),
        );
        return;
      }
    }
    _cancelReconnect();
    final sub = _connSub;
    if (sub == null) return;
    _userDisconnect = true;
    _set(ConnectionTransitions.disconnecting(_connection));
    _connSub = null;
    await sub.cancel();
    _set(
      ConnectionTransitions.ended(
        _connection,
        now: DateTime.now(),
        userRequested: true,
      ),
    );
  }

  /// The link looks alive but the Pi stopped answering (keepalive misses):
  /// drop it and let automatic reconnection take over.
  Future<void> forceReconnect(String why) async {
    final id = _connection.deviceId;
    if (id == null || !_connection.isConnected) return;
    final sub = _connSub;
    _connSub = null;
    await sub?.cancel();
    lossCount++;
    _set(
      ConnectionTransitions.ended(
        _connection,
        now: DateTime.now(),
        userRequested: false,
        error: why,
      ),
    );
    _scheduleReconnect();
  }

  void _onUpdate(String id, ConnectionStateUpdate u) {
    if (!_connection.isFor(id) || _connSub == null) return; // stale stream
    switch (u.connectionState) {
      case DeviceConnectionState.connecting:
        break; // already shown as connecting
      case DeviceConnectionState.connected:
        connectCount++;
        if (_attempt > 0) reconnectSuccessCount++;
        _attempt = 0;
        _set(ConnectionTransitions.connected(_connection, DateTime.now()));
        unawaited(_inspect(id));
      case DeviceConnectionState.disconnecting:
        if (!_userDisconnect) {
          _set(ConnectionTransitions.disconnecting(_connection));
        }
      case DeviceConnectionState.disconnected:
        _onEnded(id, error: u.failure?.message);
    }
  }

  void _onEnded(String id, {bool timedOut = false, String? error}) {
    if (!_connection.isFor(id)) return;
    final sub = _connSub;
    _connSub = null;
    unawaited(sub?.cancel());
    if (_userDisconnect) return; // disconnect() reports this itself
    final ended = ConnectionTransitions.ended(
      _connection,
      now: DateTime.now(),
      userRequested: false,
      timedOut: timedOut,
      error: error,
    );
    if (ended.reason == DisconnectReason.lost) lossCount++;
    _set(ended);
    // Reconnect after a loss, and keep trying if a retry itself failed.
    if (ended.reason == DisconnectReason.lost || _attempt > 0) {
      _scheduleReconnect();
    }
  }

  void _scheduleReconnect() {
    final device = _lastDevice;
    if (!autoReconnect || device == null) return;
    _reconnectTimer?.cancel();
    _attempt++;
    if (_attempt > maxReconnectAttempts) {
      _attempt = 0;
      _reconnectTimer = null;
      _set(ConnectionTransitions.reconnectGaveUp(_connection));
      return;
    }
    final delay = _delayOf(_attempt);
    _set(
      ConnectionTransitions.waitingReconnect(
        _connection,
        attempt: _attempt,
        at: DateTime.now().add(delay),
      ),
    );
    _reconnectTimer = Timer(delay, () {
      _reconnectTimer = null;
      unawaited(_connect(device, retry: true));
    });
  }

  void _cancelReconnect() {
    _reconnectTimer?.cancel();
    _reconnectTimer = null;
    _attempt = 0;
  }

  /// After connecting: check the GATT layout, then read Status once.
  Future<void> _inspect(String id) async {
    try {
      final services = await _ble.getDiscoveredServices(id);
      if (!_connection.isFor(id) || !_connection.isConnected) return;
      final gatt = GattCheck.evaluate([
        for (final s in services)
          GattServiceInfo(
            uuid: s.id.toString().toLowerCase(),
            characteristics: [
              for (final c in s.characteristics)
                GattCharInfo(
                  uuid: c.id.toString().toLowerCase(),
                  readable: c.isReadable,
                  writable: c.isWritableWithResponse,
                  writableWithoutResponse: c.isWritableWithoutResponse,
                  notifiable: c.isNotifiable || c.isIndicatable,
                ),
            ],
          ),
      ]);
      _set(ConnectionTransitions.withGatt(_connection, gatt));
      if (gatt.statusOk) await readStatus();
    } catch (e) {
      if (_connection.isFor(id) && _connection.isConnected) {
        _set(
          ConnectionTransitions.withStatus(
            _connection,
            error: '서비스 확인 실패: $e',
            at: DateTime.now(),
          ),
        );
      }
    }
  }

  /// Reads the Status characteristic (`OK,<uptime_s>`). Result goes to
  /// [connection].status / statusError.
  Future<void> readStatus() async {
    final c = _connection;
    final id = c.deviceId;
    if (id == null || !c.isConnected) return;
    try {
      final bytes = await _ble.readCharacteristic(
        QualifiedCharacteristic(
          serviceId: Uuid.parse(BleConstants.serviceUuid),
          characteristicId: Uuid.parse(BleConstants.statusCharUuid),
          deviceId: id,
        ),
      );
      if (!_connection.isFor(id)) return;
      _set(
        ConnectionTransitions.withStatus(
          _connection,
          value: ascii.decode(bytes, allowInvalid: true),
          at: DateTime.now(),
        ),
      );
    } catch (e) {
      if (!_connection.isFor(id)) return;
      _set(
        ConnectionTransitions.withStatus(
          _connection,
          error: '$e',
          at: DateTime.now(),
        ),
      );
    }
  }

  QualifiedCharacteristic _char(String deviceId, String uuid) =>
      QualifiedCharacteristic(
        serviceId: Uuid.parse(BleConstants.serviceUuid),
        characteristicId: Uuid.parse(uuid),
        deviceId: deviceId,
      );

  /// Notifications from the Response characteristic of the connected Pi.
  /// Subscribing enables notifications on the Pi (CCCD write).
  Stream<List<int>> subscribeResponses() {
    final id = _connection.deviceId;
    if (id == null || !_connection.isConnected) {
      return Stream.error(StateError('not connected'));
    }
    return _ble.subscribeToCharacteristic(
      _char(id, BleConstants.responseCharUuid),
    );
  }

  /// Writes one command to the Command characteristic and waits for the
  /// Pi's write acknowledgement (so a failed delivery throws).
  Future<void> writeCommand(List<int> bytes) {
    final id = _connection.deviceId;
    if (id == null || !_connection.isConnected) {
      return Future.error(StateError('not connected'));
    }
    return _ble.writeCharacteristicWithResponse(
      _char(id, BleConstants.commandCharUuid),
      value: bytes,
    );
  }

  /// RSSI of the connected device, measured over the connection.
  /// Throws if not connected or the read fails (caller shows "no value").
  Future<int> readConnectedRssi() {
    final id = _connection.deviceId;
    if (id == null || !_connection.isConnected) {
      return Future.error(StateError('not connected'));
    }
    return _ble.readRssi(id);
  }

  @override
  void dispose() {
    _reconnectTimer?.cancel();
    unawaited(_connSub?.cancel());
    super.dispose();
  }

  // ----------------------------------------------------------------- mapping

  static BleDevice _mapDevice(DiscoveredDevice d) => BleDevice(
    id: d.id,
    name: d.name,
    rssi: d.rssi,
    lastSeen: DateTime.now(),
    serviceUuids: [for (final u in d.serviceUuids) u.toString().toLowerCase()],
    connectable: switch (d.connectable) {
      Connectable.available => true,
      Connectable.unavailable => false,
      Connectable.unknown => null,
    },
  );

  static AdapterState _mapStatus(BleStatus s) => switch (s) {
    BleStatus.unknown => AdapterState.unknown,
    BleStatus.unsupported => AdapterState.unsupported,
    BleStatus.unauthorized => AdapterState.unauthorized,
    BleStatus.poweredOff => AdapterState.poweredOff,
    BleStatus.locationServicesDisabled => AdapterState.locationServicesDisabled,
    BleStatus.ready => AdapterState.ready,
  };
}
