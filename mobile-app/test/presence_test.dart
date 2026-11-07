import 'package:flutter_test/flutter_test.dart';

import 'package:library_ble/services/presence_service.dart';

void main() {
  final now = DateTime(2026, 11, 7, 12);
  PresenceSnapshot eval({
    bool connected = true,
    int? rssi = -70,
    Duration age = const Duration(seconds: 3),
    int threshold = -85,
  }) => evaluatePresence(
    piConnected: connected,
    rssi: rssi,
    rssiAt: rssi == null ? null : now.subtract(age),
    now: now,
    threshold: threshold,
    reason: 'test',
  );

  test('in range only when connected, fresh and at/above threshold', () {
    expect(eval().inRange, isTrue);
    expect(eval(rssi: -85).inRange, isTrue, reason: 'equal to threshold');
    expect(eval(rssi: -86).inRange, isFalse);
    expect(eval(connected: false).inRange, isFalse);
  });

  test('missing or stale RSSI never counts (no guessing)', () {
    expect(eval(rssi: null).inRange, isFalse);
    final stale = eval(age: const Duration(seconds: 16));
    expect(stale.inRange, isFalse);
    expect(stale.rssi, isNull, reason: 'stale value is not shown as current');
  });

  test('threshold -100 = any measured connection counts', () {
    expect(eval(rssi: -99, threshold: -100).inRange, isTrue);
  });

  test('snapshot JSON for the web page', () {
    expect(eval().toJson(), {
      'piConnected': true,
      'rssi': -70,
      'inRange': true,
      'threshold': -85,
      'reason': 'test',
    });
  });
}
