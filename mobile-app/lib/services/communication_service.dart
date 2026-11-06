import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';

import '../models/ble_connection.dart';
import '../models/ble_message.dart';
import 'ble_service.dart';

/// Summary of a "PING ×N" run.
class PingRunResult {
  const PingRunResult({
    required this.sent,
    required this.answered,
    required this.rtts,
  });

  final int sent;
  final int answered;
  final List<Duration> rtts;

  int get lost => sent - answered;
  Duration? get min =>
      rtts.isEmpty ? null : rtts.reduce((a, b) => a < b ? a : b);
  Duration? get max =>
      rtts.isEmpty ? null : rtts.reduce((a, b) => a > b ? a : b);
  Duration? get average => rtts.isEmpty
      ? null
      : Duration(
          microseconds:
              rtts.fold<int>(0, (s, d) => s + d.inMicroseconds) ~/ rtts.length,
        );
}

/// Sends commands to the library Pi and receives its responses.
///
/// - Subscribes to the Response characteristic automatically once the
///   connected device is verified as the library Pi.
/// - Matches each response to the command with the same sequence number and
///   records the round-trip time; no response within [responseTimeout] is a
///   timeout, a failed write is reported as such, and a dropped connection
///   fails everything still waiting.
/// - Keeps the last [maxLog] log entries (in memory only).
class CommunicationService extends ChangeNotifier {
  CommunicationService(this._ble) {
    _ble.addListener(_onConnectionChanged);
    _onConnectionChanged();
  }

  static const responseTimeout = Duration(seconds: 3);
  static const maxLog = 300;

  final BleService _ble;
  final _seq = SeqCounter();
  final List<BleMessage> _log = [];
  final Map<int, BleMessage> _waiting = {};
  final Map<int, Timer> _timers = {};
  StreamSubscription<List<int>>? _sub;
  String? _subscribedTo;
  int _nextId = 1;
  bool _pingRunActive = false;

  /// Newest last.
  List<BleMessage> get log => List.unmodifiable(_log);

  /// True while notifications from the Pi are being received.
  bool get ready => _sub != null && _ble.connection.isConnected;

  bool get pingRunActive => _pingRunActive;

  /// The connected device is verified as the library Pi.
  bool get piConnected =>
      _ble.connection.isConnected &&
      (_ble.connection.gatt?.isLibraryPi ?? false);

  // ------------------------------------------------------------ lifecycle

  void _onConnectionChanged() {
    final c = _ble.connection;
    if (piConnected && _subscribedTo != c.deviceId) {
      _subscribe(c.deviceId!);
    } else if (!c.isConnected && _subscribedTo != null) {
      _teardown(c);
    }
  }

  void _subscribe(String deviceId) {
    _sub?.cancel();
    _subscribedTo = deviceId;
    _sub = _ble.subscribeResponses().listen(
      _onNotification,
      onError: (Object e) {
        _system('응답 알림 구독 오류: $e');
        _sub = null;
        notifyListeners();
      },
    );
    _system('Pi 응답 알림 구독 시작');
  }

  void _teardown(BleConnection c) {
    _sub?.cancel();
    _sub = null;
    _subscribedTo = null;
    for (final m in _waiting.values) {
      m.status = SendStatus.connectionLost;
      m.note = '응답 전에 연결이 끊어짐';
    }
    _waiting.clear();
    for (final t in _timers.values) {
      t.cancel();
    }
    _timers.clear();
    final why = c.reason == DisconnectReason.user ? '연결 해제' : '연결 끊김';
    _system('$why — 송수신 중지');
  }

  @override
  void dispose() {
    _ble.removeListener(_onConnectionChanged);
    _sub?.cancel();
    for (final t in _timers.values) {
      t.cancel();
    }
    super.dispose();
  }

  // ------------------------------------------------------------ sending

  Future<BleMessage?> sendPing() => _send((s) => BleProtocol.ping(s));
  Future<BleMessage?> sendInfo() => _send((s) => BleProtocol.info(s));

  /// Returns null and logs nothing if [text] is invalid; call
  /// [BleProtocol.validateEchoText] first to show the reason.
  Future<BleMessage?> sendEcho(String text) {
    if (BleProtocol.validateEchoText(text, 999) != null) {
      return Future.value(null);
    }
    return _send((s) => BleProtocol.echo(s, text));
  }

  /// Sends an arbitrary ASCII line (for testing the Pi's error handling).
  Future<BleMessage?> sendRaw(String text) {
    if (BleProtocol.validateRaw(text) != null) return Future.value(null);
    return _send((_) => text, usesSeq: false);
  }

