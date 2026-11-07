/*
 * 열람실 LCD 컨트롤러 (아두이노 UNO R3) — ROOMLCD 펌웨어
 *
 * 역할: 라즈베리파이(USB 시리얼)가 보내는 두 줄을 I2C 16x2 LCD 에 표시한다.
 *       화면 내용(Welcome 애니메이션, 사용중/공석 숫자)은 모두 라즈베리파이가 계산한다.
 *
 * 배선 (I2C LCD, PCF8574 백팩 4핀):
 *   LCD GND → GND,  VCC → 5V,  SDA → A4,  SCL → A5      (디지털 0·1번 핀은 USB 통신용이라 사용 금지)
 *
 * 프로토콜 (115200bps, 한 줄 ASCII, '\n' 로 끝, 최대 64자) — arduino/protocol/SERIAL_PROTOCOL.md 의 ROOMLCD
 *   라즈베리파이 → 아두이노
 *     LCD,<0|1>,<text>   해당 줄에 표시 (text: 쉼표 없는 ASCII 출력 문자 0~16자, 남는 칸은 공백)
 *     CLR                두 줄 모두 지움
 *     PING,<seq>         → PONG,<seq>
 *   아두이노 → 라즈베리파이
 *     HELLO,ROOMLCD-x.y.z            부팅 완료
 *     ERR,LCD_NOT_FOUND,<주소>         LCD 가 I2C 에 응답하지 않음
 *     ERR,<BAD_ROW|BAD_TEXT|LINE_TOO_LONG|UNKNOWN_CMD|SERVO_DISABLED>
 *
 * 안전
 *   - 30초 동안 라즈베리파이에서 아무 명령이 없으면 스스로 2줄에 "Offline" 표시 (틀린 숫자를 계속 보여주지 않음)
 *   - 서보모터 / 블루투스 기능 없음. SERVO 명령은 거부한다.
 *
 * 외부 라이브러리 없음 (Wire 만 사용). 아두이노 대신 라즈베리파이를 쓰게 되면 이 폴더째 삭제하면 된다.
 */

#include <Wire.h>
#include <string.h>
#include "temperature.h"   // temperature (DHT11 온도·습도, D2) — 제거 시 이 줄과 "// temperature" 줄 삭제

#define FIRMWARE_ID "ROOMLCD-0.2.0"
#define SERIAL_BAUD 115200
#define LCD_ADDR 0x3F          // i2c 주소 (뒷면 기판에 따라 0x27 일 수도 있음)
#define LCD_COLS 16
#define MAX_LINE 64
#define WATCHDOG_MS 30000UL    // 이 시간 동안 명령이 없으면 Offline 표시

// PCF8574 핀 비트: P0=RS, P1=RW, P2=E, P3=백라이트, P4~P7=D4~D7
#define PIN_RS 0x01
#define PIN_EN 0x04
#define PIN_BL 0x08

char lineBuffer[MAX_LINE + 1];
uint8_t lineLength = 0;
bool lineOverflow = false;

char shadow[2][LCD_COLS + 1];   // 현재 화면 (바뀐 줄만 다시 씀)
unsigned long lastCommandAt = 0;
bool offlineShown = false;
bool lcdPresent = false;

// ---------------------------------------------------------------- LCD (HD44780 4비트 + PCF8574)

void expanderWrite(uint8_t value) {
  Wire.beginTransmission(LCD_ADDR);
  Wire.write(value | PIN_BL);
  Wire.endTransmission();
}

void pulse(uint8_t value) {
  expanderWrite(value | PIN_EN);
  delayMicroseconds(1);
  expanderWrite(value & ~PIN_EN);
  delayMicroseconds(50);
}

void writeNibble(uint8_t nibble, uint8_t mode) {
  uint8_t value = ((nibble & 0x0F) << 4) | mode;
  expanderWrite(value);
  pulse(value);
}

void lcdSend(uint8_t value, uint8_t mode) {
  writeNibble(value >> 4, mode);
  writeNibble(value, mode);
}

void lcdCommand(uint8_t value) { lcdSend(value, 0); }

bool lcdProbe() {
  Wire.beginTransmission(LCD_ADDR);
  return Wire.endTransmission() == 0;
}

