// 이용 기록 · 통계 · 공부 시간 계산 단위 테스트 (DB 없이 순수 함수만)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  kstDateKey,
  kstDayStart,
  recentKstDays,
  studyInterval,
  studyMinutes,
  splitByKstDay,
  computeMyStats,
  computeAdminStats,
  historyItem,
} from '../workers/stats.js';

// 2026-11-20 15:00 KST
const NOW = Date.parse('2026-11-20T06:00:00.000Z');
const iso = (s) => new Date(Date.parse(s)).toISOString();

function done(seatId, inAt, outAt, extra = {}) {
  return {
    id: extra.id ?? 1, seat_id: seatId, seat_label: `A${String(seatId).padStart(2, '0')}`, room: 'A', room_name: '열람실 A',
    student_id: 7, status: 'completed', reserved_at: iso(inAt), checked_in_at: iso(inAt), checked_out_at: iso(outAt),
    ended_at: iso(outAt), end_reason: 'checked_out', usage_ends_at: null, ...extra,
  };
}

test('한국 날짜: UTC 15시 이후는 다음 날', () => {
  assert.equal(kstDateKey(Date.parse('2026-11-19T14:59:00Z')), '2026-11-19');
  assert.equal(kstDateKey(Date.parse('2026-11-19T15:00:00Z')), '2026-11-20');
  assert.equal(kstDayStart('2026-11-20'), Date.parse('2026-11-19T15:00:00Z'));
  assert.deepEqual(recentKstDays(3, NOW), ['2026-11-18', '2026-11-19', '2026-11-20']);
});

test('공부 시간: 착석~퇴실, 착석 안 한 예약은 0', () => {
  assert.equal(studyMinutes(done(1, '2026-11-20T01:00:00Z', '2026-11-20T02:30:00Z'), NOW), 90);
  assert.equal(studyInterval({ status: 'expired', checked_in_at: null, ended_at: iso('2026-11-20T01:00:00Z') }, NOW), null);
  assert.equal(studyInterval({ status: 'cancelled', reserved_at: iso('2026-11-20T01:00:00Z'), ended_at: iso('2026-11-20T01:05:00Z') }, NOW), null);
});

test('공부 시간: 이용 중이면 지금까지, 자동 퇴실 지연분은 usage_ends_at 에서 자른다', () => {
  const occupied = { status: 'occupied', checked_in_at: iso('2026-11-20T05:00:00Z'), usage_ends_at: iso('2026-11-20T07:00:00Z') };
  assert.equal(studyMinutes(occupied, NOW), 60);
  const late = done(1, '2026-11-20T01:00:00Z', '2026-11-20T03:00:50Z', { end_reason: 'time_expired', usage_ends_at: iso('2026-11-20T03:00:00Z') });
  assert.equal(studyMinutes(late, NOW), 120);
});

test('자정을 넘긴 이용은 한국 날짜별로 나뉜다', () => {
  // 11-19 23:00 KST ~ 11-20 01:30 KST
  const parts = splitByKstDay({ start: Date.parse('2026-11-19T14:00:00Z'), end: Date.parse('2026-11-19T16:30:00Z') });
  assert.deepEqual([...parts].map(([d, ms]) => [d, ms / 60_000]), [['2026-11-19', 60], ['2026-11-20', 90]]);
});

