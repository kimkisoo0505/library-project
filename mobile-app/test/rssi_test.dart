import 'package:flutter_test/flutter_test.dart';

import 'package:library_ble/services/rssi_service.dart';
import 'package:library_ble/widgets/signal_indicator.dart';

void main() {
  final t0 = DateTime(2026, 1, 1, 12);
  DateTime at(num s) => t0.add(Duration(milliseconds: (s * 1000).round()));

  group('RssiTracker', () {
    test(
      'current value becomes null (not stale number) after 5 s without ads',
      () {
        final t = RssiTracker()..add(RssiSample(at(0), -60));
        expect(t.currentValue(at(4.9)), -60);
        expect(t.currentValue(at(5.1)), isNull);
        expect(
          t.latest!.rssi,
          -60,
          reason: 'last real value is still available, labelled',
        );
      },
    );

    test('no samples → no value and no stats', () {
      final t = RssiTracker();
      expect(t.currentValue(at(0)), isNull);
      expect(t.stats(at(0), const Duration(seconds: 5)), isNull);
    });

    test('stats use only real samples inside the window', () {
      final t = RssiTracker()
        ..add(RssiSample(at(0), -90)) // outside 5 s window at t=10
        ..add(RssiSample(at(6), -60))
        ..add(RssiSample(at(8), -70))
        ..add(RssiSample(at(10), -65));
      final s = t.stats(at(10), const Duration(seconds: 5))!;
      expect(s.count, 3);
      expect(s.min, -70);
      expect(s.max, -60);
      expect(s.average, closeTo(-65, 1e-9));
    });

    test('history keeps only the last 60 s', () {
      final t = RssiTracker()
        ..add(RssiSample(at(0), -50))
        ..add(RssiSample(at(61), -55));
      expect(t.samples.map((s) => s.rssi), [-55]);
    });
  });

  test('signal level bands', () {
    expect([-50, -60, -61, -70, -75, -80, -85, -90, -95].map(signalLevel), [
      4,
      4,
      3,
      3,
      2,
      2,
      1,
      1,
      0,
    ]);
    expect(signalLabel(-55), '매우 강함');
    expect(signalLabel(-99), '매우 약함');
  });
}
