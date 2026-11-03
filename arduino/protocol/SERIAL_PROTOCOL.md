# 시리얼 통신 프로토콜 (Raspberry Pi ↔ Arduino) v0.1

## 1. 물리 계층

| 항목 | 값 |
|---|---|
| 연결 | USB (Arduino UNO R3 → Raspberry Pi, `/dev/ttyACM0` 예상) |
| 속도 | 115200 bps, 8N1 |
| 인코딩 | ASCII |
| 줄 끝 | `\n` (수신 측은 `\r` 무시) |
| 최대 길이 | 64자 (줄 끝 제외) |

> UNO는 USB 시리얼 포트가 열릴 때 자동 리셋됩니다. 에이전트는 연결 직후 `HELLO`를 기다리며, 그 전에 보낸 명령은 유실될 수 있습니다.

## 2. 메시지 형식

```
KIND[,FIELD1[,FIELD2]]\n
```

- `KIND`: 대문자 명령/이벤트 이름
- `FIELD`: `A-Z 0-9 _ . -` 만 허용, 1~24자
- 쉼표·줄바꿈이 필드에 들어갈 수 없음 (주입 방지)
- 형식이 틀린 줄은 수신 측에서 **버리고 로그만 남김** (상태 변경 없음)

## 3. Arduino → Raspberry Pi

| 메시지 | 의미 | 예 |
|---|---|---|
| `HELLO,<version>` | 부팅 완료, 펌웨어 버전 | `HELLO,0.1.0` |
| `BTN,<id>,<PRESS\|LONG>` | 버튼 입력 (뗄 때 전송, 1.5초 이상이면 LONG) | `BTN,2,PRESS` |
| `PONG,<seq>` | PING 응답 | `PONG,17` |
| `ACK,<command>[,<value>]` | 명령 처리 완료 | `ACK,STATUS,ONLINE` |
| `ERR,<code>[,<detail>]` | 오류 | `ERR,SERVO_DISABLED` |

오류 코드: `EMPTY`, `BAD_ARGS`, `UNKNOWN_CMD`, `LINE_TOO_LONG`, `SERVO_DISABLED`

## 4. Raspberry Pi → Arduino

| 명령 | 의미 | 응답 |
|---|---|---|
| `PING,<seq>` | 연결 확인 (기본 10초 간격) | `PONG,<seq>` |
| `STATUS,<ONLINE\|OFFLINE>` | 클라우드 연결 상태 알림 (향후 LED 표시용) | `ACK,STATUS,<값>` |
| `SERVO,...` | **예약됨 — 현재 비활성** | `ERR,SERVO_DISABLED` |

에이전트의 `build_command()`는 `SERVO` 명령 생성을 거부하며, 펌웨어도 이를 거부합니다(이중 차단).

## 5. 연결 상태 판단 및 장애 처리

| 상황 | Arduino | 에이전트 |
|---|---|---|
| USB 분리/오류 | — | 로그 기록, 5초 간격 재연결, **좌석 상태 변경 없음** |
| PONG 미수신 | — | (향후) 일정 횟수 누락 시 재연결 |
| 클라우드 오프라인 | `STATUS,OFFLINE` 수신 → 내부 플래그 저장 | 버튼 입력 거부, 로컬 로그만 기록 |
| 잘못된 줄 | `ERR,...` 응답 | 줄 폐기, `serial.protocol_error` 로그 |

## 6. 버전 관리

- 프로토콜 변경 시 이 문서, `library_controller.ino`, `raspberry-pi/agent/serial_manager.py`, 관련 테스트를 함께 수정합니다.
- 호환되지 않는 변경은 `HELLO`의 메이저 버전을 올립니다.

## 7. 향후 확장 (미구현)

- `LED,<id>,<ON|OFF|BLINK>` — 상태 표시
- `SERVO,<seq>,<angle>` — 안전 검토(전원 분리, 각도 제한, 수동 차단 스위치) 이후 추가
- 체크섬 필드 — 노이즈 환경에서 필요 시
