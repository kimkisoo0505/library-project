/*
 * 도서관 좌석 관리 시스템 - Arduino UNO R3 컨트롤러 (통신 골격)
 *
 * 프로토콜: arduino/protocol/SERIAL_PROTOCOL.md
 *   - 115200bps, 줄 단위 ASCII, 필드 구분자 ',', 줄 끝 '\n', 최대 64자
 *
 * 현재 단계의 동작
 *   - 시작 시 HELLO,<버전> 전송
 *   - PING,<seq>     -> PONG,<seq>
 *   - STATUS,<ONLINE|OFFLINE> -> ACK,STATUS,<값> (내부 상태만 저장, 출력 장치 구동 없음)
 *   - SERVO,...      -> ERR,SERVO_DISABLED (서보모터는 구동하지 않음)
 *   - 그 외          -> ERR,UNKNOWN_CMD
 *   - 버튼 입력은 ENABLE_BUTTONS 를 1로 바꾸기 전까지 비활성
 *
 * 안전: 이 펌웨어는 Servo 라이브러리를 사용하지 않으며 어떤 액추에이터도 구동하지 않는다.
 */

#include <string.h>
#include <stdlib.h>

#define FIRMWARE_VERSION "0.1.0"
#define SERIAL_BAUD 115200
#define MAX_LINE 64

// 버튼 입력 (배선 확정 전까지 0). 1로 바꾸면 INPUT_PULLUP 버튼을 읽어 BTN 메시지 전송
#define ENABLE_BUTTONS 0

#if ENABLE_BUTTONS
// 배선 확정 후 수정 (docs/HARDWARE.md 참고). 버튼은 핀과 GND 사이에 연결 (INPUT_PULLUP)
const uint8_t BUTTON_PINS[] = {2, 3, 4};
const uint8_t BUTTON_COUNT = sizeof(BUTTON_PINS) / sizeof(BUTTON_PINS[0]);
const unsigned long DEBOUNCE_MS = 30;
const unsigned long LONG_PRESS_MS = 1500;

bool buttonStable[BUTTON_COUNT];
bool buttonLastRead[BUTTON_COUNT];
unsigned long buttonChangedAt[BUTTON_COUNT];
unsigned long buttonPressedAt[BUTTON_COUNT];
#endif

char lineBuffer[MAX_LINE + 1];
uint8_t lineLength = 0;
bool lineOverflow = false;
bool cloudOnline = false;  // 에이전트가 알려준 상태 (표시용, 현재는 사용처 없음)

void sendLine(const char *a, const char *b = nullptr, const char *c = nullptr) {
  Serial.print(a);
  if (b) { Serial.print(','); Serial.print(b); }
  if (c) { Serial.print(','); Serial.print(c); }
  Serial.print('\n');
}

bool isValidField(const char *s) {
  if (!s || !*s || strlen(s) > 24) return false;
  for (; *s; ++s) {
    char ch = *s;
    bool ok = (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch == '_' || ch == '.' || ch == '-';
    if (!ok) return false;
  }
  return true;
}

void handleCommand(char *line) {
  char *kind = strtok(line, ",");
  char *arg1 = strtok(nullptr, ",");
  char *arg2 = strtok(nullptr, ",");
  char *extra = strtok(nullptr, ",");

  if (!kind) {
    sendLine("ERR", "EMPTY");
    return;
  }

  if (strcmp(kind, "PING") == 0) {
    if (!isValidField(arg1) || arg2) { sendLine("ERR", "BAD_ARGS", "PING"); return; }
    sendLine("PONG", arg1);
    return;
  }

  if (strcmp(kind, "STATUS") == 0) {
    if (!arg1 || arg2) { sendLine("ERR", "BAD_ARGS", "STATUS"); return; }
    if (strcmp(arg1, "ONLINE") == 0) cloudOnline = true;
    else if (strcmp(arg1, "OFFLINE") == 0) cloudOnline = false;
    else { sendLine("ERR", "BAD_ARGS", "STATUS"); return; }
    sendLine("ACK", "STATUS", arg1);
    return;
  }

  if (strcmp(kind, "SERVO") == 0) {
    // 안전 규칙: 서보모터 구동은 현재 단계에서 지원하지 않음
    sendLine("ERR", "SERVO_DISABLED");
    return;
  }

  (void)extra;
  sendLine("ERR", "UNKNOWN_CMD");
}

void readSerial() {
  while (Serial.available() > 0) {
    char ch = (char)Serial.read();
    if (ch == '\r') continue;
    if (ch == '\n') {
      if (lineOverflow) {
        sendLine("ERR", "LINE_TOO_LONG");
      } else if (lineLength > 0) {
        lineBuffer[lineLength] = '\0';
        handleCommand(lineBuffer);
      }
      lineLength = 0;
      lineOverflow = false;
      continue;
    }
    if (lineLength < MAX_LINE) {
      lineBuffer[lineLength++] = ch;
    } else {
      lineOverflow = true;  // 줄 끝까지 버림
    }
  }
}

#if ENABLE_BUTTONS
void setupButtons() {
  for (uint8_t i = 0; i < BUTTON_COUNT; ++i) {
    pinMode(BUTTON_PINS[i], INPUT_PULLUP);
    buttonStable[i] = buttonLastRead[i] = digitalRead(BUTTON_PINS[i]);
    buttonChangedAt[i] = millis();
    buttonPressedAt[i] = 0;
  }
}

void pollButtons() {
  unsigned long now = millis();
  for (uint8_t i = 0; i < BUTTON_COUNT; ++i) {
    bool reading = digitalRead(BUTTON_PINS[i]);
    if (reading != buttonLastRead[i]) {
      buttonLastRead[i] = reading;
      buttonChangedAt[i] = now;
    }
    if ((now - buttonChangedAt[i]) < DEBOUNCE_MS || reading == buttonStable[i]) continue;

    buttonStable[i] = reading;
    if (reading == LOW) {
      buttonPressedAt[i] = now;  // 눌림
    } else {
      // 뗄 때 길이로 PRESS / LONG 판정
      char id[4];
      itoa(i + 1, id, 10);
      sendLine("BTN", id, (now - buttonPressedAt[i]) >= LONG_PRESS_MS ? "LONG" : "PRESS");
    }
  }
}
#endif

void setup() {
  Serial.begin(SERIAL_BAUD);
#if ENABLE_BUTTONS
  setupButtons();
#endif
  sendLine("HELLO", FIRMWARE_VERSION);
}

void loop() {
  readSerial();
#if ENABLE_BUTTONS
  pollButtons();
#endif
}
