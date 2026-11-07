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

/// Live results of a long-running PING test (step 7).
class SoakStats {
  SoakStats(this.duration, this.startedAt);

  final Duration duration;
  final DateTime startedAt;
  bool running = true;
  bool cancelled = false;
  int sent = 0, answered = 0, rejected = 0, timedOut = 0, writeFailed = 0;
  int connectionLost = 0;

  /// Ticks skipped because the Pi was not connected (e.g. reconnecting).
  int skipped = 0;
  final List<int> rttMs = [];

  int get failed => rejected + timedOut + writeFailed + connectionLost;
  double? get successRate => sent == 0 ? null : answered / sent;

  int? percentile(double p) {
    if (rttMs.isEmpty) return null;
    final sorted = [...rttMs]..sort();
    final i = ((sorted.length - 1) * p).round();
    return sorted[i];
  }

  int? get maxRtt =>
      rttMs.isEmpty ? null : rttMs.reduce((a, b) => a > b ? a : b);
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
  /// [keepalive] null disables the periodic connection check (tests).
  CommunicationService(this._ble, {Duration? keepalive = keepaliveInterval})
    : _keepaliveEvery = keepalive {
    _ble.addListener(_onConnectionChanged);
    _onConnectionChanged();
  }

  static const responseTimeout = Duration(seconds: 3);
  static const maxLog = 300;

  /// Step 7: a quiet PING this often while idle; [keepaliveMissLimit]
  /// misses in a row mean the Pi stopped answering -> reconnect.
  static const keepaliveInterval = Duration(seconds: 15);
  static const keepaliveMissLimit = 2;

  final BleService _ble;
  final Duration? _keepaliveEvery;
  final _seq = SeqCounter();
  final List<BleMessage> _log = [];
  final Map<int, BleMessage> _waiting = {};
  final Map<int, Timer> _timers = {};
  StreamSubscription<List<int>>? _sub;
  String? _subscribedTo;
  int _nextId = 1;
  bool _pingRunActive = false;

  Timer? _keepalive;
  int _keepaliveMisses = 0;
  int keepaliveOk = 0;
  int keepaliveMissed = 0;
  DateTime? lastKeepaliveOk;
  bool _hadLoss = false;
  int _loggedAttempt = 0;
  bool _loggedGaveUp = false;

  SoakStats? _soak;

  /// Current or last long-running test, if any.
  SoakStats? get soak => _soak;

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
    // Reconnection progress in the log (once per attempt).
    if (c.waitingReconnect && c.reconnectAttempt != _loggedAttempt) {
      _loggedAttempt = c.reconnectAttempt;
      final wait = c.reconnectAt!.difference(DateTime.now()).inSeconds + 1;
      _system(
        '자동 재연결 ${c.reconnectAttempt}/$maxReconnectAttempts — 약 $wait초 후 시도',
      );
    }
    if (c.reconnectGaveUp && !_loggedGaveUp) {
      _loggedGaveUp = true;
      _system('자동 재연결 중지 ($maxReconnectAttempts회 실패) — 연결 버튼으로 다시 시도하세요');
    }
    if (c.isConnected) {
      _loggedAttempt = 0;
      _loggedGaveUp = false;
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
    _system(_hadLoss ? '재연결 성공 — Pi 응답 알림 다시 구독' : 'Pi 응답 알림 구독 시작');
    _hadLoss = false;
    _keepaliveMisses = 0;
    _keepalive?.cancel();
    final every = _keepaliveEvery;
    _keepalive = every == null
        ? null
        : Timer.periodic(every, (_) => _keepaliveTick());
  }

  void _keepaliveTick() {
    if (!ready || (_soak?.running ?? false) || _waiting.isNotEmpty) return;
    unawaited(_send((s) => BleProtocol.ping(s), tag: 'keepalive'));
  }

  void _teardown(BleConnection c) {
    _sub?.cancel();
    _sub = null;
    _subscribedTo = null;
    _keepalive?.cancel();
    _keepalive = null;
    final lost = _waiting.values.toList();
    _waiting.clear();
    for (final m in lost) {
      m.status = SendStatus.connectionLost;
      m.note = '응답 전에 연결이 끊어짐';
      _finished(m);
    }
    for (final t in _timers.values) {
      t.cancel();
    }
    _timers.clear();
    final user = c.reason == DisconnectReason.user;
    _hadLoss = !user;
    final detail = c.error == null || c.error!.isEmpty ? '' : ' (${c.error})';
    _system('${user ? '연결 해제' : '연결 끊김$detail'} — 송수신 중지');
  }

