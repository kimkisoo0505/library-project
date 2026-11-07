// 열람실 위치(강의실 호수) 입력값 검증 단위 테스트
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRoomLocation, ROOM_LOCATION_MAX } from '../workers/seats.js';

test('parseRoomLocation: 앞뒤 공백 제거, 연속 공백·줄바꿈은 공백 하나로', () => {
  assert.equal(parseRoomLocation('  제2공학관   401호 '), '제2공학관 401호');
  assert.equal(parseRoomLocation(''), '', '빈 문자열 = 지우기');
  assert.equal(parseRoomLocation('제2공학관\n401호'), '제2공학관 401호');
  assert.equal(parseRoomLocation('x'.repeat(ROOM_LOCATION_MAX)).length, ROOM_LOCATION_MAX);
});

test('parseRoomLocation: 잘못된 값 거부', () => {
  for (const bad of [null, undefined, 3, {}, 'x'.repeat(ROOM_LOCATION_MAX + 1), '401호<script>', '제어\u0001문자']) {
    assert.throws(() => parseRoomLocation(bad), (e) => e.code === 'invalid_parameter', String(bad));
  }
});
