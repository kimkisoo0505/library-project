import 'package:flutter/material.dart';

import '../services/ble_service.dart';
import '../services/communication_service.dart';
import '../utils/ble_constants.dart';
import '../utils/permission_manager.dart';
import '../widgets/connection_status.dart';
import 'communication_screen.dart';
import 'device_scan_screen.dart';

/// Home: connection status (connecting arrives in step 4), target device,
/// and the entry point to BLE scanning (step 2).
class HomeScreen extends StatelessWidget {
  const HomeScreen({
    super.key,
    required this.ble,
    required this.permissions,
    this.comm,
  });

  final BleService ble;
  final PermissionManager permissions;
  final CommunicationService? comm;

  @override
  Widget build(BuildContext context) {
    final textTheme = Theme.of(context).textTheme;

    return Scaffold(
      appBar: AppBar(title: const Text('도서관 BLE 테스트')),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            // Rebuilds whenever the shared connection changes.
            ListenableBuilder(
              listenable: ble,
              builder: (context, _) {
                final c = ble.connection;
                final ended = lastEndText(c);
                return Card(
                  child: Padding(
                    padding: const EdgeInsets.all(16),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text('연결 상태', style: textTheme.labelLarge),
                        const SizedBox(height: 8),
                        Row(
                          children: [
                            Expanded(
                              child: ConnectionStatus(
                                state: c.state,
                                reconnectAttempt: c.reconnectAttempt,
                                deviceName:
                                    c.state == AppConnectionState.disconnected
                                    ? null
                                    : (c.deviceName ?? c.deviceId),
                              ),
                            ),
                            if (c.state == AppConnectionState.connected)
                              TextButton(
                                onPressed: ble.disconnect,
                                child: const Text('연결 해제'),
                              ),
                            if (c.waitingReconnect)
                              TextButton(
                                onPressed: ble.disconnect,
                                child: const Text('재연결 중지'),
                              ),
                          ],
                        ),
                        if (comm != null &&
                            c.isConnected &&
                            (c.gatt?.isLibraryPi ?? false)) ...[
                          const SizedBox(height: 8),
                          FilledButton.tonalIcon(
                            onPressed: () => Navigator.of(context).push(
                              MaterialPageRoute<void>(
                                builder: (_) =>
                                    CommunicationScreen(ble: ble, comm: comm!),
                              ),
                            ),
                            icon: const Icon(Icons.swap_vert),
                            label: const Text('Pi 통신 테스트'),
                          ),
                        ],
                        if (ended != null) ...[
                          const SizedBox(height: 4),
                          Text(
                            ended,
                            style: textTheme.bodySmall?.copyWith(
                              color: endedUnexpectedly(c)
                                  ? Theme.of(context).colorScheme.error
                                  : Theme.of(context)
                                        .colorScheme
                                        .onSurfaceVariant,
                            ),
                          ),
                        ],
                      ],
                    ),
                  ),
                );
              },
            ),
            const SizedBox(height: 12),
            Card(
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('대상 기기', style: textTheme.labelLarge),
                    const SizedBox(height: 8),
                    Text(BleConstants.deviceName, style: textTheme.titleMedium),
                    const SizedBox(height: 4),
                    SelectableText(
                      'Service ${BleConstants.serviceUuid}',
                      style: textTheme.bodySmall,
                    ),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 24),
            FilledButton.icon(
              onPressed: () => Navigator.of(context).push(
                MaterialPageRoute<void>(
                  builder: (_) => DeviceScanScreen(
                    ble: ble,
                    permissions: permissions,
                    comm: comm,
                  ),
                ),
              ),
              icon: const Icon(Icons.search),
              label: const Text('기기 검색'),
            ),
          ],
        ),
      ),
    );
  }
}
