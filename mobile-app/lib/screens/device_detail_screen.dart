import 'dart:async';

import 'package:flutter/material.dart';

import '../models/ble_connection.dart';
import '../models/ble_device.dart';
import '../services/ble_service.dart';
import '../services/communication_service.dart';
import '../services/rssi_service.dart';
import '../widgets/connection_status.dart';
import '../widgets/signal_indicator.dart';
import 'communication_screen.dart';

/// Steps 3–4: RSSI measurement of one device, and connecting to it.
///
/// - Not connected: RSSI from the device's advertisements (scanning).
/// - Connected: RSSI read over the connection once per second.
class DeviceDetailScreen extends StatefulWidget {
  const DeviceDetailScreen({
    super.key,
    required this.ble,
    required this.device,
    required this.requireLocationService,
    this.comm,
  });

  final BleService ble;
  final BleDevice device;
  final bool requireLocationService;
  final CommunicationService? comm;

  @override
  State<DeviceDetailScreen> createState() => _DeviceDetailScreenState();
}

class _DeviceDetailScreenState extends State<DeviceDetailScreen>
    with WidgetsBindingObserver {
  /// Long scans waste battery and Android downgrades scans after 30 min.
  static const _maxScanSession = Duration(minutes: 5);
  static const _avgWindow = Duration(seconds: 5);
  static const _chartWindow = Duration(seconds: 60);
  static const _rssiPollInterval = Duration(seconds: 1);

  late final RssiService _rssi = RssiService(widget.ble);
  final _tracker = RssiTracker();

  /// The user wants RSSI measured (toggled by the play/pause button).
  bool _wantMeasure = true;

  StreamSubscription<RssiSample>? _scanSub;
  StreamSubscription<AdapterState>? _adapterSub;
  Timer? _ticker;
  Timer? _scanLimit;
  Timer? _rssiPoll;
  String? _message;
  AppConnectionState? _lastState;

  BleService get _ble => widget.ble;
  BleConnection get _conn => _ble.connection;
  bool get _connectedHere => _conn.isFor(widget.device.id) && _conn.isConnected;
  bool get _scanning => _scanSub != null;
  bool get _polling => _rssiPoll != null;
  bool get _measuring => _scanning || _polling;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _tracker.add(RssiSample(widget.device.lastSeen, widget.device.rssi));
    _adapterSub = _ble.adapterState.listen((s) {
      if (s == AdapterState.poweredOff && _scanning) {
        _stopScan('블루투스가 꺼져서 측정을 멈췄습니다.');
      }
    });
    _ble.addListener(_onConnectionChanged);
    _lastState = _conn.isFor(widget.device.id) ? _conn.state : null;
    _ticker = Timer.periodic(const Duration(milliseconds: 500), (_) {
      if (mounted) setState(() {});
    });
    _applyMeasureMode();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.paused && _scanning) {
      _stopScan('앱이 백그라운드로 가서 측정을 멈췄습니다.');
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _ble.removeListener(_onConnectionChanged);
    _scanSub?.cancel();
    _adapterSub?.cancel();
    _ticker?.cancel();
    _scanLimit?.cancel();
    _rssiPoll?.cancel();
    super.dispose();
  }

  // ------------------------------------------------------------ connection

  void _onConnectionChanged() {
    if (!mounted) return;
    final mine = _conn.isFor(widget.device.id);
    final state = mine ? _conn.state : null;
    if (state != _lastState) {
      final wasConnected = _lastState == AppConnectionState.connected;
      _lastState = state;
      if (mine && wasConnected && endedUnexpectedly(_conn)) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(lastEndText(_conn) ?? '연결이 끊어졌습니다.')),
        );
      }
      _applyMeasureMode();
    }
    setState(() {});
  }

  Future<void> _connect() async {
    _stopScan(null); // connecting does not need our scan
    await _ble.connect(widget.device);
  }

  // ------------------------------------------------------------ measuring

  /// Picks the RSSI source for the current connection state.
  void _applyMeasureMode() {
    if (_connectedHere) {
      _stopScan(null);
      if (_wantMeasure && !_polling) _startPolling();
    } else {
      _stopPolling();
      final busy =
          _conn.isFor(widget.device.id) &&
          (_conn.state == AppConnectionState.connecting ||
              _conn.state == AppConnectionState.disconnecting);
      if (_wantMeasure && !_scanning && !busy) _startScan();
    }
  }

  void _startScan() {
    final wait = _ble.waitBeforeNextScan();
    if (wait > Duration.zero) {
      setState(
        () => _message =
            'Android는 30초에 5번까지만 검색을 시작할 수 있습니다. ${wait.inSeconds + 1}초 후 다시 시도하세요.',
      );
      return;
    }
    _scanSub = _rssi
        .watch(
          deviceId: widget.device.id,
          requireLocationService: widget.requireLocationService,
        )
        .listen(
          _tracker.add,
          onError: (Object e) => _stopScan('측정 오류: $e'),
          onDone: () => _stopScan(null),
        );
    _scanLimit = Timer(
      _maxScanSession,
      () => _stopScan('배터리 절약을 위해 ${_maxScanSession.inMinutes}분 후 자동으로 멈췄습니다.'),
    );
    setState(() => _message = null);
  }

  void _stopScan(String? message) {
    _scanSub?.cancel();
    _scanSub = null;
    _scanLimit?.cancel();
    _scanLimit = null;
    if (mounted) setState(() => _message = message ?? _message);
  }

  void _startPolling() {
    _rssiPoll = Timer.periodic(_rssiPollInterval, (_) async {
      try {
        final v = await _ble.readConnectedRssi();
        if (mounted && _connectedHere) {
          _tracker.add(RssiSample(DateTime.now(), v, RssiSource.connection));
        }
      } catch (_) {
        // No sample: the UI turns to "값 없음" after 5 s without values.
      }
    });
  }

  void _stopPolling() {
    _rssiPoll?.cancel();
    _rssiPoll = null;
  }

  void _toggleMeasure() {
    setState(() {
      _wantMeasure = !_wantMeasure;
      _message = null;
    });
    if (_wantMeasure) {
      _applyMeasureMode();
    } else {
      _stopScan(null);
      _stopPolling();
      setState(() {});
    }
  }

  // ---------------------------------------------------------------- build

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final muted = theme.colorScheme.onSurfaceVariant;
    final now = DateTime.now();
    final current = _measuring ? _tracker.currentValue(now) : null;
    final latest = _tracker.latest;
    final avg = _tracker.stats(now, _avgWindow);
    final minute = _tracker.stats(now, _chartWindow);
    final d = widget.device;

    final String sourceText = _polling ? '연결로 측정' : '광고로 측정';
    final String statusText;
    if (!_measuring) {
      statusText = '측정 중지됨';
    } else if (current != null) {
      statusText =
          '$sourceText · ${(now.difference(latest!.at).inMilliseconds / 1000).toStringAsFixed(1)}초 전 수신';
    } else {
      statusText = latest == null
          ? '값 없음 · 아직 값을 받지 못했습니다'
          : '값 없음 · ${now.difference(latest.at).inSeconds}초 동안 수신 없음';
    }

    return Scaffold(
      appBar: AppBar(title: Text(d.hasName ? d.name : '(이름 없음)')),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            Text(d.id, style: theme.textTheme.bodySmall),
            if (d.isLibraryPi)
              Text(
                '도서관 라즈베리파이',
                style: TextStyle(color: theme.colorScheme.primary),
              ),
            const SizedBox(height: 12),
            _ConnectionCard(
              ble: _ble,
              device: d,
              onConnect: _connect,
              onDisconnect: _ble.disconnect,
            ),
            if (widget.comm != null &&
                _connectedHere &&
                (_conn.gatt?.isLibraryPi ?? false)) ...[
              const SizedBox(height: 8),
              FilledButton.icon(
                onPressed: () => Navigator.of(context).push(
                  MaterialPageRoute<void>(
                    builder: (_) =>
                        CommunicationScreen(ble: _ble, comm: widget.comm!),
                  ),
                ),
                icon: const Icon(Icons.swap_vert),
                label: const Text('Pi 통신 테스트 (PING / ECHO)'),
              ),
            ],
            const SizedBox(height: 12),
            Card(
              child: Padding(
                padding: const EdgeInsets.all(20),
                child: Column(
                  children: [
                    Row(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        SignalIndicator(rssi: current, size: 40),
                        const SizedBox(width: 16),
                        Text(
                          current == null ? '— dBm' : '$current dBm',
                          style: theme.textTheme.displaySmall?.copyWith(
                            color: current == null ? muted : null,
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 8),
                    Text(
                      current == null
                          ? '현재 값 없음'
                          : '실측값 · 신호 ${signalLabel(current)}',
                    ),
                    const SizedBox(height: 4),
                    Text(
                      statusText,
                      style: theme.textTheme.bodySmall?.copyWith(color: muted),
                    ),
                    if (current == null && latest != null)
                      Text(
                        '마지막 실측값 ${latest.rssi} dBm',
                        style: theme.textTheme.bodySmall?.copyWith(
                          color: muted,
                        ),
                      ),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 12),
            Card(
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('최근 60초 실측값', style: theme.textTheme.labelLarge),
                    const SizedBox(height: 8),
                    SizedBox(
                      height: 140,
                      child: CustomPaint(
                        size: Size.infinite,
                        painter: _RssiChartPainter(
                          samples: _tracker.within(now, _chartWindow),
                          now: now,
                          window: _chartWindow,
                          advertColor: theme.colorScheme.primary,
                          connColor: Colors.teal,
                          grid: theme.colorScheme.outlineVariant,
                          label: muted,
                        ),
                      ),
                    ),
                    const SizedBox(height: 4),
                    Wrap(
                      spacing: 12,
                      children: [
                        _legend(theme.colorScheme.primary, '광고로 측정'),
                        _legend(Colors.teal, '연결로 측정'),
                      ],
                    ),
                    Text(
                      '점 하나 = 실제로 받은 값 1개. 점이 없는 구간은 값을 받지 못한 시간입니다.',
                      style: theme.textTheme.bodySmall?.copyWith(color: muted),
                    ),
                    const Divider(height: 24),
                    _statRow(
                      '최근 5초 평균',
                      avg == null
                          ? '값 없음'
                          : '${avg.average.toStringAsFixed(1)} dBm (실측 ${avg.count}개)',
                    ),
                    _statRow(
                      '최근 60초 최소 / 최대',
                      minute == null
                          ? '값 없음'
                          : '${minute.min} / ${minute.max} dBm',
                    ),
                    _statRow(
                      '최근 60초 수신 수',
                      minute == null ? '0개' : '${minute.count}개',
                    ),
                  ],
                ),
              ),
            ),
            if (_message != null)
              Padding(
                padding: const EdgeInsets.only(top: 12),
                child: Text(_message!, style: TextStyle(color: muted)),
              ),
            const SizedBox(height: 8),
            Text(
              'RSSI는 신호 세기이며 거리가 아닙니다. 몸·벽·기기 방향에 따라 ±10 dBm 정도는 흔히 변합니다.',
              style: theme.textTheme.bodySmall?.copyWith(color: muted),
            ),
            const SizedBox(height: 80),
          ],
        ),
      ),
      floatingActionButton: Row(
        mainAxisAlignment: MainAxisAlignment.end,
        children: [
          FloatingActionButton.small(
            heroTag: 'clear',
            tooltip: '기록 지우기',
            onPressed: () => setState(_tracker.clear),
            child: const Icon(Icons.delete_outline),
          ),
          const SizedBox(width: 12),
          FloatingActionButton.extended(
            heroTag: 'toggle',
            onPressed: _toggleMeasure,
            icon: Icon(_wantMeasure ? Icons.pause : Icons.play_arrow),
            label: Text(_wantMeasure ? '측정 중지' : '측정 시작'),
          ),
        ],
      ),
    );
  }

  Widget _legend(Color c, String text) => Row(
    mainAxisSize: MainAxisSize.min,
    children: [
      Icon(Icons.circle, size: 8, color: c),
      const SizedBox(width: 4),
      Text(text, style: Theme.of(context).textTheme.bodySmall),
    ],
  );

  Widget _statRow(String label, String value) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 2),
    child: Row(
      children: [
        Expanded(child: Text(label)),
        Text(
          value,
          style: const TextStyle(fontFeatures: [FontFeature.tabularFigures()]),
        ),
      ],
    ),
  );
}

