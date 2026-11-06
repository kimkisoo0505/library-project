import 'package:flutter/material.dart';

import '../utils/ble_constants.dart';
import '../widgets/connection_status.dart';

/// Step 1: static home screen. BLE status, scan and connect are wired up
/// in later steps (see mobile-app/README.md "개발 단계").
class HomeScreen extends StatelessWidget {
  const HomeScreen({super.key});

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
                    const ConnectionStatus(state: AppConnectionState.disconnected),
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
              // Enabled in step 2 (BLE scan).
              onPressed: null,
              icon: const Icon(Icons.search),
              label: const Text('기기 검색 (다음 단계에서 활성화)'),
            ),
          ],
        ),
      ),
    );
  }
}
