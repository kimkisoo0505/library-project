import 'dart:async';

import '../models/ble_device.dart';
import 'ble_service.dart';

/// Where a measured RSSI value came from.
enum RssiSource {
  /// From a received advertisement while scanning (not connected).
  advertisement,

  /// Read from the open connection (`readRssi`).
  connection,
}

/// One RSSI value actually reported by the phone's Bluetooth stack.
/// Never synthesized or interpolated.
class RssiSample {
  const RssiSample(
    this.at,
    this.rssi, [
    this.source = RssiSource.advertisement,
  ]);

  final DateTime at;
  final int rssi;
  final RssiSource source;
}

/// Summary of the real samples inside a time window.
class RssiStats {
  const RssiStats({
    required this.count,
    required this.min,
    required this.max,
    required this.average,
  });

  final int count;
  final int min;
  final int max;

  /// Arithmetic mean of the [count] measured values (labelled as an average
  /// in the UI, never shown as a measurement).
  final double average;
}

/// Keeps a rolling history of measured RSSI samples for one device.
///
/// "No value" is a first-class state: when no advertisement has arrived for
/// [noValueAfter], [currentValue] returns null instead of the stale number.
class RssiTracker {
  RssiTracker({
    this.history = const Duration(seconds: 60),
    this.noValueAfter = const Duration(seconds: 5),
  });

  final Duration history;
  final Duration noValueAfter;
  final List<RssiSample> _samples = [];

  List<RssiSample> get samples => List.unmodifiable(_samples);
  RssiSample? get latest => _samples.isEmpty ? null : _samples.last;

  void add(RssiSample s) {
    _samples.add(s);
    _samples.removeWhere((x) => s.at.difference(x.at) > history);
  }

  void clear() => _samples.clear();

  /// The latest measured value if it is recent enough, else null.
  int? currentValue(DateTime now) {
    final l = latest;
    if (l == null || now.difference(l.at) > noValueAfter) return null;
    return l.rssi;
  }

  List<RssiSample> within(DateTime now, Duration window) =>
      _samples.where((s) => now.difference(s.at) <= window).toList();

  /// Stats of real samples in the last [window]; null when there are none.
  RssiStats? stats(DateTime now, Duration window) {
    final w = within(now, window);
    if (w.isEmpty) return null;
    var min = w.first.rssi, max = w.first.rssi, sum = 0;
    for (final s in w) {
      if (s.rssi < min) min = s.rssi;
      if (s.rssi > max) max = s.rssi;
      sum += s.rssi;
    }
    return RssiStats(
      count: w.length,
      min: min,
      max: max,
      average: sum / w.length,
    );
  }
}

/// Streams RSSI samples for a single device by scanning and keeping only that
/// device's advertisements. Works before connecting (step 4 will add
/// connected-RSSI reads).
class RssiService {
  RssiService(this._ble);

  final BleService _ble;

  Stream<RssiSample> watch({
    required String deviceId,
    required bool requireLocationService,
  }) {
    return _ble
        .scan(
          libraryPiOnly: false,
          requireLocationService: requireLocationService,
        )
        .where((BleDevice d) => d.id == deviceId)
        .map((d) => RssiSample(d.lastSeen, d.rssi));
  }
}