/// Connection controls, GATT check and Status value for one device.
class _ConnectionCard extends StatelessWidget {
  const _ConnectionCard({
    required this.ble,
    required this.device,
    required this.onConnect,
    required this.onDisconnect,
  });

  final BleService ble;
  final BleDevice device;
  final VoidCallback onConnect;
  final VoidCallback onDisconnect;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final muted = theme.colorScheme.onSurfaceVariant;
    final c = ble.connection;
    final mine = c.isFor(device.id);
    final state = mine ? c.state : AppConnectionState.disconnected;
    final otherBusy = !mine && c.state != AppConnectionState.disconnected;
    final ended = mine ? lastEndText(c) : null;
    final gatt = mine ? c.gatt : null;
    final uptime = parseStatusUptime(mine ? c.status : null);

    Widget button;
    switch (state) {
      case AppConnectionState.connected:
        button = OutlinedButton.icon(
          onPressed: onDisconnect,
          icon: const Icon(Icons.link_off),
          label: const Text('연결 해제'),
        );
      case AppConnectionState.connecting:
        button = OutlinedButton.icon(
          onPressed: onDisconnect, // cancel the attempt
          icon: const SizedBox.square(
            dimension: 16,
            child: CircularProgressIndicator(strokeWidth: 2),
          ),
          label: const Text('연결 취소'),
        );
      case AppConnectionState.disconnecting:
        button = const OutlinedButton(onPressed: null, child: Text('해제 중…'));
      case AppConnectionState.disconnected when mine && c.waitingReconnect:
        button = OutlinedButton.icon(
          onPressed: onDisconnect, // stops automatic reconnection
          icon: const Icon(Icons.stop_circle_outlined),
          label: const Text('재연결 중지'),
        );
      case AppConnectionState.disconnected:
        button = FilledButton.icon(
          onPressed: onConnect,
          icon: const Icon(Icons.link),
          label: const Text('연결'),
        );
    }

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: ConnectionStatus(
                    state: state,
                    reconnectAttempt: mine ? c.reconnectAttempt : 0,
                  ),
                ),
                button,
              ],
            ),
            if (otherBusy)
              Padding(
                padding: const EdgeInsets.only(top: 6),
                child: Text(
                  '다른 기기(${c.deviceName ?? c.deviceId})와 연결되어 있습니다. 연결하면 그 연결은 해제됩니다.',
                  style: theme.textTheme.bodySmall?.copyWith(color: muted),
                ),
              ),
            if (ended != null)
              Padding(
                padding: const EdgeInsets.only(top: 6),
                child: Text(
                  ended,
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: endedUnexpectedly(c)
                        ? theme.colorScheme.error
                        : muted,
                  ),
                ),
              ),
            if (state == AppConnectionState.connected) ...[
              const Divider(height: 20),
              if (gatt == null)
                Text('서비스 확인 중…', style: TextStyle(color: muted))
              else ...[
                _check(context, '도서관 서비스', gatt.serviceFound),
                _check(context, 'Command 특성 (쓰기)', gatt.commandOk),
                _check(context, 'Response 특성 (알림)', gatt.responseOk),
                _check(context, 'Status 특성 (읽기)', gatt.statusOk),
                const SizedBox(height: 4),
                Text(
                  gatt.isLibraryPi
                      ? '도서관 라즈베리파이로 확인되었습니다.'
                      : '도서관 라즈베리파이가 아닙니다 (서비스 ${gatt.serviceCount}개 발견).',
                  style: TextStyle(
                    color: gatt.isLibraryPi
                        ? Colors.green
                        : theme.colorScheme.error,
                  ),
                ),
              ],
              if (gatt?.statusOk == true) ...[
                const SizedBox(height: 8),
                Row(
                  children: [
                    Expanded(
                      child: Text(
                        c.statusError != null
                            ? 'Status 읽기 실패: ${c.statusError}'
                            : c.status == null
                            ? 'Status 읽는 중…'
                            : 'Status "${c.status}"'
                                  '${uptime == null ? '' : ' · Pi 서버 실행 ${_duration(uptime)}'}',
                        style: TextStyle(
                          color: c.statusError != null
                              ? theme.colorScheme.error
                              : null,
                        ),
                      ),
                    ),
                    TextButton(
                      onPressed: ble.readStatus,
                      child: const Text('다시 읽기'),
                    ),
                  ],
                ),
              ] else if (gatt != null && c.statusError != null)
                Text(
                  c.statusError!,
                  style: TextStyle(color: theme.colorScheme.error),
                ),
            ],
          ],
        ),
      ),
    );
  }

  static Widget _check(BuildContext context, String label, bool ok) => Row(
    children: [
      Icon(
        ok ? Icons.check_circle : Icons.cancel,
        size: 18,
        color: ok ? Colors.green : Colors.red,
      ),
      const SizedBox(width: 6),
      Text(label),
    ],
  );

  static String _duration(int s) {
    final h = s ~/ 3600, m = (s % 3600) ~/ 60, sec = s % 60;
    if (h > 0) return '$h시간 $m분';
    if (m > 0) return '$m분 $sec초';
    return '$sec초';
  }
}

