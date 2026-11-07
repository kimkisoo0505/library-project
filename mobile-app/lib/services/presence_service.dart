import 'dart:async';

import 'package:flutter/foundation.dart';

import '../models/ble_connection.dart';
import '../models/ble_device.dart';
import '../utils/permission_manager.dart';
import 'ble_service.dart';

/// What the app tells the kiosk web page about Bluetooth presence.
class PresenceSnapshot {
  const PresenceSnapshot({
    required this.piConnected,
    required this.rssi,
    required this.inRange,
    required this.threshold,
    required this.reason,
  });

  final bool piConnected;

  /// Latest RSSI measured over the connection; null if none recent.
  final int? rssi;

  /// Connected to the library Pi and the recent RSSI is at or above
  /// [threshold]. Only then does the web page report presence.
  final bool inRange;
  final int threshold;

  /// Short human-readable state ("Pi 검색 중", "권한 필요", ...).
  final String reason;

  Map<String, Object?> toJson() => {
    'piConnected': piConnected,
    'rssi': rssi,
    'inRange': inRange,
    'threshold': threshold,
    'reason': reason,
  };
}

/// Pure rule: in range = connected to the Pi, a measured RSSI no older than
/// [maxAge], and that RSSI >= [threshold]. A stale or missing value is
/// never treated as "in range".
PresenceSnapshot evaluatePresence({
  required bool piConnected,
  required int? rssi,
  required DateTime? rssiAt,
  required DateTime now,
  required int threshold,
  required String reason,
  Duration maxAge = const Duration(seconds: 15),
}) {
  final fresh =
      rssi != null && rssiAt != null && now.difference(rssiAt) <= maxAge;
  return PresenceSnapshot(
    piConnected: piConnected,
    rssi: fresh ? rssi : null,
    inRange: piConnected && fresh && rssi >= threshold,
    threshold: threshold,
    reason: reason,
  );
}

/// Keeps the phone connected to the library Pi while the student is seated
/// in a room that has one, measures RSSI, and pushes [PresenceSnapshot]s to
/// the web page (which reports presence to the server with its own session).
///
/// Foreground only for now: [pause] / [resume] follow the app lifecycle.
class PresenceService extends ChangeNotifier {
  PresenceService(this._ble, this._permissions) {
    _ble.addListener(_onBleChanged);
  }

  /// Signal threshold (dBm). Not decided yet by the library — adjustable
  /// from the app menu; -100 means "any connection counts".
  static const thresholdChoices = [-70, -80, -85, -90, -100];
  static const defaultThreshold = -85;
  static const rssiPollInterval = Duration(seconds: 5);
  static const pushInterval = Duration(seconds: 10);
  static const searchDuration = Duration(seconds: 10);
  static const retryAfterNotFound = Duration(seconds: 30);

  final BleService _ble;
  final PermissionManager _permissions;

  /// Set by the WebView screen: delivers a snapshot to the page.
  void Function(PresenceSnapshot snapshot)? onSnapshot;

  int _threshold = defaultThreshold;
  int get threshold => _threshold;
  set threshold(int v) {
    _threshold = v;
    _push();
  }

  bool _wanted = false;
  bool _paused = false;
  bool _connectedByUs = false;
  bool _searching = false;
  int? _rssi;
  DateTime? _rssiAt;
  String _reason = '대기';
  Timer? _pollTimer;
  Timer? _pushTimer;
  Timer? _retryTimer;
  StreamSubscription<BleDevice>? _scanSub;

  /// The web page says the student is seated in a room with a Pi.
  bool get wanted => _wanted;
  bool get active => _wanted && !_paused;

  PresenceSnapshot get snapshot => evaluatePresence(
    piConnected: _piConnected,
    rssi: _rssi,
    rssiAt: _rssiAt,
    now: DateTime.now(),
    threshold: _threshold,
    reason: _reason,
  );

  bool get _piConnected =>
      _ble.connection.isConnected &&
      (_ble.connection.gatt?.isLibraryPi ?? false);

  /// From the web page (state message).
  void setWanted(bool wanted) {
    if (wanted == _wanted) return;
    _wanted = wanted;
    _apply();
  }

