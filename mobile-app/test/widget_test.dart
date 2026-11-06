import 'package:flutter_test/flutter_test.dart';

import 'package:library_ble/app.dart';
import 'package:library_ble/utils/ble_constants.dart';

void main() {
  testWidgets('home screen shows disconnected state and target device', (tester) async {
    await tester.pumpWidget(const LibraryBleApp());

    expect(find.text('연결 안 됨'), findsOneWidget);
    expect(find.text(BleConstants.deviceName), findsOneWidget);
  });

  test('GATT UUIDs share the service base and are distinct', () {
    const all = [
      BleConstants.serviceUuid,
      BleConstants.commandCharUuid,
      BleConstants.responseCharUuid,
      BleConstants.statusCharUuid,
    ];
    expect(all.toSet().length, all.length);
    for (final u in all) {
      expect(u.endsWith('-18b4-466c-94a3-08bcf22ef878'), isTrue);
    }
  });
}
