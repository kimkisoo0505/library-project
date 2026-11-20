# BLE GATT 명세 (모바일 앱 ↔ Raspberry Pi)

Android 앱(`mobile-app/`, BLE **Central**)과 Raspberry Pi 3 B+(BLE **Peripheral / GATT Server**)가
공유하는 단일 기준 문서입니다. UUID나 메시지 형식을 바꾸면 이 문서, 앱의
`mobile-app/lib/utils/ble_constants.dart`, Pi 측 GATT 서버 구현을 **함께** 수정합니다.

> 상태: v0 (연결·송수신 테스트 단계). 좌석 예약·하드웨어 제어 명령은 아직 없습니다.
>
> 구현: Pi `raspberry-pi/agent/ble_protocol.py`(명령 처리), `agent/ble_server.py`(GATT 서버, `library-ble` 서비스) /
> 앱 `mobile-app/lib/utils/ble_constants.dart`.

## 1. 광고 (Advertising)

| 항목 | 값 |
|---|---|
| Local Name | `LIB-SEAT-PI` (최대 11자, 31바이트 광고 패킷 안에 Service UUID와 함께 들어가도록 짧게 유지) |
| 광고 Service UUID | 아래 서비스 UUID |
| 연결 가능 | 예 (connectable) |

앱은 검색 시 Service UUID로 필터링할 수 있고, 테스트 중에는 필터 없이 전체 기기도 볼 수 있습니다.

## 2. 서비스와 특성

공통 접미사 `-18b4-466c-94a3-08bcf22ef878` (무작위 생성한 128-bit UUID 기반).

| 이름 | UUID | 속성 | 방향 | 용도 |
|---|---|---|---|---|
| Service | `27fb1000-18b4-466c-94a3-08bcf22ef878` | — | — | 도서관 좌석 BLE 서비스 |
| Command | `27fb1001-18b4-466c-94a3-08bcf22ef878` | Write, Write Without Response | 앱 → Pi | 명령 전송 |
| Response | `27fb1002-18b4-466c-94a3-08bcf22ef878` | Notify | Pi → 앱 | 명령 응답·이벤트 |
| Status | `27fb1003-18b4-466c-94a3-08bcf22ef878` | Read | 앱 ← Pi | 현재 상태 조회 |

Response 특성은 CCCD(`0x2902`) 디스크립터를 가지며, 앱이 구독(Notify 활성화)해야 응답을 받습니다.

## 3. 메시지 형식

Arduino 시리얼 프로토콜과 같은 스타일의 **쉼표 구분 ASCII 한 줄**입니다(UTF-8, 줄바꿈 없음).

- 한 메시지 최대 **20바이트** — 기본 ATT MTU(23)에서 분할 없이 전송되는 크기. Android 7 기기 호환을 위해 MTU 협상에 의존하지 않습니다.
- `<seq>`: 앱이 붙이는 0~999 순번. 응답에 같은 값을 되돌려 요청·응답을 짝짓습니다.

| 앱 → Pi (Command) | Pi → 앱 (Response) | 설명 |
|---|---|---|
| `PING,<seq>` | `PONG,<seq>` | 왕복 시간(RTT) 측정 |
| `ECHO,<seq>,<text>` | `ECHO,<seq>,<text>` | 송수신 확인. `<text>`는 영숫자만 |
| `INFO,<seq>` | `INFO,<seq>,<ver>` | Pi GATT 서버 버전 |
| (그 외 모든 명령) | `ERR,<seq>,UNKNOWN` | 알 수 없는 명령 |
| (형식 오류) | `ERR,0,BAD_FORMAT` | 파싱 실패 / 20바이트 초과 / 줄바꿈 포함 |
| (너무 잦은 명령) | `ERR,<seq>,BUSY` | 1초에 10개 초과. seq를 읽을 수 없으면 0 |

Status(Read) 값: `OK,<uptime_s>` 형식(예: `OK,3600`). `uptime_s`는 BLE 서버 프로세스 실행 시간(초).

`INFO`의 `<ver>`는 현재 `0.1`.

## 4. 보안·안전 규칙

