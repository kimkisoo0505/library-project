import 'dart:convert';

import '../utils/ble_constants.dart';

/// Direction of one log entry.
enum MessageDirection {
  /// App → Pi (written to the Command characteristic).
  sent,

  /// Pi → App (notification on the Response characteristic).
  received,

  /// Something the app itself noted (subscribed, link lost, ...).
  system,
}

/// Outcome of a sent command.
enum SendStatus {
  /// Written; waiting for the matching response.
  waiting,

  /// The matching response arrived.
  answered,

  /// The Pi answered with ERR,... for this command.
  rejected,

  /// No response within the timeout.
  timedOut,

  /// The write itself failed (not delivered).
  writeFailed,

  /// The connection ended while waiting.
  connectionLost,
}

/// One line in the communication log.
class BleMessage {
  BleMessage({
    required this.id,
    required this.direction,
    required this.text,
    required this.at,
    this.seq,
    this.status,
    this.rtt,
    this.note,
    this.tag,
  });

  final int id;
  final MessageDirection direction;
  final String text;
  final DateTime at;

  /// Sequence number parsed from the message, if any.
  final int? seq;

  /// Only for [MessageDirection.sent].
  SendStatus? status;

  /// Round-trip time, set when the response arrives.
  Duration? rtt;

  /// Extra human-readable detail (error text, matched command, ...).
  String? note;

  /// Internal purpose of a command not shown in the log
  /// ("keepalive", "soak"); null for commands the user sent.
  final String? tag;

  bool get quiet => tag != null;
}

/// Kinds of response the Pi sends (docs/BLE_GATT_SPEC.md v0).
enum ResponseKind { pong, echo, info, error, unknown }

class ParsedResponse {
  const ParsedResponse(this.kind, this.seq, {this.detail});

  final ResponseKind kind;

  /// null when the response has no readable sequence number.
  final int? seq;

  /// INFO version, ECHO text or ERR code.
  final String? detail;
}

/// Pure helpers for the v0 text protocol.
class BleProtocol {
  BleProtocol._();

  static final _printable = RegExp(r'^[\x20-\x7e]+$');
  static final _alnum = RegExp(r'^[A-Za-z0-9]+$');
  static final _seqRe = RegExp(r'^\d{1,3}$');

  static String ping(int seq) => 'PING,$seq';
  static String info(int seq) => 'INFO,$seq';
  static String echo(int seq, String text) => 'ECHO,$seq,$text';

  /// Longest ECHO text that still fits in one message for [seq].
  static int maxEchoLength(int seq) =>
      BleConstants.maxMessageBytes - 'ECHO,$seq,'.length;

  /// Checks ECHO text before sending. Returns an error message or null.
  static String? validateEchoText(String text, int seq) {
    if (text.isEmpty) return '보낼 글자를 입력하세요.';
    if (!_alnum.hasMatch(text)) return 'ECHO 내용은 영문자와 숫자만 쓸 수 있습니다.';
    if (text.length > maxEchoLength(seq)) {
      return 'ECHO 내용은 ${maxEchoLength(seq)}자 이하여야 합니다 (한 번에 20바이트).';
    }
    return null;
  }

  /// Checks any outgoing raw message. Returns an error message or null.
  static String? validateRaw(String text) {
    if (text.isEmpty) return '보낼 내용을 입력하세요.';
    if (!_printable.hasMatch(text)) return '영문·숫자·기호(ASCII)만 보낼 수 있습니다.';
    if (utf8.encode(text).length > BleConstants.maxMessageBytes) {
      return '한 번에 ${BleConstants.maxMessageBytes}바이트까지만 보낼 수 있습니다.';
    }
    return null;
  }

  /// Sequence number of an outgoing message (second field), if readable.
  static int? seqOf(String message) {
    final parts = message.split(',');
    if (parts.length < 2 || !_seqRe.hasMatch(parts[1])) return null;
    return int.parse(parts[1]);
  }

  static ParsedResponse parse(String text) {
    final parts = text.split(',');
    final seq = parts.length >= 2 && _seqRe.hasMatch(parts[1])
        ? int.parse(parts[1])
        : null;
    String? third() => parts.length >= 3 ? parts.sublist(2).join(',') : null;
    return switch (parts.first) {
      'PONG' when parts.length == 2 => ParsedResponse(ResponseKind.pong, seq),
      'ECHO' => ParsedResponse(ResponseKind.echo, seq, detail: third()),
      'INFO' => ParsedResponse(ResponseKind.info, seq, detail: third()),
      'ERR' => ParsedResponse(ResponseKind.error, seq, detail: third()),
      _ => ParsedResponse(ResponseKind.unknown, seq),
    };
  }
}

/// Sequence numbers 1..999, wrapping (0 is reserved: the Pi uses it for
/// "could not read the sequence number").
class SeqCounter {
  int _next = 1;

  int next() {
    final v = _next;
    _next = _next >= 999 ? 1 : _next + 1;
    return v;
  }
}
