import 'package:flutter/material.dart';

import '../models/ble_device.dart';
import '../models/scan_results.dart';
import 'signal_indicator.dart';

/// One scanned device. RSSI is shown exactly as measured, together with how
/// long ago it was measured; a lost signal is shown as such (no estimate).
class DeviceListItem extends StatelessWidget {
  const DeviceListItem({
    super.key,
    required this.device,
    required this.now,
    this.onTap,
  });

  final BleDevice device;
  final DateTime now;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final ageSec = device.age(now).inSeconds;
    final stale = device.age(now) > staleAfter;
    final muted = theme.colorScheme.onSurfaceVariant;

    final subtitle = [
      device.id,
      if (device.connectable == true) '연결 가능',
      if (device.connectable == false) '연결 불가',
    ].join(' · ');

    return ListTile(
      onTap: onTap,
      leading: Icon(
        device.isLibraryPi ? Icons.developer_board : Icons.bluetooth,
        color: device.isLibraryPi ? theme.colorScheme.primary : muted,
      ),
      title: Text(
        device.hasName ? device.name : '(이름 없음)',
        style: TextStyle(
          fontWeight: device.isLibraryPi ? FontWeight.bold : null,
          color: device.hasName && !stale ? null : muted,
        ),
      ),
      subtitle: Text(subtitle, style: theme.textTheme.bodySmall),
      trailing: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        crossAxisAlignment: CrossAxisAlignment.end,
        children: [
          Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              // Lost signal → empty bars (no current value), not old level.
              SignalIndicator(rssi: stale ? null : device.rssi, size: 14),
              const SizedBox(width: 6),
              Text(
                '${device.rssi} dBm',
                style: theme.textTheme.titleSmall?.copyWith(
                  color: stale ? muted : null,
                  decoration: stale ? TextDecoration.lineThrough : null,
                ),
              ),
            ],
          ),
          Text(
            stale
                ? '신호 끊김 · $ageSec초 전'
                : (ageSec == 0 ? '방금 측정' : '$ageSec초 전 측정'),
            style: theme.textTheme.bodySmall?.copyWith(color: muted),
          ),
        ],
      ),
    );
  }
}