test('내 통계: 합계 · 최근 7일 · 연속 일수 · 자주 앉는 자리', () => {
  const rows = [
    done(3, '2026-11-20T00:00:00Z', '2026-11-20T02:00:00Z', { id: 5 }),            // 오늘 120분, A03
    done(3, '2026-11-19T00:00:00Z', '2026-11-19T01:00:00Z', { id: 4 }),            // 어제 60분, A03
    done(5, '2026-11-18T00:00:00Z', '2026-11-18T00:30:00Z', { id: 3 }),            // 그제 30분, A05
    done(5, '2026-11-01T00:00:00Z', '2026-11-01T03:00:00Z', { id: 2 }),            // 7일 밖 180분
    { id: 6, seat_id: 9, status: 'expired', end_reason: 'hold_timeout', reserved_at: iso('2026-11-20T03:00:00Z') },
    { id: 7, seat_id: 9, status: 'cancelled', end_reason: 'user_cancelled', reserved_at: iso('2026-11-20T03:10:00Z') },
  ];
  const s = computeMyStats(rows, NOW);
  assert.equal(s.total_study_minutes, 390);
  assert.equal(s.sessions, 4);
  assert.equal(s.reservations, 6);
  assert.equal(s.no_shows, 1);
  assert.equal(s.cancelled, 1);
  assert.equal(s.today_minutes, 120);
  assert.equal(s.week_minutes, 210);
  assert.equal(s.longest_session_minutes, 180);
  assert.equal(s.average_session_minutes, 97);
  assert.equal(s.study_days, 4);
  assert.equal(s.streak_days, 3);
  assert.equal(s.daily.length, 7);
  assert.equal(s.daily[6].date, '2026-11-20');
  assert.equal(s.favorite_seat.seat_id, 3, '횟수가 같으면 최근에 앉은 자리');
});

test('내 통계: 오늘 아직 공부 안 했으면 어제까지의 연속 일수', () => {
  const rows = [done(1, '2026-11-19T00:00:00Z', '2026-11-19T01:00:00Z'), done(1, '2026-11-18T00:00:00Z', '2026-11-18T01:00:00Z')];
  assert.equal(computeMyStats(rows, NOW).streak_days, 2);
  assert.equal(computeMyStats([], NOW).streak_days, 0);
  assert.equal(computeMyStats([], NOW).favorite_seat, null);
});

test('이용 기록 한 줄', () => {
  const item = historyItem(done(3, '2026-11-20T00:00:00Z', '2026-11-20T00:45:00Z', { id: 9 }), NOW);
  assert.equal(item.study_minutes, 45);
  assert.equal(item.seat_label, 'A03');
  assert.equal(item.ended_at, iso('2026-11-20T00:45:00Z'));
  assert.equal('student_id' in item, false, '학생 id 는 응답에 넣지 않는다');
});

test('관리자 통계: 기간 합계 · 노쇼율 · 일별 · 시간대 · 열람실', () => {
  const rooms = [{ code: 'A', name: '열람실 A', seats: 30 }, { code: 'B', name: '열람실 B', seats: 30 }];
  const rows = [
    // 오늘 09:00~11:00 KST 착석 (A)
    { ...done(1, '2026-11-20T00:00:00Z', '2026-11-20T02:00:00Z'), student_id: 1 },
    // 기간 전에 착석해 기간 첫날로 이어진 이용: 11-13 23:00 KST ~ 11-14 01:00 KST → 기간(11-14~)엔 60분만
    { ...done(2, '2026-11-13T14:00:00Z', '2026-11-13T16:00:00Z'), student_id: 2 },
    { student_id: 3, room: 'B', status: 'expired', end_reason: 'hold_timeout', reserved_at: iso('2026-11-20T01:00:00Z'), ended_at: iso('2026-11-20T01:15:00Z') },
  ];
  const s = computeAdminStats(rows, rooms, 7, NOW);
  assert.equal(s.from, iso('2026-11-13T15:00:00Z'));
  assert.equal(s.totals.reservations, 2, '기간 전에 예약한 건은 예약 수에 넣지 않는다');
  assert.equal(s.totals.no_shows, 1);
  assert.equal(s.totals.no_show_rate, 0.5);
  assert.equal(s.totals.unique_students, 2);
  assert.equal(s.totals.check_ins, 1);
  assert.equal(s.totals.study_minutes, 180);
  assert.equal(s.totals.total_seats, 60);
  assert.equal(s.daily[0].study_minutes, 60);
  assert.equal(s.daily[6].study_minutes, 120);
  assert.equal(s.daily[6].no_shows, 1);
  assert.equal(s.hourly.length, 24);
  // 09시대: 7일 중 하루 1석 → 평균 1/7 ≈ 0.1
  assert.equal(s.hourly[9].avg_occupied, 0.1);
  assert.equal(s.hourly[15].avg_occupied, 0, '오늘 15시는 지금 시작이라 기간에 포함 안 됨');
  assert.deepEqual(s.rooms.map((r) => [r.code, r.check_ins, r.study_minutes]), [['A', 1, 180], ['B', 0, 0]]);
});
