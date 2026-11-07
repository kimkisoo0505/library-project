import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';

import 'package:library_ble/models/ble_connection.dart';
import 'package:library_ble/models/ble_message.dart';
import 'package:library_ble/services/ble_service.dart';
import 'package:library_ble/services/communication_service.dart';
import 'package:library_ble/utils/ble_constants.dart';

const piServices = [
  GattServiceInfo(
    uuid: BleConstants.serviceUuid,
    characteristics: [
      GattCharInfo(uuid: BleConstants.commandCharUuid, writable: true),
      GattCharInfo(uuid: BleConstants.responseCharUuid, notifiable: true),
      GattCharInfo(uuid: BleConstants.statusCharUuid, readable: true),
    ],
  ),
];

/// Fake Pi: answers like raspberry-pi/agent/ble_protocol.py (subset).
class FakePiBle extends BleService {
  BleConnection _c = const BleConnection();
  final notifications = StreamController<List<int>>.broadcast();
  final written = <String>[];
  bool failWrites = false;
  bool silent = false; // do not answer
  final forced = <String>[];

  @override
  Future<void> forceReconnect(String why) async => forced.add(why);

  @override
  BleConnection get connection => _c;

  void setConnection(BleConnection c) {
    _c = c;
    notifyListeners();
  }

  void connectTo(String id, String name, List<GattServiceInfo> services) {
    final c = ConnectionTransitions.connected(
      ConnectionTransitions.connecting(id, name),
      DateTime.now(),
    );
    setConnection(
      ConnectionTransitions.withGatt(c, GattCheck.evaluate(services)),
    );
  }

  void connectPi() => connectTo('PI', 'LIB-SEAT-PI', piServices);

  void dropLink() => setConnection(
    ConnectionTransitions.ended(_c, now: DateTime.now(), userRequested: false),
  );

  @override
  Stream<List<int>> subscribeResponses() => notifications.stream;

  @override
  Future<void> writeCommand(List<int> bytes) async {
    if (failWrites) throw Exception('GATT write failed');
    final text = ascii.decode(bytes);
    written.add(text);
    if (silent) return;
    final p = text.split(',');
    String reply;
    if (p.length >= 2 && RegExp(r'^\d{1,3}$').hasMatch(p[1])) {
      final seq = int.parse(p[1]);
      reply = switch (p[0]) {
        'PING' => 'PONG,$seq',
        'INFO' => 'INFO,$seq,0.1',
        'ECHO' => 'ECHO,$seq,${p[2]}',
        _ => 'ERR,$seq,UNKNOWN',
      };
    } else {
      reply = 'ERR,0,BAD_FORMAT';
    }
    scheduleMicrotask(() => notifications.add(ascii.encode(reply)));
  }
}