1. **BLE 명령으로 하드웨어를 구동하지 않는다.** v0 명령은 모두 부작용이 없는 조회·응답뿐이다. 서보모터 제어는 구현하지 않는다(CLAUDE.md 규칙 7).
2. **BLE로 좌석 예약을 승인하지 않는다.** 좌석 상태의 기준은 D1이며, Pi는 BLE 입력만으로 예약 상태를 바꾸지 않는다(CLAUDE.md 규칙 1).
3. **개인정보를 싣지 않는다.** 학번·이름·비밀번호·세션 토큰을 BLE로 보내지 않는다. BLE 광고·통신은 근처 누구나 엿들을 수 있다고 가정한다.
4. 향후 상태를 바꾸는 명령을 추가할 때는 그 전에 인증 방식(예: 서버가 발급한 일회용 토큰을 Pi가 서버에 검증)을 이 문서에 먼저 설계한다.
5. 알 수 없는 명령·형식 오류는 거부하고 Pi 로그(`logger.log_event`)에 기록한다(내용 중 민감 정보는 기록하지 않음).

## 5. RSSI

RSSI는 **앱(Central)이 측정**합니다. 검색 중에는 광고 패킷 수신 시점의 값이며, 연결 중에는
`readRssi`로 주기적으로 읽습니다. 앱은 실제 측정값, 측정 시각, 측정 실패(값 없음)를 구분해 표시하고,
측정값이 없을 때 추정값을 만들어 채우지 않습니다.

## 6. 모바일 웹 클라이언트 (Web Bluetooth)

앱이 없는 휴대폰에서도 키오스크 웹(`web/kiosk/src/personal/web-ble.js`, 개인 사용 화면 `#/personal`)이 브라우저의 Web Bluetooth 로 같은 GATT 서비스에 연결합니다.

- 지원: Android 의 Chrome · Edge · 삼성 인터넷 등 (https 필요). iPhone(Safari)·Firefox 는 Web Bluetooth 미지원 → 앱 안내만 표시.
- **개인 사용 모드에서만** 보입니다. 화면 상단의 [개인 사용 | 키오스크] 토글로 고르며, 휴대폰은 개인 사용, PC·입구 기기는 키오스크가 기본입니다(선택은 기기에 기억). 키오스크 모드로 바꾸면 연결을 바로 끊습니다. 앱(WebView)은 항상 개인 사용이고 토글이 없습니다.
- 처음 연결은 사용자가 [블루투스로 자리 확인 켜기]를 눌러 기기 선택 창에서 `LIB-SEAT-PI` 를 고릅니다 (서비스 UUID 필터).
  이후 끊기면 자동 재연결(2·4·8·16·30초, 최대 10회), `getDevices()` 지원 브라우저는 새로고침 후에도 선택 창 없이 재연결.
- 보내는 명령은 `PING,<seq>` 하나뿐 (10초마다). 개인정보·토큰은 BLE 로 보내지 않습니다.
- **RSSI 를 쓸 수 없습니다** (Web Bluetooth 미제공). 그래서 "연결되어 있고 마지막 `PONG` 이 25초 이내" 를 재실로 판단합니다.
  `PONG` 을 2번 연속 놓치면 연결을 끊고 다시 연결합니다. 앱의 RSSI 기준(기본 -85 dBm)보다 범위가 넓어 덜 정밀합니다.
- 재실이면 웹이 자기 학생 세션으로 `POST /api/reservations/me/presence` 를 1분에 최대 1번 보냅니다 (앱과 같은 서버 API, 같은 위조 가능성 한계).
- **블루투스 착석 확인 (2026-11-20)**: 열람실 A 를 **예약한 상태**에서도 블루투스를 켭니다(앱에는 `presenceWanted: true`). 재실(`inRange`)일 때만 [착석] 버튼이 활성화됩니다. 화면에서만 막는 기능으로 서버는 확인하지 않으며, 키오스크 모드 화면과 장치가 없는 열람실은 예외입니다. 착석 전 예약 단계에서는 재실 보고(`presence`)를 보내지 않습니다.
- 화면을 켜 둔 동안만 동작합니다 (브라우저가 백그라운드에서 멈춤). 블루투스를 켠 동안에는 키오스크 자동 로그아웃(90초)을 적용하지 않습니다.
