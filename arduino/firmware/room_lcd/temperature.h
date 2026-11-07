/*
 * 열람실 온도·습도 센서 (DHT11, 3핀 기판) — 온도 기능은 이 파일에만 있다.
 *
 * 배선: DHT11 S(DATA) → D2,  + → 3.3V(또는 5V),  − → GND
 * 동작: 10초마다 읽어서 라즈베리파이로  TEMP,<온도°C>,<습도%>  를 보낸다 (예: TEMP,24.0,45)
 *       3회 연속 읽기 실패 시 한 번만  ERR,TEMP_SENSOR  를 보낸다 (복구되면 다시 TEMP 전송)
 *
 * 외부 라이브러리 없이 DHT11 단선 프로토콜을 직접 읽는다.
 * 시리얼 수신을 놓치지 않도록 인터럽트는 끄지 않는다 (가끔 실패하면 체크섬으로 걸러내고 다음 주기에 다시 읽음).
 *
 * 제거 방법: 이 파일 삭제 + room_lcd.ino 에서 "temperature" 주석이 붙은 줄 4개 삭제
 */
#pragma once
#include <Arduino.h>

#define DHT_PIN 2
#define TEMP_INTERVAL_MS 10000UL
#define TEMP_FIRST_READ_MS 2000UL     // 전원 인가 후 센서 안정화
#define TEMP_FAIL_LIMIT 3

typedef void (*TempSendFn)(const char *a, const char *b, const char *c);

static unsigned long tempLastRead = 0;
static uint8_t tempFailCount = 0;
static bool tempErrorReported = false;

// 선이 level 이 될 때까지 기다림. timeoutUs 안에 안 되면 false
static bool dhtWaitLevel(uint8_t level, uint16_t timeoutUs) {
  unsigned long start = micros();
  while (digitalRead(DHT_PIN) != level) {
    if (micros() - start > timeoutUs) return false;
  }
  return true;
}

// 성공 시 true, data[0]=습도 정수, data[2]=온도 정수, data[3]=온도 소수(0~9)
static bool dhtRead(uint8_t data[5]) {
  for (uint8_t i = 0; i < 5; i++) data[i] = 0;
  // 시작 신호: 18ms 이상 LOW → 해제
  pinMode(DHT_PIN, OUTPUT);
  digitalWrite(DHT_PIN, LOW);
  delay(20);
  digitalWrite(DHT_PIN, HIGH);
  delayMicroseconds(30);
  pinMode(DHT_PIN, INPUT_PULLUP);
  // 응답: LOW 80us → HIGH 80us → 첫 비트 시작(LOW)
  if (!dhtWaitLevel(LOW, 120)) return false;
  if (!dhtWaitLevel(HIGH, 120)) return false;
  if (!dhtWaitLevel(LOW, 120)) return false;
  // 40비트: 각 비트 LOW 50us 후 HIGH 26~28us(0) / 70us(1)
  for (uint8_t i = 0; i < 40; i++) {
    if (!dhtWaitLevel(HIGH, 100)) return false;
    unsigned long t = micros();
    if (!dhtWaitLevel(LOW, 120)) return false;
    data[i / 8] <<= 1;
    if (micros() - t > 45) data[i / 8] |= 1;
  }
  uint8_t sum = data[0] + data[1] + data[2] + data[3];
  return sum == data[4] && data[0] <= 100 && data[2] <= 60;
}

static void temperatureSetup() {
  pinMode(DHT_PIN, INPUT_PULLUP);
  tempLastRead = millis() - TEMP_INTERVAL_MS + TEMP_FIRST_READ_MS;
}

static void temperatureLoop(TempSendFn send) {
  if (millis() - tempLastRead < TEMP_INTERVAL_MS) return;
  tempLastRead = millis();
  uint8_t d[5];
  if (dhtRead(d)) {
    char temp[8], hum[5];
    snprintf(temp, sizeof(temp), "%u.%u", d[2], d[3] % 10);
    snprintf(hum, sizeof(hum), "%u", d[0]);
    send("TEMP", temp, hum);
    tempFailCount = 0;
    tempErrorReported = false;
    return;
  }
  if (tempFailCount < 255) tempFailCount++;
  if (tempFailCount >= TEMP_FAIL_LIMIT && !tempErrorReported) {
    send("ERR", "TEMP_SENSOR", nullptr);
    tempErrorReported = true;
  }
}
