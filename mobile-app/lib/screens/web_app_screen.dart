import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:webview_flutter/webview_flutter.dart';

import '../services/ble_service.dart';
import '../services/communication_service.dart';
import '../services/presence_service.dart';
import '../utils/permission_manager.dart';
import 'home_screen.dart';

/// The kiosk web page (mobile layout). Override for local testing:
/// `flutter run --dart-define=KIOSK_URL=http://10.0.2.2:5173/`
const kioskUrl = String.fromEnvironment(
  'KIOSK_URL',
  defaultValue: 'https://library-kiosk.kimkisoo0505.workers.dev/',
);

/// Appended to the WebView User-Agent; the kiosk web switches to app mode
/// automatically when it sees this (web/kiosk/src/app-bridge.js).
const appUserAgentToken = 'LibrarySeatApp/1.0.0';

/// Main screen: the kiosk web page in a WebView, plus a slim native bar with
/// the Bluetooth presence state and a menu (BLE diagnostics, threshold).
class WebAppScreen extends StatefulWidget {
  const WebAppScreen({
    super.key,
    required this.ble,
    required this.permissions,
    required this.comm,
    required this.presence,
  });

  final BleService ble;
  final PermissionManager permissions;
  final CommunicationService comm;
  final PresenceService presence;

  @override
  State<WebAppScreen> createState() => _WebAppScreenState();
}

