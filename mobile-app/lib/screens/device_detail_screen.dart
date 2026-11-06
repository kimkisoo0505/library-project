import 'dart:async';

import 'package:flutter/material.dart';

import '../models/ble_device.dart';
import '../services/ble_service.dart';
import '../services/rssi_service.dart';
import '../widgets/signal_indicator.dart';

/// Step 3: continuous RSSI measurement of one device (from its
/// advertisements; no connection yet).
class DeviceDetailScreen extends StatefulWidget {
  const DeviceDetailScreen({
    super.key,
    required this.ble,
    required this.device,
    required this.requireLocationService,
  });

  final BleService ble;
  final BleDevice device;
  final bool requireLocationService;

  @override
  State<DeviceDetailScreen> createState() => _DeviceDetailScreenState();
}

class _DeviceDetailScreenState extends State<DeviceDetailScreen>
    with WidgetsBindingObserver {
  /// Long scans waste battery and Android downgrades scans after 30 min.
  static const _maxSession = Duration(minutes: 5);
  static const _avgWindow = Duration(seconds: 5);
  static const _chartWindow = Duration(seconds: 60);

  late final RssiService _rssi = RssiService(widget.ble);
  final _tracker = RssiTracker();

  StreamSubscription<RssiSample>? _sub;
  StreamSubscription<AdapterState>? _adapterSub;
  Timer? _ticker;
  Timer? _sessionLimit;
  String? _message;

  bool get _measuring => _sub != null;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _tracker.add(RssiSample(widget.device.lastSeen, widget.device.rssi));
    _adapterSub = widget.ble.adapterState.listen((s) {
      if (s == AdapterState.poweredOff && _measuring) {
        _stop('블루투스가 꺼져서 측정을 멈췄습니다.');
      }
    });
    _ticker = Timer.periodic(const Duration(milliseconds: 500), (_) {
      if (mounted) setState(() {});
    });
    _start();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.paused && _measuring) {
      _stop('앱이 백그라운드로 가서 측정을 멈췄습니다.');
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _sub?.cancel();
    _adapterSub?.cancel();
    _ticker?.cancel();
    _sessionLimit?.cancel();
    super.dispose();
  }

  void _start() {
    final wait = widget.ble.waitBeforeNextScan();
    if (wait > Duration.zero) {
      setState(
        () => _message =
            'Android는 30초에 5번까지만 검색을 시작할 수 있습니다. ${wait.inSeconds + 1}초 후 다시 시도하세요.',
      );
      return;
    }
    _sub = _rssi
        .watch(
          deviceId: widget.device.id,
          requireLocationService: widget.requireLocationService,
        )
        .listen(
          (s) => _tracker.add(s),
          onError: (Object e) => _stop('측정 오류: $e'),
          onDone: () => _stop(null),
        );
    _sessionLimit = Timer(
      _maxSession,
      () => _stop('배터리 절약을 위해 ${_maxSession.inMinutes}분 후 자동으로 멈췄습니다.'),
    );
    setState(() => _message = null);
  }

  void _stop(String? message) {
    _sub?.cancel();
    _sub = null;
    _sessionLimit?.cancel();
    _sessionLimit = null;
    if (mounted) setState(() => _message = message ?? _message);
  }

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

    final String statusText;
    if (!_measuring) {
      statusText = '측정 중지됨';
    } else if (current != null) {
      statusText =
          '측정 중 · ${(now.difference(latest!.at).inMilliseconds / 1000).toStringAsFixed(1)}초 전 수신';
    } else {
      statusText = latest == null
          ? '값 없음 · 아직 광고를 받지 못했습니다'
          : '값 없음 · ${now.difference(latest.at).inSeconds}초 동안 광고 수신 없음';
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
            const SizedBox(height: 16),
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
                          line: theme.colorScheme.primary,
                          grid: theme.colorScheme.outlineVariant,
                          label: muted,
                        ),
                      ),
                    ),
                    const SizedBox(height: 4),
                    Text(
                      '점 하나 = 받은 광고 1개. 점이 없는 구간은 신호를 받지 못한 시간입니다.',
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
            onPressed: _measuring ? () => _stop(null) : _start,
            icon: Icon(_measuring ? Icons.pause : Icons.play_arrow),
            label: Text(_measuring ? '측정 중지' : '측정 시작'),
          ),
        ],
      ),
    );
  }

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

/// Scatter of measured samples over the last [window]. Draws only real
/// points (no connecting lines across gaps, no smoothing).
class _RssiChartPainter extends CustomPainter {
  _RssiChartPainter({
    required this.samples,
    required this.now,
    required this.window,
    required this.line,
    required this.grid,
    required this.label,
  });

  final List<RssiSample> samples;
  final DateTime now;
  final Duration window;
  final Color line, grid, label;

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

    final dot = Paint()..color = line;
    for (final s in samples) {
      canvas.drawCircle(Offset(x(s.at), y(s.rssi)), 2.5, dot);
    }
  }

  @override
  bool shouldRepaint(_RssiChartPainter old) => true;
}
