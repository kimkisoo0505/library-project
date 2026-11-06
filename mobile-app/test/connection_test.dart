import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:library_ble/models/ble_connection.dart';
import 'package:library_ble/models/ble_device.dart';
import 'package:library_ble/screens/device_detail_screen.dart';
import 'package:library_ble/services/ble_service.dart';
import 'package:library_ble/utils/ble_constants.dart';
import 'package:library_ble/widgets/connection_status.dart';

const piServices = [
  GattServiceInfo(
    uuid: '00001800-0000-1000-8000-00805f9b34fb',
    characteristics: [],
  ),
  GattServiceInfo(
    uuid: BleConstants.serviceUuid,
    characteristics: [
      GattCharInfo(
        uuid: BleConstants.commandCharUuid,
        writable: true,
        writableWithoutResponse: true,
      ),
      GattCharInfo(uuid: BleConstants.responseCharUuid, notifiable: true),
      GattCharInfo(uuid: BleConstants.statusCharUuid, readable: true),
    ],
  ),
];

void main() {
  final t0 = DateTime(2026, 11, 7, 10, 0, 0);

  group('ConnectionTransitions', () {
    final connecting = ConnectionTransitions.connecting('AA', 'LIB-SEAT-PI');

    test('drop while connecting = failed, after connected = lost', () {
      final failed = ConnectionTransitions.ended(
        connecting,
        now: t0,
        userRequested: false,
        error: 'GATT 133',
      );
      expect(failed.reason, DisconnectReason.failed);
      expect(failed.error, 'GATT 133');

      final up = ConnectionTransitions.connected(connecting, t0);
      final lost = ConnectionTransitions.ended(
        up,
        now: t0.add(const Duration(minutes: 1)),
        userRequested: false,
      );
      expect(lost.reason, DisconnectReason.lost);
      expect(lost.state, AppConnectionState.disconnected);
      expect(endedUnexpectedly(lost), isTrue);
    });

    test('user request wins and hides errors; timeout is its own reason', () {
      final up = ConnectionTransitions.connected(connecting, t0);
      final user = ConnectionTransitions.ended(
        up,
        now: t0,
        userRequested: true,
        error: 'x',
      );
      expect(user.reason, DisconnectReason.user);
      expect(user.error, isNull);
      expect(endedUnexpectedly(user), isFalse);

      final to = ConnectionTransitions.ended(
        connecting,
        now: t0,
        userRequested: false,
        timedOut: true,
      );
      expect(to.reason, DisconnectReason.timeout);
      expect(lastEndText(to), contains('시간 초과'));
    });

    test('a new connection clears the previous end reason', () {
      final up = ConnectionTransitions.connected(connecting, t0);
      expect(up.reason, isNull);
      expect(lastEndText(up), isNull);
    });

    test('status value is replaced, error cleared', () {
      var c = ConnectionTransitions.connected(connecting, t0);
      c = ConnectionTransitions.withStatus(c, error: 'boom', at: t0);
      c = ConnectionTransitions.withStatus(c, value: 'OK,5', at: t0);
      expect(c.status, 'OK,5');
      expect(c.statusError, isNull);
    });
  });

  group('GattCheck', () {
    test('library Pi layout is recognised', () {
      final g = GattCheck.evaluate(piServices);
      expect(g.isLibraryPi, isTrue);
      expect(g.serviceCount, 2);
    });

    test('missing service or wrong properties are not the Pi', () {
      expect(GattCheck.evaluate([piServices.first]).serviceFound, isFalse);
      final noNotify = GattCheck.evaluate([
        const GattServiceInfo(
          uuid: BleConstants.serviceUuid,
          characteristics: [
            GattCharInfo(uuid: BleConstants.commandCharUuid, writable: true),
            GattCharInfo(uuid: BleConstants.responseCharUuid, readable: true),
            GattCharInfo(uuid: BleConstants.statusCharUuid, readable: true),
          ],
        ),
      ]);
      expect(noNotify.responseOk, isFalse);
      expect(noNotify.isLibraryPi, isFalse);
    });
  });

  test('parseStatusUptime', () {
    expect(parseStatusUptime('OK,3600'), 3600);
    expect(parseStatusUptime('OK,'), isNull);
    expect(parseStatusUptime('ERR,1'), isNull);
    expect(parseStatusUptime(null), isNull);
  });

  testWidgets(
    'detail screen: connect → Pi verified, RSSI over connection, loss shown',
    (tester) async {
      final ble = FakeConnBle();
      final device = BleDevice(
        id: 'AA',
        name: 'LIB-SEAT-PI',
        rssi: -70,
        lastSeen: DateTime.now(),
        serviceUuids: const [BleConstants.serviceUuid],
        connectable: true,
      );
      await tester.pumpWidget(
        MaterialApp(
          home: DeviceDetailScreen(
            ble: ble,
            device: device,
            requireLocationService: false,
          ),
        ),
      );
      expect(find.text('연결'), findsOneWidget);
      expect(ble.scans, 1, reason: 'advert measurement while not connected');

      await tester.tap(find.text('연결'));
      await tester.pump();
      expect(find.text('연결 중…'), findsOneWidget);

      ble.finishConnect(DateTime.now());
      await tester.pump(const Duration(milliseconds: 1100));
      expect(find.text('연결됨'), findsOneWidget);
      expect(find.text('도서관 라즈베리파이로 확인되었습니다.'), findsOneWidget);
      expect(find.textContaining('Pi 서버 실행 1시간 1분'), findsOneWidget);
      expect(
        find.text('-55 dBm'),
        findsOneWidget,
        reason: 'RSSI read over the connection',
      );
      expect(find.textContaining('연결로 측정 ·'), findsOneWidget);

      ble.loseLink(DateTime.now());
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 600));
      expect(
        find.textContaining('연결이 끊어졌습니다'),
        findsWidgets,
      ); // card + SnackBar
      expect(find.text('연결'), findsOneWidget);
      expect(ble.scans, 2, reason: 'back to advert measurement after loss');

      await tester.pumpWidget(const SizedBox());
    },
  );
}

/// Fake BLE layer that lets the test drive the connection by hand.
class FakeConnBle extends BleService {
  BleConnection _c = const BleConnection();
  int scans = 0;

  @override
  BleConnection get connection => _c;

  void _emit(BleConnection c) {
    _c = c;
    notifyListeners();
  }

  @override
  Stream<AdapterState> get adapterState => Stream.value(AdapterState.ready);

  @override
  Duration waitBeforeNextScan() => Duration.zero;

  @override
  Stream<BleDevice> scan({
    required bool libraryPiOnly,
    required bool requireLocationService,
  }) {
    scans++;
    return const Stream.empty();
  }

  @override
  Future<void> connect(BleDevice device) async =>
      _emit(ConnectionTransitions.connecting(device.id, device.name));

  void finishConnect(DateTime now) {
    var c = ConnectionTransitions.connected(_c, now);
    c = ConnectionTransitions.withGatt(c, GattCheck.evaluate(piServices));
    _emit(ConnectionTransitions.withStatus(c, value: 'OK,3660', at: now));
  }

  void loseLink(DateTime now) =>
      _emit(ConnectionTransitions.ended(_c, now: now, userRequested: false));

  @override
  Future<void> disconnect() async => _emit(
    ConnectionTransitions.ended(_c, now: DateTime.now(), userRequested: true),
  );

  @override
  Future<int> readConnectedRssi() async => -55;

  @override
  Future<void> readStatus() async {}
}