  void pause() {
    _paused = true;
    _apply();
  }

  void resume() {
    _paused = false;
    _apply();
  }

  void _apply() {
    if (active) {
      _pollTimer ??= Timer.periodic(rssiPollInterval, (_) => _pollRssi());
      _pushTimer ??= Timer.periodic(pushInterval, (_) => _push());
      unawaited(_ensureConnected());
    } else {
      _stopTimers();
      _stopScan();
      _rssi = null;
      _rssiAt = null;
      _reason = _wanted ? '앱이 화면에 없음' : '대기';
      // Only drop a link we opened ourselves (not one from the BLE test screens).
      if (!_wanted && _connectedByUs) {
        _connectedByUs = false;
        unawaited(_ble.disconnect());
      }
    }
    _push();
  }

  void _onBleChanged() {
    if (!active) return;
    if (!_ble.connection.isConnected) {
      _rssi = null;
      _rssiAt = null;
    }
    final c = _ble.connection;
    if (c.isConnected) {
      _reason = _piConnected ? '연결됨' : '도서관 Pi가 아닌 기기에 연결됨';
    } else if (c.waitingReconnect || c.state == AppConnectionState.connecting) {
      _reason = '재연결 중';
    } else if (!_searching && _retryTimer == null) {
      unawaited(_ensureConnected());
    }
    _push();
  }

  Future<void> _ensureConnected() async {
    if (!active || _searching) return;
    final c = _ble.connection;
    if (c.isConnected ||
        c.waitingReconnect ||
        c.state == AppConnectionState.connecting) {
      return;
    }

    if (await _permissions.check() != BlePermissionState.granted) {
      if (await _permissions.request() != BlePermissionState.granted) {
        _setReason('블루투스 권한 필요');
        return;
      }
    }
    if (!await _permissions.isLocationServiceOn()) {
      _setReason('위치(GPS)를 켜 주세요');
      return;
    }
    if (_ble.waitBeforeNextScan() > Duration.zero) {
      _scheduleRetry(const Duration(seconds: 10));
      return;
    }

    _searching = true;
    _setReason('도서관 Pi 검색 중');
    final sdk = await _permissions.sdkInt();
    final found = Completer<BleDevice?>();
    _scanSub = _ble
        .scan(libraryPiOnly: true, requireLocationService: sdk < 31)
        .listen(
          (d) {
            if (!found.isCompleted) found.complete(d);
          },
          onError: (Object e) {
            if (!found.isCompleted) found.complete(null);
          },
        );
    final device = await found.future.timeout(
      searchDuration,
      onTimeout: () => null,
    );
    _stopScan();
    _searching = false;
    if (!active) return;
    if (device == null) {
      _setReason('도서관 Pi를 찾지 못함 (블루투스 범위 밖)');
      _scheduleRetry(retryAfterNotFound);
      return;
    }
    _connectedByUs = true;
    _setReason('연결 중');
    await _ble.connect(device);
  }

  void _scheduleRetry(Duration after) {
    _retryTimer?.cancel();
    _retryTimer = Timer(after, () {
      _retryTimer = null;
      unawaited(_ensureConnected());
    });
  }

  Future<void> _pollRssi() async {
    if (!_piConnected) return;
    try {
      _rssi = await _ble.readConnectedRssi();
      _rssiAt = DateTime.now();
    } catch (_) {
      // No value this time; a stale value stops counting as "in range".
    }
    notifyListeners();
  }

  void _setReason(String r) {
    _reason = r;
    _push();
  }

  void _push() {
    onSnapshot?.call(snapshot);
    notifyListeners();
  }

  void _stopScan() {
    unawaited(_scanSub?.cancel());
    _scanSub = null;
    _searching = false;
  }

  void _stopTimers() {
    _pollTimer?.cancel();
    _pollTimer = null;
    _pushTimer?.cancel();
    _pushTimer = null;
    _retryTimer?.cancel();
    _retryTimer = null;
  }

  @override
  void dispose() {
    _ble.removeListener(_onBleChanged);
    _stopTimers();
    _stopScan();
    super.dispose();
  }
}
