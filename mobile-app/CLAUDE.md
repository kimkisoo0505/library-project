# CLAUDE.md — mobile-app (Android BLE 앱)

상위 저장소의 `../CLAUDE.md` 규칙을 모두 따르며, 이 폴더에는 아래 규칙을 추가로 적용합니다.

## 범위

- Flutter Android 앱. BLE Central로 Raspberry Pi(GATT Server)와 통신하고 RSSI를 측정한다.
- GATT UUID·메시지 형식의 기준은 `../docs/BLE_GATT_SPEC.md`. 바꾸면 `lib/utils/ble_constants.dart`와 Pi 구현을 함께 바꾼다.
- 이 앱 작업 중에는 `mobile-app/` 밖의 기존 서버·키오스크·에이전트 파일을 수정하거나 삭제하지 않는다 (`docs/BLE_GATT_SPEC.md` 제외).

## 안전·보안 규칙

1. BLE 명령으로 하드웨어(서보모터 등)를 구동하는 기능을 만들지 않는다.
2. 앱·BLE에서 좌석 예약을 승인하지 않는다. 좌석 상태의 기준은 D1(서버)이다.
3. 학번·이름·비밀번호·세션 토큰을 BLE로 보내지 않는다. BLE는 도청 가능하다고 가정한다.
4. 상태를 바꾸는 BLE 명령을 추가하려면 먼저 인증 방식을 `BLE_GATT_SPEC.md`에 설계한다.
5. RSSI는 실제 측정값만 표시하고, 측정 시각과 "값 없음"을 구분한다. 추정·보간값을 실측처럼 보이지 않게 한다.
6. 연결 끊김·전송 실패는 반드시 사용자에게 보이게 처리한다 (예외를 삼키지 않음).

## 호환성 규칙

- `minSdk 24` (Android 7.0) 유지. API 31 미만에서는 위치 권한 + 위치 서비스 켜짐이 BLE 검색에 필요하다.
- 한 BLE 메시지는 20바이트 이하 (MTU 협상에 의존하지 않음).
- 의존성은 `pubspec.yaml`에 정확한 버전으로 고정한다. 업그레이드 시 라이선스, 최소 SDK, 빌드를 확인한다.
- `compileSdk 37`은 plugin AAR 요구사항 때문이다. `targetSdk`를 올리는 것은 런타임 동작 변경이므로 따로 검토한다.

## 코드 구조

- 화면(`screens/`)은 `flutter_reactive_ble` 타입을 직접 쓰지 않고 `services/`와 `models/`만 사용한다.
- 단계별로 진행한다 (README "개발 단계"). 한 단계를 빌드·테스트로 확인한 뒤 다음 단계로 간다.

## 명령

```powershell
cd mobile-app
flutter analyze; flutter test; flutter build apk --debug
```