void lcdInit() {
  delay(50);
  expanderWrite(0);
  delay(10);
  writeNibble(0x03, 0); delayMicroseconds(4500);   // 8비트 모드로 3회 리셋
  writeNibble(0x03, 0); delayMicroseconds(4500);
  writeNibble(0x03, 0); delayMicroseconds(150);
  writeNibble(0x02, 0);                            // 4비트 모드
  lcdCommand(0x28);                                // 2줄, 5x8
  lcdCommand(0x0C);                                // 표시 ON, 커서 OFF
  lcdCommand(0x01);                                // 지우기
  delay(2);
  lcdCommand(0x06);                                // 입력 모드: 오른쪽으로 이동
  for (uint8_t r = 0; r < 2; r++) {
    memset(shadow[r], ' ', LCD_COLS);
    shadow[r][LCD_COLS] = '\0';
  }
}

// text 를 16칸으로 맞춰 표시. 이전과 같으면 쓰지 않음.
void setLine(uint8_t row, const char *text) {
  char padded[LCD_COLS + 1];
  uint8_t i = 0;
  for (; i < LCD_COLS && text[i] != '\0'; i++) padded[i] = text[i];
  for (; i < LCD_COLS; i++) padded[i] = ' ';
  padded[LCD_COLS] = '\0';
  if (!lcdPresent || strcmp(padded, shadow[row]) == 0) return;
  lcdCommand(0x80 | (row == 0 ? 0x00 : 0x40));
  for (i = 0; i < LCD_COLS; i++) lcdSend((uint8_t)padded[i], PIN_RS);
  memcpy(shadow[row], padded, LCD_COLS + 1);
}

// ---------------------------------------------------------------- 시리얼 프로토콜

void sendLine(const char *a, const char *b = nullptr, const char *c = nullptr) {
  Serial.print(a);
  if (b) { Serial.print(','); Serial.print(b); }
  if (c) { Serial.print(','); Serial.print(c); }
  Serial.print('\n');
}

bool isLcdText(const char *s) {
  uint8_t n = 0;
  for (; *s; s++, n++) {
    if (n >= LCD_COLS) return false;
    if (*s < 0x20 || *s > 0x7E || *s == ',') return false;
  }
  return true;
}

bool isField(const char *s) {   // PING 순번 등: 대문자/숫자/_.- 1~24자
  uint8_t n = 0;
  for (; *s; s++, n++) {
    char ch = *s;
    bool ok = (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch == '_' || ch == '.' || ch == '-';
    if (!ok || n >= 24) return false;
  }
  return n > 0;
}

void handleCommand(char *line) {
  // LCD,<row>,<text>  — text 에는 공백이 들어갈 수 있으므로 strtok 대신 위치로 자른다
  if (strncmp(line, "LCD,", 4) == 0) {
    char row = line[4];
    if ((row != '0' && row != '1') || line[5] != ',') { sendLine("ERR", "BAD_ROW"); return; }
    const char *text = line + 6;
    if (!isLcdText(text)) { sendLine("ERR", "BAD_TEXT"); return; }
    lastCommandAt = millis();
    offlineShown = false;
    setLine(row - '0', text);
    return;
  }
  if (strcmp(line, "CLR") == 0) {
    lastCommandAt = millis();
    offlineShown = false;
    setLine(0, "");
    setLine(1, "");
    return;
  }
  if (strncmp(line, "PING,", 5) == 0) {
    if (!isField(line + 5)) { sendLine("ERR", "BAD_ARGS"); return; }
    lastCommandAt = millis();
    sendLine("PONG", line + 5);
    return;
  }
  if (strncmp(line, "SERVO", 5) == 0) {        // 안전 규칙: 서보 구동 없음
    sendLine("ERR", "SERVO_DISABLED");
    return;
  }
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
    if (lineLength < MAX_LINE) lineBuffer[lineLength++] = ch;
    else lineOverflow = true;
  }
}

// ---------------------------------------------------------------- 메인

void setup() {
  Serial.begin(SERIAL_BAUD);
  Wire.begin();
  lcdPresent = lcdProbe();
  if (lcdPresent) {
    lcdInit();
    setLine(0, "Library");
    setLine(1, "Waiting for Pi");
  }
  lastCommandAt = millis();
  temperatureSetup();   // temperature
  sendLine("HELLO", FIRMWARE_ID);
  if (!lcdPresent) {
    char addr[5];
    snprintf(addr, sizeof(addr), "%02X", LCD_ADDR);
    sendLine("ERR", "LCD_NOT_FOUND", addr);
  }
}

void sendTemp(const char *a, const char *b, const char *c) { sendLine(a, b, c); }   // temperature

void loop() {
  readSerial();
  temperatureLoop(sendTemp);   // temperature
  if (!offlineShown && millis() - lastCommandAt > WATCHDOG_MS) {
    setLine(0, "");
    setLine(1, "Offline");
    offlineShown = true;
  }
}
