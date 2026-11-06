# 도서관 BLE 테스트 앱 (Android)

도서관 좌석 시스템의 Raspberry Pi 3 B+와 **BLE로 양방향 통신**하고 **RSSI(신호 세기)를 측정**하는
Flutter Android 앱입니다. 앱은 BLE Central, Pi는 Peripheral/GATT Server입니다.

- GATT UUID·메시지 형식: [`../docs/BLE_GATT_SPEC.md`](../docs/BLE_GATT_SPEC.md) (Pi 구현과 공유하는 기준 문서)
- 지원: Android 7.0 (API 24) 이상

## 개발 환경 (2026-11-06 확인)

| 항목 | 버전 |
|---|---|
| Flutter | 3.47.9 stable (Dart 3.13.7) |
| Android SDK | platform 36·37, build-tools 36.0.0, NDK 28.2.13676358 |
| JDK (Gradle용) | Android Studio 내장 JBR |
| AGP / Gradle / Kotlin | 9.1.0 / 9.3.1 / 2.4.0 |
| Android 설정 | `minSdk 24`, `targetSdk 36`, `compileSdk 37` (plugin AAR 요구사항) |

## 의존성 (버전 고정)

| 패키지 | 버전 | 라이선스 | 비고 |
|---|---|---|---|
| `flutter_reactive_ble` | 5.6.0 | BSD-3-Clause | Philips Hue 유지보수. Android 플러그인 `reactive_ble_mobile` 5.6.0 (minSdk 21, Flutter ≥3.44) |
| `permission_handler` | 13.0.2 | MIT | Android 플러그인 14.1.1 (minSdk 24) |

`pubspec.yaml`에서 `^` 없이 정확한 버전으로 고정했고, 전이 의존성은 `pubspec.lock`으로 고정됩니다.
업그레이드는 changelog와 빌드를 확인한 뒤 의도적으로만 합니다.

## 실행

```powershell
cd mobile-app
flutter pub get
flutter analyze
flutter test
flutter build apk --debug            # build\app\outputs\flutter-apk\app-debug.apk
flutter run                          # USB 디버깅 켠 기기 연결 후
```

> BLE는 에뮬레이터에서 동작하지 않습니다. 실제 기기에서 테스트하세요.

## Android BLE 권한

| Android 버전 | 필요한 권한 | 비고 |
|---|---|---|
| 7 ~ 11 (API 24–30) | `BLUETOOTH`, `BLUETOOTH_ADMIN`, `ACCESS_FINE_LOCATION` | 검색 결과를 받으려면 **위치 권한 + 기기의 위치 서비스(GPS) 켜짐** 필요 |
| 12 이상 (API 31+) | `BLUETOOTH_SCAN`(`neverForLocation`), `BLUETOOTH_CONNECT` | 위치 권한 불필요 |

선언 위치: `android/app/src/main/AndroidManifest.xml`. 런타임 요청은 `lib/utils/permission_manager.dart`(2단계).

## 테스트 기기

| 기기 | 출고 / 최종 Android | BLE | 실제 확인 |
|---|---|---|---|
| Galaxy Tab S3 | 7.0 / 9 | 4.2 | ☐ (기기에서 설정 → 휴대전화 정보로 확인 후 기록) |
| Galaxy Note FE | 7.0 / 9 | 5.0 | ☐ |
| Galaxy A8 Star | 8.0 / 9 | 5.0 | ☐ |

> 표의 버전은 일반적인 출고/업데이트 정보이며, 실제 기기에서 확인한 값으로 바꿔 적습니다.
> 세 기기 모두 Android 12 미만이 될 가능성이 높으므로 **위치 권한 경로(API 24–30)가 주 테스트 대상**입니다.

## 폴더 구조와 역할

```
lib/
├── main.dart                 앱 진입점 (runApp)
├── app.dart                  MaterialApp, 테마, 첫 화면
├── models/                   (단계 2+) BleDevice, BleMessage 데이터 클래스
├── services/                 (단계 2+) BLE·RSSI·송수신 로직. 화면은 이 계층만 사용
├── screens/
│   └── home_screen.dart      홈: 연결 상태, 대상 기기·Service UUID
├── widgets/
│   └── connection_status.dart 연결 상태 아이콘+텍스트 (앱 자체 enum 사용)
└── utils/
    └── ble_constants.dart    GATT UUID·기기 이름·메시지 최대 길이 (BLE_GATT_SPEC.md와 동일)
test/widget_test.dart         홈 화면 렌더링, UUID 일관성 테스트
```

이후 단계에서 추가될 파일: `models/ble_device.dart`, `models/ble_message.dart`,
`services/ble_service.dart`, `services/rssi_service.dart`, `services/communication_service.dart`,
`screens/device_scan_screen.dart`, `screens/device_detail_screen.dart`, `screens/communication_screen.dart`,
`widgets/signal_indicator.dart`, `widgets/device_list_item.dart`, `utils/permission_manager.dart`.

## 개발 단계

- [x] 1. 앱 기본 화면 — 프로젝트 생성, 의존성 고정, 권한 선언, 디버그 APK 빌드 확인
- [ ] 2. BLE 검색 — Bluetooth 상태 확인, 권한 요청, 기기 목록(이름·ID)
- [ ] 3. RSSI 표시 — 실측값/측정 시각/값 없음 구분
- [ ] 4. BLE 연결 — 연결·해제, 상태 표시, 끊김 감지
- [ ] 5. 데이터 송수신 — Command Write, Response Notify, 통신 기록
- [ ] 6. Raspberry Pi GATT 서버 연결 — Pi 측 구현과 실기 통신
- [ ] 7. 재연결 및 안정성 테스트
