import 'package:flutter/material.dart';

import 'screens/home_screen.dart';
import 'services/ble_service.dart';
import 'services/communication_service.dart';
import 'utils/permission_manager.dart';

class LibraryBleApp extends StatelessWidget {
  /// Services are created once and shared by all screens (later steps keep
  /// the BLE connection in [BleService]). Tests can inject fakes.
  LibraryBleApp({super.key, BleService? ble, PermissionManager? permissions})
    : ble = ble ?? BleService(),
      permissions = permissions ?? PermissionManager() {
    comm = CommunicationService(this.ble);
  }

  final BleService ble;
  final PermissionManager permissions;
  late final CommunicationService comm;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: '도서관 BLE 테스트',
      theme: ThemeData(colorSchemeSeed: Colors.indigo, useMaterial3: true),
      darkTheme: ThemeData(
        colorSchemeSeed: Colors.indigo,
        brightness: Brightness.dark,
        useMaterial3: true,
      ),
      home: HomeScreen(ble: ble, permissions: permissions, comm: comm),
    );
  }
}
