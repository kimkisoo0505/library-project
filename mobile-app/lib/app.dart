import 'package:flutter/material.dart';

import 'screens/home_screen.dart';

class LibraryBleApp extends StatelessWidget {
  const LibraryBleApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: '도서관 BLE 테스트',
      theme: ThemeData(
        colorSchemeSeed: Colors.indigo,
        useMaterial3: true,
      ),
      darkTheme: ThemeData(
        colorSchemeSeed: Colors.indigo,
        brightness: Brightness.dark,
        useMaterial3: true,
      ),
      home: const HomeScreen(),
    );
  }
}
