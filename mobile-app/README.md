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

선언 위치: `android/app/src/main/AndroidManifest.xml`. 런타임 요청은 `lib/utils/permission_manager.dart`.

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
├── main.dart                    앱 진입점 (runApp)
├── app.dart                     MaterialApp, 테마. BleService·PermissionManager를 한 번 만들어 화면에 전달
├── models/
│   ├── ble_connection.dart      연결 상태·끊김 사유·GATT 검증·Status 해석 (순수 로직)
│   ├── ble_message.dart         통신 기록 항목, 명령 만들기·검증(20바이트), 응답 해석, 순번 1~999
│   ├── ble_device.dart          검색된 기기 (id, 이름, RSSI, 측정 시각, 서비스 UUID, 연결 가능 여부)
│   └── scan_results.dart        검색 결과 누적·정렬·필터 (Pi 우선 → 신호 세기순 → 신호 끊김)
├── services/
│   ├── ble_service.dart         flutter_reactive_ble를 쓰는 유일한 계층 (블루투스 상태, 검색, 검색 횟수 제한, 앱 전체 연결 1개 관리)
│   ├── communication_service.dart Pi 응답 알림 자동 구독, 명령↔응답 짝짓기(순번), 왕복 시간, 3초 시간 초과, PING 10회
│   └── rssi_service.dart        한 기기의 RSSI 실측값 기록 (최근 60초, 5초 넘게 수신 없으면 "값 없음"), 통계
├── screens/
│   ├── home_screen.dart         홈: 연결 상태, 대상 기기·Service UUID, 기기 검색 진입
│   ├── communication_screen.dart PING/INFO/ECHO/직접 입력, PING 10회, 통신 기록·요약
│   ├── device_scan_screen.dart  권한·블루투스·위치 상태 확인, 15초 검색, 기기 목록 (누르면 측정 화면)
│   └── device_detail_screen.dart 선택 기기 연결·해제, GATT 확인, Status 읽기, RSSI 연속 측정(광고/연결 구분)
├── widgets/
│   ├── connection_status.dart   연결 상태 아이콘+텍스트
│   ├── device_list_item.dart    기기 한 줄: 이름/ID, 신호 막대, RSSI(dBm)와 측정 시각, 10초 넘으면 "신호 끊김"
│   └── signal_indicator.dart    4칸 신호 막대 (값 없음 = 빈 막대)
└── utils/
    ├── ble_constants.dart       GATT UUID·기기 이름·메시지 최대 길이 (BLE_GATT_SPEC.md와 동일)
    ├── permission_manager.dart  Android 버전별 권한 요청, 위치 서비스·블루투스 켜기 안내
    └── scan_throttle.dart       Android의 "30초에 검색 5회" 제한을 미리 막고 안내
