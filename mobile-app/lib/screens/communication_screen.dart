import 'package:flutter/material.dart';

import '../models/ble_message.dart';
import '../services/ble_service.dart';
import '../services/communication_service.dart';
import '../widgets/connection_status.dart';

/// Step 5: send commands to the library Pi and see its responses.
class CommunicationScreen extends StatefulWidget {
  const CommunicationScreen({super.key, required this.ble, required this.comm});

  final BleService ble;
  final CommunicationService comm;

  @override
  State<CommunicationScreen> createState() => _CommunicationScreenState();
}

class _CommunicationScreenState extends State<CommunicationScreen> {
  final _echo = TextEditingController(text: 'Hello');
  final _raw = TextEditingController(text: 'HELLO,1');
  String? _inputError;

  CommunicationService get _comm => widget.comm;

  @override
  void dispose() {
    _echo.dispose();
    _raw.dispose();
    super.dispose();
  }

  Future<void> _sendEcho() async {
    final err = BleProtocol.validateEchoText(_echo.text, 999);
    setState(() => _inputError = err);
    if (err == null) await _comm.sendEcho(_echo.text);
  }

  Future<void> _sendRaw() async {
    final err = BleProtocol.validateRaw(_raw.text);
    setState(() => _inputError = err);
    if (err == null) await _comm.sendRaw(_raw.text);
  }

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: Listenable.merge([widget.ble, _comm]),
      builder: (context, _) {
        final theme = Theme.of(context);
        final c = widget.ble.connection;
        final canSend = _comm.ready && !_comm.pingRunActive;
        final log = _comm.log.reversed.toList(); // newest first

        return Scaffold(
          appBar: AppBar(
            title: const Text('Pi 통신 테스트'),
            actions: [
              IconButton(
                tooltip: '기록 지우기',
                onPressed: _comm.clearLog,
                icon: const Icon(Icons.delete_sweep_outlined),
              ),
            ],
          ),
          body: SafeArea(
            child: Column(
              children: [
                Padding(
                  padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
                  child: Row(
                    children: [
                      Expanded(
                        child: ConnectionStatus(
                          state: c.state,
                          deviceName: c.isConnected
                              ? (c.deviceName ?? c.deviceId)
                              : null,
                        ),
                      ),
                      Text(
                        _comm.ready
                            ? '응답 수신 중'
                            : (_comm.piConnected ? '알림 구독 중…' : '송신 불가'),
                        style: theme.textTheme.bodySmall?.copyWith(
                          color: _comm.ready
                              ? Colors.green
                              : theme.colorScheme.error,
                        ),
                      ),
                    ],
                  ),
                ),
                if (!_comm.piConnected)
                  Padding(
                    padding: const EdgeInsets.all(16),
                    child: Text(
                      lastEndText(c) ?? '도서관 라즈베리파이와 연결되어 있지 않습니다. 기기 검색 → LIB-SEAT-PI → 연결 후 사용하세요.',
                      style: TextStyle(color: theme.colorScheme.error),
                    ),
                  ),
                Padding(
                  padding: const EdgeInsets.fromLTRB(12, 8, 12, 0),
                  child: Wrap(
                    spacing: 8,
                    runSpacing: 4,
                    children: [
                      FilledButton.tonal(
                        onPressed: canSend ? _comm.sendPing : null,
                        child: const Text('PING'),
                      ),
                      FilledButton.tonal(
                        onPressed: canSend ? _comm.sendInfo : null,
                        child: const Text('INFO'),
                      ),
                      FilledButton.tonal(
                        onPressed: canSend ? () => _comm.runPingTest() : null,
                        child: Text(
                          _comm.pingRunActive ? 'PING 10회 진행 중…' : 'PING 10회',
                        ),
                      ),
                    ],
                  ),
                ),
                Padding(
                  padding: const EdgeInsets.fromLTRB(16, 4, 16, 0),
                  child: Row(
                    children: [
                      Expanded(
                        child: TextField(
                          controller: _echo,
                          decoration: const InputDecoration(
                            labelText: 'ECHO 내용 (영문·숫자, 최대 11자)',
                            isDense: true,
                          ),
                          maxLength: 11,
                          onSubmitted: (_) => canSend ? _sendEcho() : null,
                        ),
                      ),
                      const SizedBox(width: 8),
                      FilledButton(
                        onPressed: canSend ? _sendEcho : null,
                        child: const Text('ECHO'),
                      ),
                    ],
                  ),
                ),
                ExpansionTile(
                  dense: true,
                  title: const Text('직접 입력 (오류 처리 시험용)'),
                  childrenPadding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
                  children: [
                    Row(
                      children: [
                        Expanded(
                          child: TextField(
                            controller: _raw,
                            decoration: const InputDecoration(
                              labelText: '보낼 내용 (ASCII, 최대 20바이트)',
                              isDense: true,
                            ),
                            maxLength: 20,
                          ),
                        ),
                        const SizedBox(width: 8),
                        OutlinedButton(
                          onPressed: canSend ? _sendRaw : null,
                          child: const Text('보내기'),
                        ),
                      ],
                    ),
                  ],
                ),
                if (_inputError != null)
                  Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 16),
                    child: Text(
                      _inputError!,
                      style: TextStyle(color: theme.colorScheme.error),
                    ),
                  ),
                _Summary(log: _comm.log),
                const Divider(height: 1),
                Expanded(
                  child: log.isEmpty
                      ? Center(
                          child: Text(
                            '통신 기록이 없습니다.',
                            style: TextStyle(
                              color: theme.colorScheme.onSurfaceVariant,
                            ),
                          ),
                        )
                      : ListView.builder(
                          itemCount: log.length,
                          itemBuilder: (_, i) => _LogRow(m: log[i]),
                        ),
                ),
              ],
            ),
          ),
        );
      },
    );
  }
}

