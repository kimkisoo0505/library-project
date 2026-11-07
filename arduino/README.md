# arduino — 하드웨어 컨트롤러 (Arduino UNO R3)

## 구조

```
arduino/
├── firmware/library_controller/library_controller.ino   펌웨어 (통신 골격)
└── protocol/SERIAL_PROTOCOL.md                          Pi ↔ Arduino 통신 규격
```

## 현재 상태

- 시리얼 명령 수신/응답(PING, STATUS) 구현
- 버튼 읽기 코드는 포함되어 있으나 `ENABLE_BUTTONS 0`으로 **비활성**
- 서보모터: **미연결, 구동 코드 없음** (`SERVO` 명령은 `ERR,SERVO_DISABLED`로 거부)

## 업로드

### Arduino IDE
1. `firmware/library_controller/library_controller.ino` 열기
2. 보드: Arduino UNO, 포트 선택 → 업로드
3. 시리얼 모니터 115200bps, 줄 끝 "Newline" 설정 → `HELLO,0.1.0` 확인
4. `PING,1` 입력 → `PONG,1` 응답 확인

### arduino-cli
```powershell
arduino-cli core install arduino:avr
arduino-cli compile --fqbn arduino:avr:uno arduino/firmware/library_controller
arduino-cli upload  --fqbn arduino:avr:uno -p COM3 arduino/firmware/library_controller
```
(`COM3`은 장치 관리자에서 확인한 실제 포트로 바꾸세요. 라즈베리파이에서는 `/dev/ttyACM0`)

## 주의

- 업로드 중에는 라즈베리파이 에이전트를 중지하세요 (포트 점유 충돌).
- 서보모터는 Arduino 5V 핀에서 직접 전원을 받지 않도록 설계합니다 — [HARDWARE.md](../docs/HARDWARE.md) 참고.

## 열람실 LCD 펌웨어 (room_lcd) — 열람실 B / C

| 항목 | 내용 |
|---|---|
| 스케치 | `firmware/room_lcd/room_lcd.ino` (외부 라이브러리 없음, `Wire` 만 사용) |
| 배선 | LCD GND→GND, VCC→5V, SDA→A4, SCL→A5 |
| 주소 | `#define LCD_ADDR 0x3F` (뒷면 기판이 0x27 이면 바꿔서 업로드) |
| 프로토콜 | [SERIAL_PROTOCOL.md](protocol/SERIAL_PROTOCOL.md) 의 ROOMLCD |
| 라즈베리파이 쪽 | `raspberry-pi/agent/arduino_rooms.py`, `.env` 의 `ARDUINO_ROOMS=B=/dev/serial/by-id/...` |

### 업로드 (라즈베리파이에서, 아두이노가 USB 로 연결된 상태)
```bash
# 업로드 도구 (최초 1회, sudo 불필요): ~/.local/bin/arduino-cli + arduino:avr 코어
# 에이전트가 시리얼 포트를 쓰고 있으므로 업로드 동안 잠시 멈춤
# (sudo 없이 stop/start 하려면 polkit 규칙 raspberry-pi/system/51-library-services.rules 설치 필요, 없으면 sudo 붙이기)
systemctl stop library-agent
PORT=/dev/serial/by-id/usb-Arduino__www.arduino.cc__0043_<시리얼번호>-if00
~/.local/bin/arduino-cli compile --fqbn arduino:avr:uno ~/library-project/arduino/firmware/room_lcd
~/.local/bin/arduino-cli upload  --fqbn arduino:avr:uno -p "$PORT" ~/library-project/arduino/firmware/room_lcd
systemctl start library-agent
```
아두이노는 `/dev/ttyACM0` 같은 번호 대신 **USB 시리얼 번호가 들어간 `/dev/serial/by-id/...` 경로**로 지정합니다 (두 대를 꽂아도 B/C 가 바뀌지 않음).

### 아두이노를 없애고 라즈베리파이로 바꿀 때 (제거 방법)
1. `arduino/firmware/room_lcd/` 삭제
2. `raspberry-pi/agent/arduino_rooms.py`, `raspberry-pi/tests/test_arduino_rooms.py` 삭제
3. `raspberry-pi/agent/main.py` 에서 `arduino_rooms` 주석이 붙은 줄 삭제
4. `raspberry-pi/agent/config.py` 의 `arduino_rooms` 필드와 `parse_arduino_rooms` 삭제, `.env` 의 `ARDUINO_ROOMS` 삭제
5. 새 라즈베리파이는 `DEVICE_ROOM=B`, `LCD_ENABLED=true` 로 열람실 A 와 같은 방식으로 LCD 를 직접 구동