android/.../MainActivity.kt      네이티브 채널 library_ble/device: SDK 버전, 블루투스 켜기 창, 위치 설정 열기
test/widget_test.dart            홈 화면, UUID 일관성, 정렬·필터, 검색 횟수 제한 테스트
test/rssi_test.dart              RSSI 기록·"값 없음" 전환·통계·신호 단계 테스트
test/communication_test.dart     가짜 Pi로 송수신·거부·시간 초과·전송 실패·끊김 처리 테스트
test/reconnect_test.dart         자동 재연결(간격·포기·중지·끄기·강제 재연결) 테스트 (실제 시간, ms 단위)
test/connection_test.dart        상태 전환·끊김 사유, GATT 검증, 가짜 BLE로 연결→끊김 화면 흐름
test/detail_screen_test.dart     가짜 BLE로 측정 화면 동작 테스트 (선택 기기만 반영, 중지 시 값 없음)
```


### 2단계 동작 요약

- 검색 전에 순서대로 확인: 권한 → (Android 11 이하) 위치 서비스 → 블루투스 켜짐. 막힌 항목은 상단 카드에 이유와 해결 버튼으로 표시
- 검색은 15초 후 자동 종료, 앱이 백그라운드로 가면 중지, 블루투스가 꺼지면 중지하고 안내
- RSSI는 휴대폰이 실제로 받은 값만 표시. 10초 넘게 광고가 안 오면 값에 취소선 + "신호 끊김 · N초 전" (추정값 없음)
- 에뮬레이터에는 실제 무선이 없어 검색 결과는 0대가 정상. 실제 기기 목록은 실기기에서 확인

### 3단계 동작 요약 (RSSI)

- 목록에서 기기를 누르면 목록 검색을 멈추고, 그 기기의 광고만 받아 RSSI를 계속 측정 (연결 없이 측정)
- 표시: 현재 실측값과 신호 막대, 수신 후 경과 시간. 5초 넘게 광고가 없으면 "값 없음"과 마지막 실측값을 따로 표시
- 최근 60초 그래프는 받은 값만 점으로 표시 (선 연결·보간 없음), 최근 5초 평균은 "평균"과 표본 수를 함께 표시
- 신호 단계: -60 이상 매우 강함 / -70 강함 / -80 보통 / -90 약함 / 그 미만 매우 약함. 거리 추정은 하지 않음
- 5분 후 자동 중지(배터리), 백그라운드·블루투스 꺼짐 시 중지. 검색 횟수 제한(30초 5회)은 화면 간에 공유
### 4단계 동작 요약 (연결)

- 측정 화면의 "연결" 버튼으로 연결 (10초 안에 안 되면 "시간 초과"). 연결 중에는 "연결 취소"
- 연결은 앱 전체에서 1개만 유지 — 화면을 나가도 유지되고 홈 화면에 실제 상태 표시, 홈에서도 해제 가능
- 연결 후 서비스 탐색으로 도서관 서비스·Command(쓰기)·Response(알림)·Status(읽기) 확인 → "도서관 라즈베리파이로 확인"
- Status 특성을 읽어 `OK,<초>` 와 Pi 서버 실행 시간 표시 (다시 읽기 가능)
- 끊김 사유 구분: 사용자 해제 / 연결 끊어짐(범위 밖·전원 꺼짐) / 시간 초과 / 연결 실패 + 시각. 의도치 않은 끊김은 빨간색과 알림
- 연결 중 RSSI는 연결로 1초마다 읽음(청록 점), 연결 전·끊긴 뒤에는 광고로 측정(파란 점)
- 자동 재연결은 7단계에서 추가 (지금은 끊기면 버튼으로 다시 연결)
### 5단계 동작 요약 (송수신)

- 도서관 Pi로 확인된 연결이면 Response 알림을 자동 구독 → 홈·측정 화면에 "Pi 통신 테스트" 버튼
- PING / INFO / ECHO(영문·숫자 최대 11자) / 직접 입력(최대 20바이트, Pi 오류 응답 시험용)
- 보낸 명령은 같은 순번의 응답과 짝지어 왕복 시간(ms) 표시. Pi가 ERR 로 답하면 "거부됨"
- 3초 안에 응답이 없으면 "시간 초과", 쓰기 실패는 "전송 실패", 기다리는 중 끊기면 "연결 끊김"
- PING 10회 (0.3초 간격, Pi 속도 제한 1초 10개 이하): 응답 수·손실·평균/최소/최대 왕복 시간
- 통신 기록은 앱 메모리에만 최근 300개 (파일·서버로 보내지 않음)
### 7단계 동작 요약 (재연결·안정성)

- 의도치 않게 끊기면 자동 재연결: 2·4·8·16·30초 간격, 최대 10회(약 3.5분) 후 중지. 직접 해제하면 재연결 안 함
- 재연결 대기 중에는 "재연결 중지" 버튼, 화면에 "자동 재연결 3/10 (4초 후)" 표시. 통신 화면에서 자동 재연결 끄기 가능
- 연결 확인: 15초마다 조용히 PING(기록에 안 남음), 2회 연속 응답 없으면 연결을 끊고 다시 맺음
- 통신 화면 "안정성" 패널: 연결·끊김·재연결 성공 횟수, 현재 연결 유지 시간, 연결 확인 성공/실패
- 연속 시험 1·5·30분 (1초마다 PING): 성공률, 시간 초과·끊김·건너뜀, 왕복 시간 중앙값/95%/최대. 끊겨도 계속 진행해 재연결까지 시험
- 백그라운드: 앱이 화면에 없을 때의 동작은 아직 보장하지 않음 (Android 백그라운드 BLE 제한 — 자동 연장 단계에서 다룸)

## 개발 단계

- [x] 1. 앱 기본 화면 — 프로젝트 생성, 의존성 고정, 권한 선언, 디버그 APK 빌드 확인
- [x] 2. BLE 검색 — Bluetooth 상태 확인, 권한 요청, 기기 목록(이름·ID·실측 RSSI)
- [x] 3. RSSI 표시 — 실측값/측정 시각/값 없음 구분, 신호 막대, 60초 그래프
- [x] 4. BLE 연결 — 연결·해제, 상태 표시, 끊김 감지, GATT 확인, Status 읽기
- [x] 5. 데이터 송수신 — Command Write, Response Notify, 통신 기록, 왕복 시간, 시간 초과·전송 실패 처리
- [x] 6. Raspberry Pi GATT 서버 연결 — Pi 측 구현(library-ble)과 실기 통신 확인 (2026-11-07)
- [x] 7. 재연결 및 안정성 테스트 — 자동 재연결, 연결 확인(keepalive), 연속 시험
