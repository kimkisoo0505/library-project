import 'dart:async';

import 'package:flutter/material.dart';

import '../models/ble_device.dart';
import '../models/scan_results.dart';
import '../services/ble_service.dart';
import '../utils/permission_manager.dart';
import '../widgets/device_list_item.dart';
import 'device_detail_screen.dart';

/// Step 2: Bluetooth / permission checks and BLE scanning.
class DeviceScanScreen extends StatefulWidget {
  const DeviceScanScreen({
    super.key,
    required this.ble,
    required this.permissions,
  });

  final BleService ble;
  final PermissionManager permissions;

  @override
  State<DeviceScanScreen> createState() => _DeviceScanScreenState();
}

/// What currently blocks scanning, in the order the user must fix it.
enum _Blocker {
  checking,
  permission,
  permissionPermanent,
  locationOff,
  unsupported,
  bluetoothOff,
  none,
}

class _DeviceScanScreenState extends State<DeviceScanScreen>
    with WidgetsBindingObserver {
  static const _scanDuration = Duration(seconds: 15);

  final _results = ScanResults();

  int? _sdkInt;
  BlePermissionState? _permission;
  bool _locationOn = true;
  AdapterState _adapter = AdapterState.unknown;

  bool _piOnly = false;
  bool _hideUnnamed = true;
  String? _message;
  bool _messageIsError = false;

  StreamSubscription<AdapterState>? _adapterSub;
  StreamSubscription<dynamic>? _scanSub;
  Timer? _scanTimeout;
  Timer? _ticker;

  bool get _scanning => _scanSub != null;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _adapterSub = widget.ble.adapterState.listen((s) {
      setState(() => _adapter = s);
      if (s == AdapterState.poweredOff && _scanning) {
        _stopScan(message: '블루투스가 꺼져서 검색을 멈췄습니다.', error: true);
      }
    }, onError: (Object e) => _show('블루투스 상태를 읽지 못했습니다: $e', error: true));
    _ticker = Timer.periodic(const Duration(seconds: 1), (_) {
      if (!_results.isEmpty && mounted) setState(() {});
    });
    _refreshChecks();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    // The user may come back from the settings / permission screens.
    if (state == AppLifecycleState.resumed) _refreshChecks();
    if (state == AppLifecycleState.paused && _scanning) _stopScan();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _adapterSub?.cancel();
    _scanSub?.cancel();
    _scanTimeout?.cancel();
    _ticker?.cancel();
    super.dispose();
  }

  Future<void> _refreshChecks() async {
    try {
      final sdk = await widget.permissions.sdkInt();
      final perm = await widget.permissions.check();
      final loc = await widget.permissions.isLocationServiceOn();
      if (!mounted) return;
      setState(() {
        _sdkInt = sdk;
        _permission = perm;
        _locationOn = loc;
      });
    } catch (e) {
      if (mounted) _show('권한 상태를 확인하지 못했습니다: $e', error: true);
    }
  }

  _Blocker get _blocker {
    if (_sdkInt == null || _permission == null) return _Blocker.checking;
    if (_permission == BlePermissionState.permanentlyDenied) {
      return _Blocker.permissionPermanent;
    }
    if (_permission == BlePermissionState.denied) return _Blocker.permission;
    if (_sdkInt! < 31 && !_locationOn) return _Blocker.locationOff;
    if (_adapter == AdapterState.unsupported) return _Blocker.unsupported;
    if (_adapter == AdapterState.poweredOff) return _Blocker.bluetoothOff;
    // AdapterState.unauthorized is ignored here: Android does not re-emit the
    // status after a permission is granted, so PermissionManager is the
    // source of truth for permissions.
    return _Blocker.none;
  }

  Future<void> _requestPermission() async {
    final result = await widget.permissions.request();
    await _refreshChecks();
    if (!mounted) return;
    if (result != BlePermissionState.granted) {
      _show('권한이 없으면 주변 BLE 기기를 검색할 수 없습니다.', error: true);
    } else {
      _show(null);
    }
  }

  Future<void> _fixBlocker() async {
    switch (_blocker) {
      case _Blocker.permission:
        await _requestPermission();
      case _Blocker.permissionPermanent:
        await widget.permissions.openSettingsForApp();
      case _Blocker.locationOff:
        await widget.permissions.openLocationSettings();
      case _Blocker.bluetoothOff:
        final shown = await widget.permissions.requestEnableBluetooth();
        if (!shown && mounted) {
          _show('설정에서 블루투스를 직접 켜 주세요.', error: true);
        }
      case _Blocker.checking || _Blocker.unsupported || _Blocker.none:
        break;
    }
  }

  Future<void> _startScan() async {
    await _refreshChecks();
    if (!mounted) return;
    if (_blocker == _Blocker.permission) await _requestPermission();
    if (!mounted) return;
    if (_blocker != _Blocker.none) {
      _show('위 상태 안내를 먼저 해결해 주세요.', error: true);
      return;
    }

    final wait = widget.ble.waitBeforeNextScan();
    if (wait > Duration.zero) {
      _show(
        'Android는 30초에 5번까지만 검색을 시작할 수 있습니다. ${wait.inSeconds + 1}초 후 다시 시도하세요.',
        error: true,
      );
      return;
    }

    setState(() {
      _message = null;
      _messageIsError = false;
      _results.clear();
    });

    _scanSub = widget.ble
        .scan(libraryPiOnly: _piOnly, requireLocationService: _sdkInt! < 31)
        .listen(
          (d) => setState(() => _results.add(d)),
          onError: (Object e) => _stopScan(message: '검색 오류: $e', error: true),
          onDone: () => _stopScan(),
        );
    _scanTimeout = Timer(
      _scanDuration,
      () => _stopScan(message: '검색을 마쳤습니다 (${_scanDuration.inSeconds}초).'),
    );
    setState(() {});
  }

  /// Only one scan at a time: stop the list scan, then measure one device.
  Future<void> _openDetail(BleDevice device) async {
    _stopScan(message: '기기를 선택해서 목록 검색을 멈췄습니다.');
    await Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => DeviceDetailScreen(
          ble: widget.ble,
          device: device,
          requireLocationService: (_sdkInt ?? 31) < 31,
        ),
      ),
    );
  }

  void _show(String? text, {bool error = false}) {
    if (!mounted) return;
    setState(() {
      _message = text;
      _messageIsError = error;
    });
  }

  void _stopScan({String? message, bool error = false}) {
    _scanTimeout?.cancel();
    _scanTimeout = null;
    _scanSub?.cancel();
    _scanSub = null;
    if (message != null) {
      _show(message, error: error);
    } else if (mounted) {
      setState(() {});
    }
  }

  @override
  Widget build(BuildContext context) {
    final now = DateTime.now();
    final devices = _results.view(now: now, hideUnnamed: _hideUnnamed);
    final hiddenCount = _results.length - devices.length;

    return Scaffold(
      appBar: AppBar(title: const Text('BLE 기기 검색')),
      body: SafeArea(
        child: Column(
          children: [
            _StatusCard(blocker: _blocker, sdkInt: _sdkInt, onFix: _fixBlocker),
            SwitchListTile(
              dense: true,
              title: const Text('도서관 라즈베리파이만 찾기'),
              subtitle: const Text('Service UUID로 필터링'),
              value: _piOnly,
              onChanged: _scanning ? null : (v) => setState(() => _piOnly = v),
            ),
            SwitchListTile(
              dense: true,
              title: const Text('이름 없는 기기 숨기기'),
              value: _hideUnnamed,
              onChanged: (v) => setState(() => _hideUnnamed = v),
            ),
            if (_message != null)
              Padding(
                padding: const EdgeInsets.symmetric(
                  horizontal: 16,
                  vertical: 4,
                ),
                child: Text(
                  _message!,
                  style: TextStyle(
                    color: _messageIsError
                        ? Theme.of(context).colorScheme.error
                        : Theme.of(context).colorScheme.onSurfaceVariant,
                  ),
                ),
              ),
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 4, 16, 4),
              child: Row(
                children: [
                  Expanded(
                    child: Text(
                      _scanning
                          ? '검색 중… ${devices.length}대'
                          : '${devices.length}대 발견${hiddenCount > 0 ? ' (이름 없는 기기 $hiddenCount대 숨김)' : ''}',
                    ),
                  ),
                  if (_scanning)
                    const SizedBox.square(
                      dimension: 18,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    ),
                ],
              ),
            ),
            const Divider(height: 1),
            Expanded(
              child: devices.isEmpty
                  ? Center(
                      child: Text(
                        _scanning ? '주변 기기를 찾는 중입니다…' : '검색 시작을 눌러 주세요.',
                        style: TextStyle(
                          color: Theme.of(context).colorScheme.onSurfaceVariant,
                        ),
                      ),
                    )
                  : ListView.separated(
                      itemCount: devices.length,
                      separatorBuilder: (_, _) => const Divider(height: 1),
                      itemBuilder: (_, i) => DeviceListItem(
                        device: devices[i],
                        now: now,
                        onTap: () => _openDetail(devices[i]),
                      ),
                    ),
            ),
          ],
        ),
      ),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: _scanning ? _stopScan : _startScan,
        icon: Icon(_scanning ? Icons.stop : Icons.search),
        label: Text(_scanning ? '검색 중지' : '검색 시작'),
      ),
    );
  }
}

