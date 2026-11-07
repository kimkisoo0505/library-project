import 'package:flutter_test/flutter_test.dart';

import 'package:library_ble/app.dart';
import 'package:library_ble/models/ble_device.dart';
import 'package:library_ble/models/scan_results.dart';
import 'package:library_ble/utils/ble_constants.dart';
import 'package:library_ble/utils/scan_throttle.dart';

BleDevice dev(
  String id, {
  String name = '',
  int rssi = -70,
  DateTime? seen,
  List<String> uuids = const [],
}) => BleDevice(
  id: id,
  name: name,
  rssi: rssi,
  lastSeen: seen ?? DateTime(2026, 1, 1, 0, 0, 0),
  serviceUuids: uuids,
  connectable: true,
);

void main() {
  testWidgets('home screen shows disconnected state and scan button', (
    tester,
  ) async {
    await tester.pumpWidget(LibraryBleApp(webHome: false));

    expect(find.text('연결 안 됨'), findsOneWidget);
    expect(find.text(BleConstants.deviceName), findsOneWidget);
    expect(find.text('기기 검색'), findsOneWidget);
  });

  test('GATT UUIDs share the service base and are distinct', () {
    const all = [
      BleConstants.serviceUuid,
      BleConstants.commandCharUuid,
      BleConstants.responseCharUuid,
      BleConstants.statusCharUuid,
    ];
    expect(all.toSet().length, all.length);
    for (final u in all) {
      expect(u.endsWith('-18b4-466c-94a3-08bcf22ef878'), isTrue);
    }
  });

  group('ScanResults', () {
    final now = DateTime(2026, 1, 1, 0, 0, 30);
    final fresh = now.subtract(const Duration(seconds: 2));
    final old = now.subtract(const Duration(seconds: 20));

    test('Pi first, then in-range by RSSI, then lost signals', () {
      final r = ScanResults()
        ..add(dev('weak', name: 'A', rssi: -90, seen: fresh))
        ..add(dev('strong', name: 'B', rssi: -40, seen: fresh))
        ..add(dev('lost', name: 'C', rssi: -30, seen: old))
        ..add(
          dev('pi', rssi: -80, seen: fresh, uuids: [BleConstants.serviceUuid]),
        );
      expect(r.view(now: now, hideUnnamed: false).map((d) => d.id), [
        'pi',
        'strong',
        'weak',
        'lost',
      ]);
    });

    test('hiding unnamed devices never hides the Pi', () {
      final r = ScanResults()
        ..add(dev('anon', seen: fresh))
        ..add(dev('pi', seen: fresh, uuids: [BleConstants.serviceUuid]))
        ..add(dev('named', name: 'X', seen: fresh));
      expect(r.view(now: now, hideUnnamed: true).map((d) => d.id), [
        'pi',
        'named',
      ]);
    });

    test('latest advertisement replaces the previous one', () {
      final r = ScanResults()
        ..add(dev('a', rssi: -80, seen: old))
        ..add(dev('a', rssi: -50, seen: fresh));
      expect(r.length, 1);
      expect(r.view(now: now, hideUnnamed: false).single.rssi, -50);
    });
  });

  test('ScanThrottle allows 5 starts per 30 s', () {
    final t = ScanThrottle();
    final t0 = DateTime(2026, 1, 1);
    for (var i = 0; i < 5; i++) {
      final at = t0.add(Duration(seconds: i));
      expect(t.waitBeforeNextStart(at), Duration.zero);
      t.recordStart(at);
    }
    expect(
      t.waitBeforeNextStart(t0.add(const Duration(seconds: 10))),
      const Duration(seconds: 20),
    );
    expect(
      t.waitBeforeNextStart(t0.add(const Duration(seconds: 30))),
      Duration.zero,
    );
  });
}
