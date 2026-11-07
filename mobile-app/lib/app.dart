import 'package:flutter/material.dart';

import 'screens/home_screen.dart';
import 'screens/web_app_screen.dart';
import 'services/ble_service.dart';
import 'services/communication_service.dart';
import 'services/presence_service.dart';
import 'utils/permission_manager.dart';

class LibraryBleApp extends StatelessWidget {
  /// Services are created once and shared by all screens (the BLE connection
  /// lives in [BleService]). Tests can inject fakes.
  ///
  /// [webHome]: true (default) opens the kiosk web page in app mode;
  /// false opens the BLE diagnostics screen directly (tests).
  LibraryBleApp({
    super.key,
    BleService? ble,
    PermissionManager? permissions,
    this.webHome = true,
  }) : ble = ble ?? BleService(),
       permissions = permissions ?? PermissionManager() {
    comm = CommunicationService(this.ble);
    presence = PresenceService(this.ble, this.permissions);
  }

  final BleService ble;
  final PermissionManager permissions;
  final bool webHome;
  late final CommunicationService comm;
  late final PresenceService presence;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: '도서관 좌석',
      theme: ThemeData(colorSchemeSeed: Colors.indigo, useMaterial3: true),
      darkTheme: ThemeData(
        colorSchemeSeed: Colors.indigo,
        brightness: Brightness.dark,
        useMaterial3: true,
      ),
      home: webHome
          ? WebAppScreen(
              ble: ble,
              permissions: permissions,
              comm: comm,
              presence: presence,
            )
          : HomeScreen(ble: ble, permissions: permissions, comm: comm),
    );
  }
}
