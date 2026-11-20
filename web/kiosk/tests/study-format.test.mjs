// 공부 기록 표시 문구 테스트
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatMinutes, shortMinutes, dayLabel, historyStatusLabel } from '../src/common/study-format.js';

test('formatMinutes: 시간·분', () => {
  assert.equal(formatMinutes(0), '0분');
  assert.equal(formatMinutes(45), '45분');
  assert.equal(formatMinutes(60), '1시간');
  assert.equal(formatMinutes(200), '3시간 20분');
  assert.equal(formatMinutes(-5), '0분');
  assert.equal(formatMinutes(null), '0분');
});

test('shortMinutes: 막대 위 짧은 표시', () => {
  assert.equal(shortMinutes(45), '45m');
  assert.equal(shortMinutes(90), '1.5h');
  assert.equal(shortMinutes(120), '2h');
});

test('dayLabel: 한국 날짜 → 월/일 + 요일', () => {
  assert.deepEqual(dayLabel('2026-11-20'), { md: '11/20', wd: '금' });
  assert.deepEqual(dayLabel('2026-11-22'), { md: '11/22', wd: '일' });
});

test('historyStatusLabel: 상태·종료 사유별 문구', () => {
  assert.equal(historyStatusLabel({ status: 'occupied' }), '이용 중');
  assert.equal(historyStatusLabel({ status: 'completed', end_reason: 'checked_out' }), '퇴실');
  assert.equal(historyStatusLabel({ status: 'completed', end_reason: 'time_expired' }), '시간 종료 퇴실');
  assert.equal(historyStatusLabel({ status: 'cancelled', end_reason: 'admin_release' }), '관리자 해제');
  assert.equal(historyStatusLabel({ status: 'expired', end_reason: 'hold_timeout' }), '미착석 자동 취소');
});
