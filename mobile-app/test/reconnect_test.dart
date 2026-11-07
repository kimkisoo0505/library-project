// Reconnection tests run in real time with millisecond delays: under
// simulated time (testWidgets / fake_async) a StreamSubscription.cancel()
// never completes in this Dart version, which would hang the test.
import 'dart:async';

import 'package:flutter_reactive_ble/flutter_reactive_ble.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:library_ble/models/ble_connection.dart';
import 'package:library_ble/models/ble_device.dart';
import 'package:library_ble/services/ble_service.dart';

/// Fake of the BLE library: each connectToDevice() call gets its own
/// controller that the test drives by hand.
class FakeReactiveBle extends Fake implements FlutterReactiveBle {
  final attempts = <StreamController<ConnectionStateUpdate>>[];

  StreamController<ConnectionStateUpdate> get current => attempts.last;

  @override
  Stream<ConnectionStateUpdate> connectToDevice({
    required String id,
    Map<Uuid, List<Uuid>>? servicesWithCharacteristicsToDiscover,
    Duration? connectionTimeout,
  }) {
    final c = StreamController<ConnectionStateUpdate>();
    attempts.add(c);
    return c.stream;
  }

  @override
  Future<List<Service>> getDiscoveredServices(String deviceId) async => [];

  void emit(DeviceConnectionState s) => current.add(
    ConnectionStateUpdate(deviceId: 'PI', connectionState: s, failure: null),
  );
}

final pi = BleDevice(
  id: 'PI',
  name: 'LIB-SEAT-PI',
  rssi: -60,
  lastSeen: DateTime(2026),
  serviceUuids: const [],
  connectable: true,
);

/// 1 ms per "second" of the real schedule: 2, 4, 8, 16, 30 ms.
Duration fastDelay(int attempt) =>
    Duration(milliseconds: reconnectDelay(attempt).inSeconds);

Future<void> settle([int ms = 5]) =>
    Future<void>.delayed(Duration(milliseconds: ms));

Future<void> waitFor(bool Function() cond, {int maxMs = 2000}) async {
  final end = DateTime.now().add(Duration(milliseconds: maxMs));
  while (!cond()) {
    if (DateTime.now().isAfter(end)) fail('condition not reached');
    await settle(1);
  }
}

Future<(FakeReactiveBle, BleService)> connected() async {
  final fake = FakeReactiveBle();
  final ble = BleService(ble: fake, reconnectDelayOf: fastDelay);
  await ble.connect(pi);
  fake.emit(DeviceConnectionState.connected);
  await settle();
  expect(ble.connection.isConnected, isTrue);
  return (fake, ble);
}

void main() {
  test('reconnectDelay backs off 2, 4, 8, 16, then 30 s', () {
    expect(
      [for (var i = 1; i <= 7; i++) reconnectDelay(i).inSeconds],
      [2, 4, 8, 16, 30, 30, 30],
    );
    final total = [
      for (var i = 1; i <= maxReconnectAttempts; i++) reconnectDelay(i),
    ].fold(Duration.zero, (a, b) => a + b);
    expect(total.inSeconds, 210); // ~3.5 min before giving up
  });

  test('lost link -> waits -> reconnects; counters updated', () async {
    final (fake, ble) = await connected();

    fake.emit(DeviceConnectionState.disconnected); // out of range
    await settle(1);
    expect(ble.connection.reason, DisconnectReason.lost);
    expect(ble.connection.waitingReconnect, isTrue);
    expect(ble.connection.reconnectAttempt, 1);
    expect(ble.lossCount, 1);

    await waitFor(() => fake.attempts.length == 2);
    expect(ble.connection.state, AppConnectionState.connecting);
    expect(ble.connection.reconnectAttempt, 1);

    // First retry fails -> second retry is scheduled.
    fake.current.addError(Exception('GATT 133'));
    await settle(1);
    expect(ble.connection.reconnectAttempt, 2);
    await waitFor(() => fake.attempts.length == 3);

    fake.emit(DeviceConnectionState.connected);
    await settle();
    expect(ble.connection.isConnected, isTrue);
    expect(ble.connection.reconnectAttempt, 0);
    expect(ble.reconnectSuccessCount, 1);
    expect(ble.connectCount, 2);
    ble.dispose();
  });

  test('user disconnect never triggers reconnection', () async {
    final (fake, ble) = await connected();
    await ble.disconnect();
    await settle(100);
    expect(fake.attempts.length, 1);
    expect(ble.connection.reason, DisconnectReason.user);
    expect(ble.connection.waitingReconnect, isFalse);
    ble.dispose();
  });

  test('"재연결 중지" while waiting cancels the pending try', () async {
    final fake = FakeReactiveBle();
    // Long delay so the test can stop it while waiting.
    final ble = BleService(
      ble: fake,
      reconnectDelayOf: (_) => const Duration(milliseconds: 200),
    );
    await ble.connect(pi);
    fake.emit(DeviceConnectionState.connected);
    await settle();
    fake.emit(DeviceConnectionState.disconnected);
    await settle();
    expect(ble.connection.waitingReconnect, isTrue);

    await ble.disconnect();
    await settle(400);
    expect(fake.attempts.length, 1);
    expect(ble.connection.reason, DisconnectReason.user);
    ble.dispose();
  });

  test('gives up after $maxReconnectAttempts failed tries', () async {
    final (fake, ble) = await connected();
    fake.emit(DeviceConnectionState.disconnected);

    for (var i = 1; i <= maxReconnectAttempts; i++) {
      await waitFor(() => fake.attempts.length == i + 1);
      fake.current.addError(TimeoutException('no answer'));
      await settle(1);
    }
    expect(ble.connection.reconnectGaveUp, isTrue);
    expect(ble.connection.waitingReconnect, isFalse);
    await settle(100);
    expect(fake.attempts.length, maxReconnectAttempts + 1);
    ble.dispose();
  });

  test('auto reconnect switched off -> stays disconnected', () async {
    final (fake, ble) = await connected();
    ble.autoReconnect = false;
    fake.emit(DeviceConnectionState.disconnected);
    await settle(100);
    expect(fake.attempts.length, 1);
    expect(ble.connection.reason, DisconnectReason.lost);
    ble.dispose();
  });

  test('forceReconnect (Pi silent) drops the link and retries', () async {
    final (fake, ble) = await connected();
    await ble.forceReconnect('Pi 응답 없음');
    expect(ble.connection.reason, DisconnectReason.lost);
    expect(ble.connection.error, 'Pi 응답 없음');
    await waitFor(() => fake.attempts.length == 2);
    ble.dispose();
  });
}