  @override
  void dispose() {
    _ble.removeListener(_onConnectionChanged);
    _sub?.cancel();
    _keepalive?.cancel();
    _soak?.cancelled = true;
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

  /// Runs a PING every [interval] for [duration], counting results without
  /// filling the log. Keeps going through disconnects (counted as skipped)
  /// so automatic reconnection is part of the test.
  Future<SoakStats> runSoakTest(
    Duration duration, {
    Duration interval = const Duration(seconds: 1),
  }) async {
    final st = SoakStats(duration, DateTime.now());
    _soak = st;
    _system(
      '연속 시험 시작 (${duration.inMinutes}분, ${interval.inSeconds}초 간격 PING)',
    );
    final ticks = duration.inMilliseconds ~/ interval.inMilliseconds;
    for (var i = 0; i < ticks && !st.cancelled; i++) {
      if (ready) {
        unawaited(_send((s) => BleProtocol.ping(s), tag: 'soak'));
      } else {
        st.skipped++;
        notifyListeners();
      }
      await Future<void>.delayed(interval);
    }
    // Let the last pings finish (each one times out by itself).
    for (
      var i = 0;
      i < 70 && _waiting.values.any((m) => m.tag == 'soak');
      i++
    ) {
      await Future<void>.delayed(const Duration(milliseconds: 50));
    }
    st.running = false;
    final rate = st.successRate == null
        ? '-'
        : '${(st.successRate! * 100).toStringAsFixed(1)}%';
    final rtt = st.rttMs.isEmpty
        ? ''
        : ', 왕복 중앙값 ${st.percentile(0.5)}ms / 95% ${st.percentile(0.95)}ms / 최대 ${st.maxRtt}ms';
    _system(
      '연속 시험 ${st.cancelled ? '중지' : '완료'}: 보냄 ${st.sent}, 응답 ${st.answered} ($rate), '
      '실패 ${st.failed}, 연결 없어 건너뜀 ${st.skipped}$rtt',
    );
    return st;
  }

  void stopSoakTest() {
    _soak?.cancelled = true;
    notifyListeners();
  }

  /// Bookkeeping when a command reaches a final status.
  void _finished(BleMessage m) {
    switch (m.tag) {
      case 'keepalive':
        if (m.status == SendStatus.answered) {
          _keepaliveMisses = 0;
          keepaliveOk++;
          lastKeepaliveOk = DateTime.now();
        } else if (m.status == SendStatus.timedOut ||
            m.status == SendStatus.rejected) {
          _keepaliveMisses++;
          keepaliveMissed++;
          if (_keepaliveMisses >= keepaliveMissLimit) {
            _keepaliveMisses = 0;
            _system(
              'Pi 응답 없음 (연결 확인 $keepaliveMissLimit회 연속 실패) — 연결을 다시 맺습니다',
            );
            unawaited(_ble.forceReconnect('Pi 응답 없음'));
          }
        }
      case 'soak':
        final st = _soak;
        if (st == null) return;
        switch (m.status) {
          case SendStatus.answered:
            st.answered++;
            if (m.rtt != null) st.rttMs.add(m.rtt!.inMilliseconds);
          case SendStatus.rejected:
            st.rejected++;
          case SendStatus.timedOut:
            st.timedOut++;
          case SendStatus.writeFailed:
            st.writeFailed++;
          case SendStatus.connectionLost:
            st.connectionLost++;
          case SendStatus.waiting || null:
            break;
        }
    }
  }

  Future<BleMessage?> _send(
    String Function(int seq) build, {
    bool usesSeq = true,
    String? tag,
  }) async {
    if (!ready) {
      if (tag == null) _system('전송 불가: Pi와 연결되어 있지 않습니다');
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
      tag: tag,
    );
    if (tag == 'soak') _soak?.sent++;
    if (m.quiet) {
      notifyListeners();
    } else {
      _add(m);
    }

    // Only one command per sequence number may wait for an answer.
    if (mSeq != null) {
      final old = _waiting.remove(mSeq);
      if (old != null) {
        old.status = SendStatus.timedOut;
        old.note = '같은 순번의 새 명령으로 대체됨';
        _timers.remove(mSeq)?.cancel();
        _finished(old);
      }
    }

    try {
      await _ble.writeCommand(ascii.encode(text));
    } catch (e) {
      m.status = SendStatus.writeFailed;
      m.note = '전송 실패: $e';
      _finished(m);
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
        _finished(m);
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
      _finished(sent);
      if (sent.quiet) {
        notifyListeners(); // keepalive / soak replies stay out of the log
        return;
      }
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
