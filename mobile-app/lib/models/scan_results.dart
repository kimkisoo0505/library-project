import 'ble_device.dart';

/// Devices whose last advertisement is older than this are shown as
/// "signal lost" with their last measured RSSI, not as a current value.
const Duration staleAfter = Duration(seconds: 10);

/// Accumulates scan results, keyed by device id (latest advertisement wins).
class ScanResults {
  final Map<String, BleDevice> _byId = {};

  int get length => _byId.length;
  bool get isEmpty => _byId.isEmpty;

  void add(BleDevice d) => _byId[d.id] = d;
  void clear() => _byId.clear();

  /// Display order: library Pi first, then devices currently in range by
  /// signal strength (strongest first), then devices whose signal was lost.
  List<BleDevice> view({required DateTime now, required bool hideUnnamed}) {
    final list = _byId.values
        .where((d) => !hideUnnamed || d.hasName || d.isLibraryPi)
        .toList();
    int rank(BleDevice d) =>
        d.isLibraryPi ? 0 : (d.age(now) > staleAfter ? 2 : 1);
    list.sort((a, b) {
      final r = rank(a).compareTo(rank(b));
      if (r != 0) return r;
      final s = b.rssi.compareTo(a.rssi);
      return s != 0 ? s : a.id.compareTo(b.id);
    });
    return list;
  }
}