/// Scatter of measured samples over the last [window]. Draws only real
/// points (no connecting lines across gaps, no smoothing).
class _RssiChartPainter extends CustomPainter {
  _RssiChartPainter({
    required this.samples,
    required this.now,
    required this.window,
    required this.advertColor,
    required this.connColor,
    required this.grid,
    required this.label,
  });

  final List<RssiSample> samples;
  final DateTime now;
  final Duration window;
  final Color advertColor, connColor, grid, label;

  static const _top = -30, _bottom = -100;
  static const _leftPad = 34.0;

  @override
  void paint(Canvas canvas, Size size) {
    final gridPaint = Paint()
      ..color = grid
      ..strokeWidth = 1;
    final plotW = size.width - _leftPad;

    double y(int rssi) =>
        (_top - rssi.clamp(_bottom, _top)) / (_top - _bottom) * size.height;
    double x(DateTime t) =>
        _leftPad +
        plotW * (1 - now.difference(t).inMilliseconds / window.inMilliseconds);

    for (final v in [-40, -60, -80, -100]) {
      final yy = y(v);
      canvas.drawLine(Offset(_leftPad, yy), Offset(size.width, yy), gridPaint);
      final tp = TextPainter(
        text: TextSpan(
          text: '$v',
          style: TextStyle(color: label, fontSize: 10),
        ),
        textDirection: TextDirection.ltr,
      )..layout();
      tp.paint(
        canvas,
        Offset(0, (yy - tp.height / 2).clamp(0, size.height - tp.height)),
      );
    }

    final adv = Paint()..color = advertColor;
    final conn = Paint()..color = connColor;
    for (final s in samples) {
      canvas.drawCircle(
        Offset(x(s.at), y(s.rssi)),
        2.5,
        s.source == RssiSource.connection ? conn : adv,
      );
    }
  }

  @override
  bool shouldRepaint(_RssiChartPainter old) => true;
}
