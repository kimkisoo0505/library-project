import 'package:flutter/material.dart';

/// Signal level 0–4 from a measured RSSI. These are rough, commonly used
/// bands for BLE; they describe signal strength only, not distance.
int signalLevel(int rssi) {
  if (rssi >= -60) return 4;
  if (rssi >= -70) return 3;
  if (rssi >= -80) return 2;
  if (rssi >= -90) return 1;
  return 0;
}

String signalLabel(int rssi) =>
    const ['매우 약함', '약함', '보통', '강함', '매우 강함'][signalLevel(rssi)];

/// Four signal bars. [rssi] == null means "no current measurement": all bars
/// are drawn as empty outlines rather than guessing a level.
class SignalIndicator extends StatelessWidget {
  const SignalIndicator({super.key, required this.rssi, this.size = 20});

  final int? rssi;
  final double size;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final level = rssi == null ? 0 : signalLevel(rssi!);
    final active = switch (level) {
      4 || 3 => Colors.green,
      2 => Colors.orange,
      _ => Colors.red,
    };
    final barWidth = size / 6;

    return Semantics(
      label: rssi == null ? '신호 값 없음' : '신호 ${signalLabel(rssi!)}',
      child: SizedBox(
        width: size,
        height: size,
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.end,
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            for (var i = 1; i <= 4; i++)
              Container(
                width: barWidth,
                height: size * i / 4,
                decoration: BoxDecoration(
                  color: rssi != null && i <= level
                      ? active
                      : Colors.transparent,
                  border: Border.all(color: scheme.outline, width: 1),
                  borderRadius: BorderRadius.circular(1),
                ),
              ),
          ],
        ),
      ),
    );
  }
}
