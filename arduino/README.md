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
