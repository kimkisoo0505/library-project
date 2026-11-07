import 'package:flutter/material.dart';

import '../models/ble_connection.dart';

export '../models/ble_connection.dart' show AppConnectionState;

class ConnectionStatus extends StatelessWidget {
  const ConnectionStatus({
    super.key,
    required this.state,
    this.deviceName,
    this.reconnectAttempt = 0,
  });

  final AppConnectionState state;
  final String? deviceName;

  /// > 0 while an automatic reconnection try is running.
  final int reconnectAttempt;

  @override
  Widget build(BuildContext context) {
    final (IconData icon, Color color, String label) = switch (state) {
      AppConnectionState.connected => (
        Icons.bluetooth_connected,
        Colors.green,
        '연결됨',
      ),
      AppConnectionState.connecting => (
        Icons.bluetooth_searching,
        Colors.orange,
        reconnectAttempt > 0
            ? '재연결 중 ($reconnectAttempt/$maxReconnectAttempts)…'
            : '연결 중…',
      ),
      AppConnectionState.disconnecting => (
        Icons.bluetooth_searching,
        Colors.orange,
        '연결 해제 중…',
      ),
      AppConnectionState.disconnected => (
        Icons.bluetooth_disabled,
        Colors.grey,
        '연결 안 됨',
      ),
    };

    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Icon(icon, color: color),
        const SizedBox(width: 8),
        Text(
          deviceName == null ? label : '$label · $deviceName',
          style: Theme.of(context).textTheme.titleMedium,
        ),
      ],
    );
  }
}

String _hms(DateTime t) =>
    '${t.hour.toString().padLeft(2, '0')}:${t.minute.toString().padLeft(2, '0')}:${t.second.toString().padLeft(2, '0')}';

/// One-line explanation of how the last connection ended, or null if the
/// connection never ended (or never started).
String? lastEndText(BleConnection c) {
  final at = c.endedAt;
  final reason = c.reason;
  if (at == null ||
      reason == null ||
      c.state != AppConnectionState.disconnected) {
    return null;
  }
  final what = switch (reason) {
    DisconnectReason.user => '연결을 해제했습니다',
    DisconnectReason.lost => '연결이 끊어졌습니다 (범위 밖·전원 꺼짐 등)',
    DisconnectReason.timeout => '연결 시간 초과 (10초)',
    DisconnectReason.failed => '연결하지 못했습니다',
  };
  final err = c.error == null || c.error!.isEmpty ? '' : ' · ${c.error}';
  final String retry;
  if (c.waitingReconnect) {
    final s = c.reconnectAt!.difference(DateTime.now()).inSeconds + 1;
    retry =
        ' · 자동 재연결 ${c.reconnectAttempt}/$maxReconnectAttempts (${s < 1 ? 1 : s}초 후)';
  } else if (c.reconnectGaveUp) {
    retry = ' · 자동 재연결 중지 ($maxReconnectAttempts회 실패)';
  } else {
    retry = '';
  }
  return '${_hms(at)} $what$err$retry';
}

/// True when the last ending was not the user's choice (shown as a warning).
bool endedUnexpectedly(BleConnection c) =>
    c.state == AppConnectionState.disconnected &&
    c.reason != null &&
    c.reason != DisconnectReason.user;
