// 관리자 강의실 위치 (건물 + 호실) 형식 단위 테스트
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUILDINGS, buildingLabel, formatLocation, parseLocation, isValidRoom, ROOM_MAX_DIGITS } from '../src/admin/location-format.js';

test('건물 목록: 1~9강의동 + 그 밖의 건물, id 중복 없음', () => {
  const ids = BUILDINGS.map((b) => b.id);
  assert.equal(new Set(ids).size, ids.length);
  for (let n = 1; n <= 9; n += 1) assert.ok(BUILDINGS.some((b) => b.short === `${n}강의동`), `${n}강의동`);
  assert.equal(buildingLabel(BUILDINGS.find((b) => b.id === 'L5')), '5강의동 덕문관');
  assert.ok(BUILDINGS.some((b) => b.short === '제2공학관'));
  assert.ok(!BUILDINGS.some((b) => /운동장|정문|후문|경기탑|한우리관/.test(b.short)), '실내 공간 없는 곳·철거·운영 종료 제외');
});

test('저장 형식: "5강의동 4405호", 그 밖 건물은 이름 그대로', () => {
  assert.equal(formatLocation('L5', '4405'), '5강의동 4405호');
  assert.equal(formatLocation('L1', '101'), '1강의동 101호');
  assert.equal(formatLocation('eng2', '1201'), '제2공학관 1201호');
  for (const b of BUILDINGS) assert.ok(formatLocation(b.id, '99999').length <= 40, '서버 제한 40자 이내');
});

test('호실은 숫자 1~5자리만', () => {
  for (const ok of ['1', '101', '4405', '99999']) assert.ok(isValidRoom(ok), ok);
  for (const bad of ['', '123456', '44a', '-1', ' 44', 'B101', 4405, null]) assert.ok(!isValidRoom(bad), String(bad));
  assert.equal(formatLocation('L5', '44a'), null);
  assert.equal(formatLocation('nope', '4405'), null);
  assert.equal(ROOM_MAX_DIGITS, 5);
});

test('저장된 값 다시 읽기 (왕복)', () => {
  for (const b of BUILDINGS) {
    const text = formatLocation(b.id, '305');
    assert.deepEqual(parseLocation(text), { buildingId: b.id, room: '305' }, text);
  }
});

test('예전에 직접 입력한 값도 너그럽게 읽기', () => {
  assert.deepEqual(parseLocation('제 5강의동 5102호'), { buildingId: 'L5', room: '5102' }); // 운영에 실제로 있던 형식
  assert.deepEqual(parseLocation('5강의동(덕문관) 5102'), { buildingId: 'L5', room: '5102' });
  assert.deepEqual(parseLocation('5강의동 덕문관 5102호'), { buildingId: 'L5', room: '5102' });
  assert.deepEqual(parseLocation('덕문관 5102호'), { buildingId: 'L5', room: '5102' });
  assert.deepEqual(parseLocation('  제2공학관   1201호 '), { buildingId: 'eng2', room: '1201' });
  assert.deepEqual(parseLocation('제2공학관1201호'), { buildingId: 'eng2', room: '1201' });
});

test('목록 형식이 아니면 null (화면에서 다시 고르라고 안내)', () => {
  for (const v of ['', '   ', '00관 000호', '제2공학관 401호A', '5강의동', '10강의동 101호', '덕문관 B101호', null, undefined, 42]) {
    assert.equal(parseLocation(v), null, String(v));
  }
});