void main() {
  group('BleProtocol', () {
    test('builders and the 20-byte limit', () {
      expect(BleProtocol.ping(7), 'PING,7');
      expect(BleProtocol.echo(12, 'Hi'), 'ECHO,12,Hi');
      expect(BleProtocol.maxEchoLength(999), 11); // "ECHO,999," is 9 bytes
      for (final seq in [1, 99, 999]) {
        final longest = 'a' * BleProtocol.maxEchoLength(seq);
        expect(BleProtocol.echo(seq, longest).length, lessThanOrEqualTo(20));
      }
    });

    test('echo / raw validation', () {
      expect(BleProtocol.validateEchoText('Hello1', 999), isNull);
      expect(BleProtocol.validateEchoText('', 1), isNotNull);
      expect(BleProtocol.validateEchoText('has space', 1), isNotNull);
      expect(BleProtocol.validateEchoText('한글', 1), isNotNull);
      expect(BleProtocol.validateEchoText('a' * 12, 999), isNotNull);
      expect(BleProtocol.validateRaw('HELLO,1'), isNull);
      expect(BleProtocol.validateRaw('x' * 21), isNotNull);
      expect(BleProtocol.validateRaw('한'), isNotNull);
    });

    test('parse responses', () {
      expect(BleProtocol.parse('PONG,5').kind, ResponseKind.pong);
      expect(BleProtocol.parse('PONG,5').seq, 5);
      expect(BleProtocol.parse('INFO,3,0.1').detail, '0.1');
      final err = BleProtocol.parse('ERR,0,BAD_FORMAT');
      expect(err.kind, ResponseKind.error);
      expect(err.seq, 0);
      expect(err.detail, 'BAD_FORMAT');
      expect(BleProtocol.parse('???').kind, ResponseKind.unknown);
      expect(BleProtocol.parse('???').seq, isNull);
    });

    test('SeqCounter wraps 999 -> 1 and never yields 0', () {
      final c = SeqCounter();
      final seen = [for (var i = 0; i < 1000; i++) c.next()];
      expect(seen.first, 1);
      expect(seen[998], 999);
      expect(seen[999], 1);
      expect(seen.contains(0), isFalse);
    });
  });

  group('CommunicationService', () {
    late FakePiBle ble;
    late CommunicationService comm;

    setUp(() {
      ble = FakePiBle();
      comm = CommunicationService(ble, keepalive: null);
    });

    tearDown(() => comm.dispose());

    testWidgets('subscribes on Pi connection, pairs responses with commands', (
      tester,
    ) async {
      expect(comm.ready, isFalse);
      ble.connectPi();
      expect(comm.ready, isTrue);

      final ping = await comm.sendPing();
      final info = await comm.sendInfo();
      final echo = await comm.sendEcho('Hello1');
      await tester.pump();

      expect(ble.written, ['PING,1', 'INFO,2', 'ECHO,3,Hello1']);
      for (final m in [ping!, info!, echo!]) {
        expect(m.status, SendStatus.answered);
        expect(m.rtt, isNotNull);
      }
      final received = comm.log
          .where((m) => m.direction == MessageDirection.received)
          .map((m) => m.text);
      expect(received, ['PONG,1', 'INFO,2,0.1', 'ECHO,3,Hello1']);
    });

    testWidgets('unknown command is marked as rejected by the Pi', (
      tester,
    ) async {
      ble.connectPi();
      final m = await comm.sendRaw('HELLO,42');
      await tester.pump();
      expect(m!.status, SendStatus.rejected);
      expect(m.note, contains('UNKNOWN'));
    });

    testWidgets('no answer -> timed out after 3 s', (tester) async {
      ble.connectPi();
      ble.silent = true;
      final m = await comm.sendPing();
      await tester.pump(const Duration(seconds: 2));
      expect(m!.status, SendStatus.waiting);
      await tester.pump(const Duration(milliseconds: 1100));
      expect(m.status, SendStatus.timedOut);
    });

    testWidgets('write failure is reported, not treated as sent', (
      tester,
    ) async {
      ble.connectPi();
      ble.failWrites = true;
      final m = await comm.sendPing();
      expect(m!.status, SendStatus.writeFailed);
      expect(m.note, contains('전송 실패'));
    });

    testWidgets('link loss fails waiting commands and blocks sending', (
      tester,
    ) async {
      ble.connectPi();
      ble.silent = true;
      final m = await comm.sendPing();
      ble.dropLink();
      expect(m!.status, SendStatus.connectionLost);
      expect(comm.ready, isFalse);
      expect(await comm.sendPing(), isNull);
      expect(comm.log.last.text, contains('전송 불가'));
      await tester.pump(const Duration(seconds: 4)); // no late timeout flip
      expect(m.status, SendStatus.connectionLost);
    });

    testWidgets('not subscribed when the device is not the library Pi', (
      tester,
    ) async {
      ble.connectTo('X', 'Watch', const []);
      expect(comm.ready, isFalse);
      expect(comm.piConnected, isFalse);
    });
  });

  testWidgets('keepalive: 2 silent checks in a row -> forceReconnect', (
    tester,
  ) async {
    final ble = FakePiBle();
    final comm = CommunicationService(
      ble,
      keepalive: const Duration(seconds: 15),
    );
    ble.connectPi();
    ble.silent = true;

    await tester.pump(const Duration(seconds: 15)); // 1st check sent
    expect(ble.written, ['PING,1']);
    expect(
      comm.log.where((m) => m.text == 'PING,1'),
      isEmpty,
      reason: 'keepalive pings stay out of the log',
    );
    await tester.pump(const Duration(seconds: 3)); // timed out
    expect(comm.keepaliveMissed, 1);
    expect(ble.forced, isEmpty);

    await tester.pump(const Duration(seconds: 12)); // 2nd check
    await tester.pump(const Duration(seconds: 3));
    expect(comm.keepaliveMissed, 2);
    expect(ble.forced, ['Pi 응답 없음']);

    ble.silent = false; // answers again -> misses reset
    await tester.pump(const Duration(seconds: 12));
    await tester.pump();
    expect(comm.keepaliveOk, 1);
    comm.dispose();
  });

  testWidgets('soak test counts answers and skips while disconnected', (
    tester,
  ) async {
    final ble = FakePiBle();
    final comm = CommunicationService(ble, keepalive: null);
    ble.connectPi();
    final run = comm.runSoakTest(const Duration(seconds: 5));
    for (var i = 0; i < 3; i++) {
      await tester.pump(const Duration(seconds: 1));
    }
    // Ticks at 0, 1, 2, 3 s were sent; the tick at 4 s finds no connection.
    ble.dropLink();
    for (var i = 0; i < 4; i++) {
      await tester.pump(const Duration(seconds: 1));
    }
    final st = await run;
    expect(st.running, isFalse);
    expect(st.sent, 4);
    expect(st.answered, 4);
    expect(st.skipped, 1);
    expect(st.successRate, 1.0);
    expect(comm.log.last.text, contains('연속 시험 완료'));
    comm.dispose();
  });

  test('PingRunResult stats', () {
    const r = PingRunResult(
      sent: 3,
      answered: 2,
      rtts: [Duration(milliseconds: 40), Duration(milliseconds: 60)],
    );
    expect(r.lost, 1);
    expect(r.average, const Duration(milliseconds: 50));
    expect(r.min, const Duration(milliseconds: 40));
    expect(r.max, const Duration(milliseconds: 60));
  });
}
