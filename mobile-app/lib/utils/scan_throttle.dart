/// Android (7+) silently returns no results when an app starts more than
/// 5 BLE scans within 30 seconds. This guard refuses the 6th start up front
/// so the user gets a clear message instead of an empty list.
class ScanThrottle {
  ScanThrottle({this.maxStarts = 5, this.window = const Duration(seconds: 30)});

  final int maxStarts;
  final Duration window;
  final List<DateTime> _starts = [];

  /// Time to wait before another start is allowed; [Duration.zero] if allowed now.
  Duration waitBeforeNextStart(DateTime now) {
    _starts.removeWhere((t) => now.difference(t) >= window);
    if (_starts.length < maxStarts) return Duration.zero;
    return window - now.difference(_starts.first);
  }

  void recordStart(DateTime now) => _starts.add(now);
}