class _StatusCard extends StatelessWidget {
  const _StatusCard({
    required this.blocker,
    required this.sdkInt,
    required this.onFix,
  });

  final _Blocker blocker;
  final int? sdkInt;
  final VoidCallback onFix;

  @override
  Widget build(BuildContext context) {
    final (
      IconData icon,
      Color color,
      String text,
      String? action,
    ) = switch (blocker) {
      _Blocker.checking => (
        Icons.hourglass_empty,
        Colors.grey,
        '상태 확인 중…',
        null,
      ),
      _Blocker.permission => (
        Icons.lock_outline,
        Colors.orange,
        (sdkInt ?? 31) < 31
            ? '위치 권한이 필요합니다 (Android 11 이하 BLE 검색 조건)'
            : '근처 기기 권한이 필요합니다',
        '권한 허용',
      ),
      _Blocker.permissionPermanent => (
        Icons.lock,
        Colors.red,
        '권한이 거부되었습니다. 앱 설정에서 허용해 주세요.',
        '앱 설정 열기',
      ),
      _Blocker.locationOff => (
        Icons.location_off,
        Colors.orange,
        '위치 서비스(GPS)가 꺼져 있습니다. Android 11 이하에서는 켜야 BLE 검색이 됩니다.',
        '위치 설정 열기',
      ),
      _Blocker.unsupported => (
        Icons.error_outline,
        Colors.red,
        '이 기기는 BLE를 지원하지 않습니다.',
        null,
      ),
      _Blocker.bluetoothOff => (
        Icons.bluetooth_disabled,
        Colors.orange,
        '블루투스가 꺼져 있습니다.',
        '블루투스 켜기',
      ),
      _Blocker.none => (Icons.bluetooth, Colors.green, '검색 준비됨', null),
    };

    return Card(
      margin: const EdgeInsets.fromLTRB(16, 12, 16, 4),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(icon, color: color),
                const SizedBox(width: 8),
                Expanded(child: Text(text)),
              ],
            ),
            const SizedBox(height: 4),
            Text(
              sdkInt == null
                  ? ''
                  : '이 기기: ${androidVersionLabel(sdkInt!)} (API $sdkInt)',
              style: Theme.of(context).textTheme.bodySmall,
            ),
            if (action != null)
              Align(
                alignment: Alignment.centerRight,
                child: TextButton(onPressed: onFix, child: Text(action)),
              ),
          ],
        ),
      ),
    );
  }
}

/// Human-readable Android version for an SDK level.
String androidVersionLabel(int sdk) => switch (sdk) {
  24 => 'Android 7.0',
  25 => 'Android 7.1',
  26 => 'Android 8.0',
  27 => 'Android 8.1',
  28 => 'Android 9',
  29 => 'Android 10',
  30 => 'Android 11',
  31 => 'Android 12',
  32 => 'Android 12L',
  33 => 'Android 13',
  34 => 'Android 14',
  35 => 'Android 15',
  36 => 'Android 16',
  37 => 'Android 17',
  _ => 'Android',
};