  /// Sends [count] PINGs [interval] apart (below the Pi's 10/s limit) and
  /// waits for each to finish.
  Future<PingRunResult> runPingTest({
    int count = 10,
    Duration interval = const Duration(milliseconds: 300),
  }) async {
    _pingRunActive = true;
    notifyListeners();
    final sent = <BleMessage>[];
    try {
      for (var i = 0; i < count && ready; i++) {
        final m = await sendPing();
        if (m != null) sent.add(m);
        await Future<void>.delayed(interval);
      }
      // Wait until every ping is answered or has failed.
      final deadline = DateTime.now().add(
        responseTimeout + const Duration(milliseconds: 200),
      );
      while (sent.any((m) => m.status == SendStatus.waiting) &&
          DateTime.now().isBefore(deadline)) {
        await Future<void>.delayed(const Duration(milliseconds: 50));
      }
    } finally {
      _pingRunActive = false;
    }
    final rtts = [
      for (final m in sent)
        if (m.status == SendStatus.answered && m.rtt != null) m.rtt!,
    ];
    final r = PingRunResult(
      sent: sent.length,
      answered: rtts.length,
      rtts: rtts,
    );
    _system(
      'PING ${r.sent}회: 응답 ${r.answered}, 손실 ${r.lost}'
      '${r.average == null ? '' : ', 평균 ${r.average!.inMilliseconds}ms (최소 ${r.min!.inMilliseconds} / 최대 ${r.max!.inMilliseconds})'}',
    );
    return r;
  }

  Future<BleMessage?> _send(
    String Function(int seq) build, {
    bool usesSeq = true,
  }) async {
    if (!ready) {
      _system('전송 불가: Pi와 연결되어 있지 않습니다');
      return null;
    }
    final seq = usesSeq ? _seq.next() : null;
    final text = build(seq ?? 0);
    final mSeq = seq ?? BleProtocol.seqOf(text);
    final m = BleMessage(
      id: _nextId++,
      direction: MessageDirection.sent,
      text: text,
      at: DateTime.now(),
      seq: mSeq,
      status: SendStatus.waiting,
    );
    _add(m);

    // Only one command per sequence number may wait for an answer.
    if (mSeq != null) {
      final old = _waiting.remove(mSeq);
      if (old != null) {
        old.status = SendStatus.timedOut;
        old.note = '같은 순번의 새 명령으로 대체됨';
        _timers.remove(mSeq)?.cancel();
      }
    }

    try {
      await _ble.writeCommand(ascii.encode(text));
    } catch (e) {
      m.status = SendStatus.writeFailed;
      m.note = '전송 실패: $e';
      notifyListeners();
      return m;
    }

    if (mSeq == null) {
      // Without a readable seq the Pi answers ERR,0,...; match that instead.
      _waiting[0] = m;
      _arm(0, m);
    } else {
      _waiting[mSeq] = m;
      _arm(mSeq, m);
    }
    notifyListeners();
    return m;
  }

  void _arm(int key, BleMessage m) {
    _timers[key]?.cancel();
    _timers[key] = Timer(responseTimeout, () {
      if (_waiting[key] == m) {
        _waiting.remove(key);
        m.status = SendStatus.timedOut;
        m.note = '${responseTimeout.inSeconds}초 안에 응답 없음';
        notifyListeners();
      }
      _timers.remove(key);
    });
  }

  // ------------------------------------------------------------ receiving

  void _onNotification(List<int> bytes) {
    final now = DateTime.now();
    final text = ascii.decode(bytes, allowInvalid: true);
    final r = BleProtocol.parse(text);
    final rx = BleMessage(
      id: _nextId++,
      direction: MessageDirection.received,
      text: text,
      at: now,
      seq: r.seq,
    );

    final key = r.seq;
    final sent = key == null ? null : _waiting.remove(key);
    if (sent != null) {
      _timers.remove(key)?.cancel();
      sent.rtt = now.difference(sent.at);
      sent.status = r.kind == ResponseKind.error
          ? SendStatus.rejected
          : SendStatus.answered;
      sent.note = r.kind == ResponseKind.error ? 'Pi가 거부: ${r.detail}' : null;
      rx.note = '← ${sent.text} · ${sent.rtt!.inMilliseconds}ms';
    } else {
      rx.note = '대응하는 명령 없음';
    }
    _add(rx);
  }

  // ------------------------------------------------------------ log

  void _system(String text) => _add(
    BleMessage(
      id: _nextId++,
      direction: MessageDirection.system,
      text: text,
      at: DateTime.now(),
    ),
  );

  void _add(BleMessage m) {
    _log.add(m);
    if (_log.length > maxLog) _log.removeRange(0, _log.length - maxLog);
    notifyListeners();
  }

  void clearLog() {
    _log.removeWhere((m) => !_waiting.containsValue(m));
    notifyListeners();
  }
}
