import 'package:flutter_reactive_ble/flutter_reactive_ble.dart';

import '../models/ble_device.dart';
import '../utils/ble_constants.dart';
import '../utils/scan_throttle.dart';

/// Bluetooth adapter state as the app understands it.
enum AdapterState {
  unknown,
  unsupported,
  unauthorized,
  poweredOff,
  locationServicesDisabled,
  ready,
}

/// The only place that talks to flutter_reactive_ble. Screens use this class
/// and the models in `models/`, never the library types directly.
///
/// Step 2 scope: adapter status + scanning. Connecting comes in step 4.
class BleService {
  BleService({FlutterReactiveBle? ble}) : _injected = ble;

  final FlutterReactiveBle? _injected;

  /// Created on first use: constructing FlutterReactiveBle touches the
  /// platform plugin, which must not happen just by building the app.
  late final FlutterReactiveBle _ble = _injected ?? FlutterReactiveBle();

  /// Shared by every screen: Android counts scan starts per app.
  final ScanThrottle _throttle = ScanThrottle();

  /// Time until another scan may start ([Duration.zero] = now). Check this
  /// before [scan]; a 6th start within 30 s would silently find nothing.
  Duration waitBeforeNextScan() =>
      _throttle.waitBeforeNextStart(DateTime.now());

  /// Emits on Bluetooth on/off and location-service changes.
  /// Note: on Android this does NOT re-emit when the user grants a
  /// permission, so permission state is checked by PermissionManager instead.
  Stream<AdapterState> get adapterState => _ble.statusStream.map(_mapStatus);

  /// Scans until the returned stream's subscription is cancelled.
  ///
  /// [libraryPiOnly] filters by the library service UUID in the Bluetooth
  /// stack itself (cheaper than filtering in Dart).
  /// [requireLocationService] should be true on API 24–30 so that a disabled
  /// location service is reported as an error instead of silently finding
  /// nothing.
  Stream<BleDevice> scan({
    required bool libraryPiOnly,
    required bool requireLocationService,
  }) {
    _throttle.recordStart(DateTime.now());
    return _ble
        .scanForDevices(
          withServices: libraryPiOnly
              ? [Uuid.parse(BleConstants.serviceUuid)]
              : const [],
          scanMode: ScanMode.lowLatency,
          requireLocationServicesEnabled: requireLocationService,
        )
        .map(_mapDevice);
  }

  static BleDevice _mapDevice(DiscoveredDevice d) => BleDevice(
    id: d.id,
    name: d.name,
    rssi: d.rssi,
    lastSeen: DateTime.now(),
    serviceUuids: [for (final u in d.serviceUuids) u.toString().toLowerCase()],
    connectable: switch (d.connectable) {
      Connectable.available => true,
      Connectable.unavailable => false,
      Connectable.unknown => null,
    },
  );

  static AdapterState _mapStatus(BleStatus s) => switch (s) {
    BleStatus.unknown => AdapterState.unknown,
    BleStatus.unsupported => AdapterState.unsupported,
    BleStatus.unauthorized => AdapterState.unauthorized,
    BleStatus.poweredOff => AdapterState.poweredOff,
    BleStatus.locationServicesDisabled => AdapterState.locationServicesDisabled,
    BleStatus.ready => AdapterState.ready,
  };
}
