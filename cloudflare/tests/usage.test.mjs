// 이용 시간 / 재실 확인 규칙 단위 테스트
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseUsageHours,
  presenceEndsAt,
  PRESENCE_KEEP_MS,
  PRESENCE_ROOMS,
} from '../workers/reservations.js';

const NOW = Date.parse('2026-11-07T10:00:00.000Z');
const at = (min) => new Date(NOW + min * 60_000).toISOString();

test('parseUsageHours: 1~4 정수만 허용', () => {
  for (const h of [1, 2, 3, 4, '2']) assert.equal(parseUsageHours(h), Number(h));
  for (const bad of [0, 5, 1.5, -1, null, undefined, 'abc', '']) {
    assert.throws(() => parseUsageHours(bad), (e) => e.code === 'invalid_usage_hours', String(bad));
  }
});

test('presenceEndsAt: 2시간 미만이면 지금+2시간, 이상이면 그대로', () => {
  assert.equal(PRESENCE_KEEP_MS, 2 * 60 * 60_000);
  assert.equal(presenceEndsAt(at(30), NOW), at(120), '30분 남음 -> 2시간');
  assert.equal(presenceEndsAt(at(119), NOW), at(120), '1시간 59분 남음 -> 2시간');
  assert.equal(presenceEndsAt(at(180), NOW), at(180), '3시간 남음 -> 그대로 (줄이지 않음)');
  assert.equal(presenceEndsAt(null, NOW), at(120), '값 없음 -> 2시간');
});

test('재실 확인 대상 열람실은 라즈베리파이 담당 열람실만', () => {
  assert.deepEqual([...PRESENCE_ROOMS], ['A']);
});
