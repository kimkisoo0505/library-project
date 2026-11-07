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

---

# ROOMLCD 펌웨어 (열람실 LCD 전용) v0.1

아두이노가 담당하는 열람실(B, C)의 16x2 I2C LCD 표시용 펌웨어 `arduino/firmware/room_lcd/room_lcd.ino`.
위의 버튼용 프로토콜과 같은 규칙(115200bps, 한 줄 ASCII, `\n`, 최대 64자)을 따르되 명령이 다릅니다.
화면 내용(Welcome 애니메이션, 사용중/공석 숫자)은 **라즈베리파이가 모두 계산**하고, 아두이노는 받은 두 줄을 표시만 합니다.

## 라즈베리파이 → 아두이노

| 명령 | 의미 |
|---|---|
| `LCD,<0\|1>,<text>` | 0 = 1줄, 1 = 2줄. `text` 는 쉼표를 뺀 ASCII 출력 문자 0~16자 (공백 허용, 남는 칸은 공백으로 채움) |
| `CLR` | 두 줄 모두 지움 |
| `PING,<seq>` | 연결 확인 → `PONG,<seq>` |
| `SERVO...` | **거부** → `ERR,SERVO_DISABLED` |

라즈베리파이는 화면이 바뀔 때, 그리고 **10초마다** 두 줄을 다시 보냅니다 (감시 타이머 유지).

## 아두이노 → 라즈베리파이

| 메시지 | 의미 |
|---|---|
| `HELLO,ROOMLCD-0.1.0` | 부팅 완료 (USB 포트를 열면 UNO 가 리셋되므로 연결 때마다 옴) |
| `PONG,<seq>` | PING 응답 |
| `TEMP,<°C>,<습도%>` | 온도·습도 (DHT11, 10초마다, 예: `TEMP,24.0,45`) — `temperature.h` |
| `ERR,TEMP_SENSOR` | 온도 센서 3회 연속 읽기 실패 (한 번만 보냄, 복구되면 다시 TEMP) |
| `ERR,LCD_NOT_FOUND,<주소>` | I2C LCD 가 응답하지 않음 (배선/주소 확인) |
| `ERR,<BAD_ROW\|BAD_TEXT\|BAD_ARGS\|LINE_TOO_LONG\|UNKNOWN_CMD\|SERVO_DISABLED>` | 명령 오류 |

## 안전 동작
- **30초 동안 명령이 없으면** 아두이노가 스스로 2줄에 `Offline` 을 표시합니다 (라즈베리파이가 멈춰도 틀린 숫자를 계속 보여주지 않음).
- 부팅 직후 화면: `Library` / `Waiting for Pi`.
- 서보모터·블루투스 기능은 없습니다.

## 하드웨어
| LCD 핀 | UNO 핀 |
|---|---|
| GND | GND |
| VCC | 5V |
| SDA | A4 |
| SCL | A5 |

I2C 주소는 펌웨어의 `#define LCD_ADDR` (열람실 B 아두이노: `0x3F`).

### 온도·습도 센서 (DHT11, 3핀 기판) — `room_lcd/temperature.h`
| DHT11 핀 | UNO 핀 |
|---|---|
| S (DATA/OUT) | **D2** |
| + (VCC) | **3.3V** (5V 핀은 LCD 가 사용 중, 브레드보드로 나누면 5V 도 가능) |
| − (GND) | GND |

제거: `temperature.h` 삭제 + `room_lcd.ino` 에서 `temperature` 주석이 붙은 줄 4개 삭제. 센서를 꽂지 않아도 펌웨어는 정상 동작하며(`ERR,TEMP_SENSOR` 한 번만 보냄) 키오스크는 '설치 예정' 으로 표시합니다.
