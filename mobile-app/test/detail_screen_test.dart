import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:library_ble/models/ble_device.dart';
import 'package:library_ble/screens/device_detail_screen.dart';
import 'package:library_ble/services/ble_service.dart';

/// Fake BLE layer: the test pushes advertisements by hand.
class FakeBle extends BleService {
  final adverts = StreamController<BleDevice>.broadcast();
  int scansStarted = 0;

  @override
  Stream<AdapterState> get adapterState => Stream.value(AdapterState.ready);

  @override
  Duration waitBeforeNextScan() => Duration.zero;

  @override
  Stream<BleDevice> scan({
    required bool libraryPiOnly,
    required bool requireLocationService,
  }) {
    scansStarted++;
    return adverts.stream;
  }
}

BleDevice adv(String id, int rssi) => BleDevice(
  id: id,
  name: 'Watch',
  rssi: rssi,
  lastSeen: DateTime.now(),
  serviceUuids: const [],
  connectable: true,
);

void main() {
  testWidgets('shows live measured RSSI of the selected device only', (
    tester,
  ) async {
    final ble = FakeBle();
    await tester.pumpWidget(
      MaterialApp(
        home: DeviceDetailScreen(
          ble: ble,
          device: adv('AA:BB', -80),
          requireLocationService: false,
        ),
      ),
    );
    expect(ble.scansStarted, 1);
    expect(find.text('-80 dBm'), findsOneWidget);

    ble.adverts.add(adv('AA:BB', -58));
    ble.adverts.add(adv('OTHER', -30)); // another device: must be ignored
    await tester.pump(const Duration(milliseconds: 600));

    expect(find.text('-58 dBm'), findsOneWidget);
    expect(find.text('-30 dBm'), findsNothing);
    expect(find.textContaining('실측값 · 신호 매우 강함'), findsOneWidget);

    // Stop → no current value is claimed any more.
    await tester.tap(find.text('측정 중지'));
    await tester.pump(const Duration(milliseconds: 600));
    expect(find.text('— dBm'), findsOneWidget);
    expect(find.text('측정 시작'), findsOneWidget);

    await tester.pumpWidget(const SizedBox()); // dispose timers
  });
}
