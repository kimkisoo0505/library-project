import 'package:flutter/material.dart';

import '../services/ble_service.dart';
import '../utils/ble_constants.dart';
import '../utils/permission_manager.dart';
import '../widgets/connection_status.dart';
import 'device_scan_screen.dart';

/// Home: connection status (connecting arrives in step 4), target device,
/// and the entry point to BLE scanning (step 2).
class HomeScreen extends StatelessWidget {
  const HomeScreen({super.key, required this.ble, required this.permissions});

  final BleService ble;
  final PermissionManager permissions;

  @override
  Widget build(BuildContext context) {
    final textTheme = Theme.of(context).textTheme;

    return Scaffold(
      appBar: AppBar(title: const Text('도서관 BLE 테스트')),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            Card(
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('연결 상태', style: textTheme.labelLarge),
                    const SizedBox(height: 8),
                    // Fixed until connecting is implemented (step 4).
                    const ConnectionStatus(
                      state: AppConnectionState.disconnected,
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
                  builder: (_) =>
                      DeviceScanScreen(ble: ble, permissions: permissions),
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