class _Summary extends StatelessWidget {
  const _Summary({required this.log});

  final List<BleMessage> log;

  @override
  Widget build(BuildContext context) {
    final sent = log
        .where((m) => m.direction == MessageDirection.sent)
        .toList();
    int count(SendStatus s) => sent.where((m) => m.status == s).length;
    final rtts = [
      for (final m in sent)
        if (m.rtt != null) m.rtt!.inMilliseconds,
    ];
    final avg = rtts.isEmpty
        ? null
        : rtts.reduce((a, b) => a + b) ~/ rtts.length;
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 6, 16, 6),
      child: Text(
        '보냄 ${sent.length} · 응답 ${count(SendStatus.answered)} · 거부 ${count(SendStatus.rejected)}'
        ' · 시간 초과 ${count(SendStatus.timedOut)} · 전송 실패 ${count(SendStatus.writeFailed)}'
        ' · 끊김 ${count(SendStatus.connectionLost)}'
        '${avg == null ? '' : ' · 평균 왕복 ${avg}ms'}',
        style: Theme.of(context).textTheme.bodySmall,
      ),
    );
  }
}

class _LogRow extends StatelessWidget {
  const _LogRow({required this.m});

  final BleMessage m;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final muted = theme.colorScheme.onSurfaceVariant;
    final t = m.at;
    final time =
        '${t.hour.toString().padLeft(2, '0')}:${t.minute.toString().padLeft(2, '0')}:${t.second.toString().padLeft(2, '0')}.${(t.millisecond ~/ 10).toString().padLeft(2, '0')}';

    final (IconData icon, Color color) = switch (m.direction) {
      MessageDirection.sent => (Icons.north_east, theme.colorScheme.primary),
      MessageDirection.received => (Icons.south_west, Colors.teal),
      MessageDirection.system => (Icons.info_outline, muted),
    };

    final String? statusText = switch (m.status) {
      null => null,
      SendStatus.waiting => '응답 대기',
      SendStatus.answered => '응답 ${m.rtt?.inMilliseconds}ms',
      SendStatus.rejected => '거부됨 ${m.rtt?.inMilliseconds}ms',
      SendStatus.timedOut => '시간 초과',
      SendStatus.writeFailed => '전송 실패',
      SendStatus.connectionLost => '연결 끊김',
    };
    final bad = switch (m.status) {
      SendStatus.timedOut ||
      SendStatus.writeFailed ||
      SendStatus.connectionLost ||
      SendStatus.rejected => true,
      _ => false,
    };

    return ListTile(
      dense: true,
      leading: Icon(icon, color: color, size: 20),
      title: Text(
        m.text,
        style: TextStyle(
          fontFamily: m.direction == MessageDirection.system
              ? null
              : 'monospace',
          color: m.direction == MessageDirection.system ? muted : null,
        ),
      ),
      subtitle: Text(
        [time, if (m.note != null) m.note!].join(' · '),
        style: theme.textTheme.bodySmall?.copyWith(color: muted),
      ),
      trailing: statusText == null
          ? null
          : Text(
              statusText,
              style: TextStyle(
                color: bad
                    ? theme.colorScheme.error
                    : (m.status == SendStatus.answered ? Colors.green : muted),
              ),
            ),
    );
  }
}
