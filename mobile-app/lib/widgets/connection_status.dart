import 'package:flutter/material.dart';

/// App-level connection state, independent of the BLE library's types so
/// screens do not depend on flutter_reactive_ble directly.
enum AppConnectionState { disconnected, connecting, connected, disconnecting }

class ConnectionStatus extends StatelessWidget {
  const ConnectionStatus({super.key, required this.state, this.deviceName});

  final AppConnectionState state;
  final String? deviceName;

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
        '연결 중…',
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