class _WebAppScreenState extends State<WebAppScreen>
    with WidgetsBindingObserver {
  late final WebViewController _web;
  final Uri _home = Uri.parse(kioskUrl);
  bool _loading = true;
  String? _loadError;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    widget.presence.onSnapshot = _sendPresence;
    _web = WebViewController()
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..addJavaScriptChannel('LibraryApp', onMessageReceived: _onWebMessage)
      ..setNavigationDelegate(
        NavigationDelegate(
          // Only the kiosk site may load inside the app (the JS channel is
          // exposed to whatever page is shown).
          onNavigationRequest: (req) {
            final uri = Uri.tryParse(req.url);
            return uri != null && uri.origin == _home.origin
                ? NavigationDecision.navigate
                : NavigationDecision.prevent;
          },
          onPageStarted: (_) => setState(() {
            _loading = true;
            _loadError = null;
          }),
          onPageFinished: (_) {
            setState(() => _loading = false);
            _sendPresence(widget.presence.snapshot);
          },
          onWebResourceError: (e) {
            if (e.isForMainFrame ?? true) {
              setState(() {
                _loading = false;
                _loadError = '${e.errorCode} ${e.description}';
              });
            }
          },
        ),
      );
    _start();
  }

  Future<void> _start() async {
    final ua = await _web.getUserAgent();
    await _web.setUserAgent('${ua ?? ''} $appUserAgentToken'.trim());
    await _web.loadRequest(_home);
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.paused) widget.presence.pause();
    if (state == AppLifecycleState.resumed) widget.presence.resume();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    widget.presence.onSnapshot = null;
    super.dispose();
  }

  /// Web → app: `{type: 'state', loggedIn, seat, presenceWanted}`.
  void _onWebMessage(JavaScriptMessage message) {
    Object? data;
    try {
      data = jsonDecode(message.message);
    } catch (_) {
      return;
    }
    if (data is Map && data['type'] == 'state') {
      widget.presence.setWanted(data['presenceWanted'] == true);
    }
  }

  /// App → web: Bluetooth presence state.
  void _sendPresence(PresenceSnapshot s) {
    if (_loading) return;
    final js =
        'window.__libraryApp && window.__libraryApp.presence(${jsonEncode(s.toJson())});';
    _web.runJavaScript(js).catchError((_) {});
  }

  Future<void> _openDiagnostics() => Navigator.of(context).push(
    MaterialPageRoute<void>(
      builder: (_) => HomeScreen(
        ble: widget.ble,
        permissions: widget.permissions,
        comm: widget.comm,
      ),
    ),
  );

  Future<void> _chooseThreshold() async {
    final v = await showDialog<int>(
      context: context,
      builder: (ctx) => SimpleDialog(
        title: const Text('자동 연장 신호 기준'),
        children: [
          const Padding(
            padding: EdgeInsets.fromLTRB(24, 0, 24, 8),
            child: Text('이 값 이상으로 신호가 잡힐 때만 자리에 있다고 봅니다. (도서관 기준 확정 전 임시 설정)'),
          ),
          for (final t in PresenceService.thresholdChoices)
            ListTile(
              leading: Icon(
                t == widget.presence.threshold
                    ? Icons.radio_button_checked
                    : Icons.radio_button_unchecked,
              ),
              title: Text(t == -100 ? '제한 없음 (연결만 되면)' : '$t dBm 이상'),
              onTap: () => Navigator.of(ctx).pop(t),
            ),
        ],
      ),
    );
    if (v != null) widget.presence.threshold = v;
  }

  @override
  Widget build(BuildContext context) {
    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) async {
        if (didPop) return;
        if (await _web.canGoBack()) {
          await _web.goBack();
        } else if (context.mounted) {
          Navigator.of(context).maybePop();
        }
      },
      child: Scaffold(
        body: SafeArea(
          child: Column(
            children: [
              _PresenceBar(
                presence: widget.presence,
                onDiagnostics: _openDiagnostics,
                onThreshold: _chooseThreshold,
                onReload: () => _web.reload(),
              ),
              if (_loading) const LinearProgressIndicator(minHeight: 2),
              Expanded(
                child: _loadError == null
                    ? WebViewWidget(controller: _web)
                    : _ErrorView(
                        message: _loadError!,
                        onRetry: () => _web.loadRequest(_home),
                      ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// Slim native bar: presence state + menu.
class _PresenceBar extends StatelessWidget {
  const _PresenceBar({
    required this.presence,
    required this.onDiagnostics,
    required this.onThreshold,
    required this.onReload,
  });

  final PresenceService presence;
  final VoidCallback onDiagnostics;
  final VoidCallback onThreshold;
  final VoidCallback onReload;

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: presence,
      builder: (context, _) {
        final theme = Theme.of(context);
        final s = presence.snapshot;
        final (IconData icon, Color color, String text) = !presence.wanted
            ? (
                Icons.bluetooth,
                theme.colorScheme.onSurfaceVariant,
                '자동 연장: 열람실 A 이용 중일 때 켜져요',
              )
            : s.inRange
            ? (
                Icons.bluetooth_connected,
                Colors.green,
                '자리 확인됨 · ${s.rssi} dBm (기준 ${s.threshold})',
              )
            : s.piConnected
            ? (
                Icons.bluetooth_searching,
                Colors.orange,
                '신호 약함 · ${s.rssi ?? '-'} dBm (기준 ${s.threshold})',
              )
            : (Icons.bluetooth_disabled, Colors.orange, s.reason);
        return Material(
          color: theme.colorScheme.surfaceContainerHighest,
          child: SizedBox(
            height: 36,
            child: Row(
              children: [
                const SizedBox(width: 12),
                Icon(icon, size: 16, color: color),
                const SizedBox(width: 6),
                Expanded(
                  child: Text(
                    text,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: theme.textTheme.bodySmall,
                  ),
                ),
                PopupMenuButton<String>(
                  tooltip: '메뉴',
                  icon: const Icon(Icons.more_vert, size: 18),
                  onSelected: (v) => switch (v) {
                    'diag' => onDiagnostics(),
                    'threshold' => onThreshold(),
                    _ => onReload(),
                  },
                  itemBuilder: (_) => const [
                    PopupMenuItem(value: 'reload', child: Text('새로고침')),
                    PopupMenuItem(
                      value: 'threshold',
                      child: Text('자동 연장 신호 기준'),
                    ),
                    PopupMenuItem(
                      value: 'diag',
                      child: Text('블루투스 진단 (BLE 테스트)'),
                    ),
                  ],
                ),
              ],
            ),
          ),
        );
      },
    );
  }
}

class _ErrorView extends StatelessWidget {
  const _ErrorView({required this.message, required this.onRetry});

  final String message;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) => Center(
    child: Padding(
      padding: const EdgeInsets.all(24),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const Icon(Icons.wifi_off, size: 40),
          const SizedBox(height: 12),
          const Text('도서관 좌석 화면을 불러오지 못했습니다.'),
          Text(message, style: Theme.of(context).textTheme.bodySmall),
          const SizedBox(height: 12),
          FilledButton(onPressed: onRetry, child: const Text('다시 시도')),
        ],
      ),
    ),
  );
}
