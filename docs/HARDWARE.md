# 하드웨어 연결 설계

## 1. 장비

| 장비 | 사양 | 역할 |
|---|---|---|
| Raspberry Pi 3 B+ Rev 1.3 | Raspberry Pi OS Lite 32-bit (Debian 13), Python 3.13, hostname `library-server`, 사용자 `pi` | 현장 에이전트 |
| Arduino UNO R3 | ATmega328P, 5V 로직, 디지털 14핀(시리얼 0/1 제외 시 12핀), 아날로그 6핀 | 버튼 입력, (향후) 서보 제어 |
| 서보모터 | **미연결** | 향후 단계 |

## 1-1. 열람실별 담당 장치

| 열람실 | 담당 장치 | LCD | 상태 |
|---|---|---|---|
| **A** | **라즈베리파이** (서버 역할 겸임), 쉴드 I2C 1번 | Seeed Grove LCD RGB Backlight v4 (16x2, 텍스트 0x3E / 백라이트 0x62) | 구현됨 |
| B | 아두이노 UNO 1 (라즈베리파이 USB, 시리얼 `85734323530351917281`) | 일반 I2C 16x2 (PCF8574, **0x3F**), SDA→A4 / SCL→A5 | 펌웨어 `room_lcd` — 라즈베리파이 `agent/arduino_rooms.py` 가 화면 전송 |
| C | 아두이노 2 | (예정) | 아두이노 구현은 별도 요청 시 |

### 열람실 LCD 표시 규칙
```
┌────────────────┐
│Welcome         │  1줄: 평소 비어 있음. 웹에서 이 열람실 좌석 '착석' 처리 시 "Welcome" 2초 표시 후
│Use 12 Free 18  │       마지막 글자부터 한 글자씩(0.15초 간격) 지워짐
└────────────────┘  2줄: 이 열람실 사용중(예약+착석) / 공석. 클라우드 미연결·정보 오래됨 → "Offline"
```
- 착석 알림은 서버 실시간 알림(`seats.changed`, reason `reservation.checked_in`)으로 받는다. 알림에는 좌석 번호만 있고 개인정보는 없다.
- LCD 오류는 다른 기능에 영향을 주지 않으며 30초 간격으로 재연결한다.
- I2C 활성화: `sudo raspi-config nonint do_i2c 0` (적용 완료). 주소 확인: `/usr/sbin/i2cdetect -y 1`
  - 스캔 결과: 0x3E(텍스트 컨트롤러), 0x62(RGB 백라이트 PCA9632), 0x70(PCA9632 전체 호출 주소) → Grove LCD RGB Backlight **v4**
  - v5 모듈은 백라이트 주소가 0x30 이므로 `LCD_RGB_ADDRESS` 를 바꿔야 한다
- 백라이트: 평상시 녹색, `Offline` 일 때 빨간색 (`LCD_COLOR_NORMAL`, `LCD_COLOR_OFFLINE`)
- 설정: `raspberry-pi/.env` 의 `DEVICE_ROOM=A`, `LCD_ENABLED=true`, `LCD_TYPE=grove-rgb`, `LCD_I2C_ADDRESS=0x3E`, `LCD_RGB_ADDRESS=0x62`
- 일반 I2C 백팩 LCD(PCF8574, 보통 0x27/0x3F)를 쓰는 열람실은 `LCD_TYPE=pcf8574`

## 2. 연결

```
Raspberry Pi 3 B+                      Arduino UNO R3
┌─────────────────┐   USB A ─ USB B   ┌──────────────────┐
│ USB 포트         │ ════════════════ │ USB (시리얼+5V)   │
│ /dev/ttyACM0    │                   │ D2..D? ── 버튼 ── GND
└─────────────────┘                   │ D9 (PWM) ── 서보 신호 (예정)
                                      └──────────────────┘
```

- Pi와 Arduino는 **USB 케이블로만** 연결합니다. GPIO UART 직결은 사용하지 않습니다 (Pi 3.3V ↔ UNO 5V 레벨 차이).
- 장치 이름이 바뀌지 않도록 향후 udev 규칙으로 `/dev/library-arduino` 심볼릭 링크를 만드는 것을 권장합니다.
  ```
  # /etc/udev/rules.d/99-library-arduino.rules (예시, 실제 시리얼 번호 확인 후)
  SUBSYSTEM=="tty", ATTRS{idVendor}=="2341", ATTRS{idProduct}=="0043", SYMLINK+="library-arduino"
  ```
- 사용자 `pi`는 `dialout` 그룹에 속해야 합니다.

## 3. 버튼 입력 설계 (미확정)

UNO의 가용 디지털 핀은 약 12개이므로 90석(3개 열람실 × 30석) 각각에 버튼을 직접 연결할 수 없습니다. 열람실마다 키오스크를 두는 경우 열람실별 Arduino(방식 C)도 고려합니다. 선택지는 다음과 같습니다.

| 방식 | 내용 | 장단점 |
|---|---|---|
| A. 키오스크 공용 버튼 (권장 시작점) | 키오스크 옆에 `확인 / 취소 / 호출` 등 2~4개 버튼 | 배선 단순, 좌석 선택은 화면에서 |
| B. 시프트 레지스터 확장 | 74HC165 4개로 32입력 | 좌석별 버튼 가능, 배선 길이·노이즈 고려 필요 |
| C. 구역별 다중 Arduino | 구역마다 컨트롤러 | 확장성 좋음, 프로토콜에 장치 ID 필요 |

- 버튼은 `INPUT_PULLUP` + 버튼-GND 연결, 소프트웨어 디바운스 30ms.
- 버튼 이벤트는 현재 서버에서 **기록만** 합니다. 버튼 → 동작(예: 착석 확인) 매핑은 방식 확정 후 설계합니다.

## 4. 서보모터 (향후 단계, 현재 구동 금지)

안전 원칙:
1. 서보 전원은 **외부 5V 전원**(서보 정격 전류 이상)에서 공급하고 Arduino와 GND만 공통으로 연결합니다. Arduino 5V 핀에서 직접 공급하지 않습니다.
2. 각도 범위를 펌웨어에서 제한합니다.
3. 물리적 비상 차단 스위치를 둡니다.
4. 클라우드 단절·시리얼 단절 시 서보는 **현재 위치를 유지**하며 자동으로 움직이지 않습니다.
5. 서보 명령은 서버의 명시적 지시 + 에이전트 설정 허용 + 펌웨어 허용의 3중 조건에서만 동작하도록 설계합니다.

현재 코드 상태:
- 펌웨어: `SERVO` 명령 → `ERR,SERVO_DISABLED`, Servo 라이브러리 미포함
- 에이전트: `build_command("SERVO")` → `ProtocolError`, `SERVO_ENABLED=true` → 설정 오류

## 5. 전원 및 운영

- Pi 3 B+는 5V 2.5A 이상 정품 어댑터를 사용합니다 (전압 부족 시 USB 시리얼 불안정).
- 저전압 경고 확인: `vcgencmd get_throttled`
- SD카드 수명: 로그는 회전(5MB × 5) 처리합니다.

## 6. 네트워크

- Pi는 Cloudflare로 **HTTPS/WSS 외부 발신 연결만** 합니다.
- 공유기 포트포워딩, Pi 내 웹 서버 공개는 하지 않습니다.
- 원격 관리가 필요하면 별도 단계에서 Cloudflare Tunnel 등 발신형 방식을 검토합니다.
