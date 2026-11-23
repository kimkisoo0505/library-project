// 좌석 알림 판단 테스트 (팝업 문구 · 서버 변화 감지 · 시간 경고 · 브라우저 알림 조건)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clock, mineSnapshot, detectChange, endedAlert, dueWarning, shouldBrowserNotify,
  reservedAlert, checkedInAlert, HOLD_WARN_MS, USAGE_WARN_MS,
} from '../src/common/seat-alerts.js';

const NOW = Date.parse('2026-11-20T06:00:00.000Z'); // 15:00 KST
const at = (min) => new Date(NOW + min * 60_000).toISOString();
const snap = (over = {}) => ({ id: 10, state: 'reserved', label: 'A07', room: 'A', expires_at: at(15), usage_ends_at: null, ...over });

test('clock: 한국 시간 표시', () => {
  assert.match(clock('2026-11-20T06:15:00.000Z'), /3:15/);
  assert.equal(clock('잘못된 값'), '');
});

test('mineSnapshot: 예약 없는 좌석은 null', () => {
  assert.equal(mineSnapshot(null), null);
  assert.equal(mineSnapshot({ label: 'A01' }), null);
  assert.equal(mineSnapshot({ reservation_id: 3, state: 'occupied', label: 'A01', room: 'A', usage_ends_at: at(60) }).id, 3);
});

test('완료 팝업 문구', () => {
  const r = reservedAlert({ label: 'A07', roomName: '열람실 A', expiresAt: at(15) });
  assert.equal(r.title, '예약이 완료되었습니다');
  assert.match(r.body, /A07.*3:15까지/);
  const c = checkedInAlert({ label: 'A07', roomName: '열람실 A', hours: 2, usageEndsAt: at(120) });
  assert.equal(c.title, '착석이 완료되었습니다');
  assert.match(c.body, /2시간 \(오후 5:00까지\)/);
});

test('detectChange: 첫 조회(이전 없음)·변화 없음은 알리지 않는다', () => {
  assert.equal(detectChange(null, snap()), null);
  assert.equal(detectChange(snap(), snap()), null);
});

test('detectChange: 서버/다른 기기가 바꾼 변화만 알린다', () => {
  // 다른 기기(키오스크)에서 착석
  assert.equal(detectChange(snap(), snap({ state: 'occupied' })).type, 'checked_in');
  // 이 화면에서 직접 착석 → 알리지 않음 (완료 팝업은 이미 띄움)
  assert.equal(detectChange(snap(), snap({ state: 'occupied' }), new Map([[10, 'occupied']])), null);
  // 예약이 사라짐 (자동 취소 등)
  assert.deepEqual(detectChange(snap(), null), { type: 'ended', snap: snap() });
  // 직접 취소·퇴실 → 알리지 않음
  assert.equal(detectChange(snap(), null, new Map([[10, 'ended']])), null);
  // 이 화면에서 착석한 뒤 시간 종료로 자동 퇴실 → 알림
  assert.equal(detectChange(snap({ state: 'occupied' }), null, new Map([[10, 'occupied']])).type, 'ended');
});

test('endedAlert: 끝난 이유별 문구', () => {
  assert.equal(endedAlert(snap(), '열람실 A', 'hold_timeout').title, '예약이 자동 취소되었어요');
  assert.equal(endedAlert(snap({ state: 'occupied' }), '열람실 A', 'time_expired').title, '이용 시간이 끝나 자동 퇴실되었어요');
  assert.equal(endedAlert(snap(), '열람실 A', 'admin_release').title, '관리자가 좌석을 해제했어요');
  assert.equal(endedAlert(snap({ state: 'occupied' }), '열람실 A', null).title, '좌석 이용이 끝났어요');
});

test('dueWarning: 착석 마감 5분 전 한 번만', () => {
  const fired = new Set();
  const ctx = { roomName: '열람실 A' };
  assert.equal(dueWarning(snap({ expires_at: at(6) }), NOW, fired, ctx), null, '6분 남음 → 아직');
  const w = dueWarning(snap({ expires_at: at(4.5) }), NOW, fired, ctx);
  assert.equal(w.title, '착석 마감 5분 전이에요');
  fired.add(w.key);
  assert.equal(dueWarning(snap({ expires_at: at(4) }), NOW, fired, ctx), null, '이미 보냄');
  assert.equal(dueWarning(snap({ expires_at: at(-1) }), NOW, new Set(), ctx), null, '지난 마감은 경고 안 함');
  assert.equal(HOLD_WARN_MS, 5 * 60_000);
});

test('dueWarning: 이용 종료 10분 전, 연장되면 새로 경고', () => {
  const fired = new Set();
  const ctx = { roomName: '열람실 A', presenceRoom: true };
  const occ = (end) => snap({ state: 'occupied', expires_at: null, usage_ends_at: end });
  const w = dueWarning(occ(at(9)), NOW, fired, ctx);
  assert.equal(w.title, '이용 시간이 9분 남았어요');
  assert.match(w.body, /블루투스/);
  fired.add(w.key);
  assert.equal(dueWarning(occ(at(9)), NOW, fired, ctx), null);
  assert.ok(dueWarning(occ(at(8)), NOW, fired, ctx), '종료 시각이 바뀌면 새 경고');
  assert.equal(dueWarning(occ(at(30)), NOW, new Set(), ctx), null);
  assert.equal(USAGE_WARN_MS, 10 * 60_000);
});

test('shouldBrowserNotify: 켜짐 + 허용 + 화면을 보고 있지 않을 때만', () => {
  const base = { enabled: true, permission: 'granted', visible: false, focused: false };
  assert.equal(shouldBrowserNotify(base), true);
  assert.equal(shouldBrowserNotify({ ...base, visible: true, focused: true }), false, '보고 있으면 팝업만');
  assert.equal(shouldBrowserNotify({ ...base, visible: true, focused: false }), true, '다른 창에 포커스');
  assert.equal(shouldBrowserNotify({ ...base, enabled: false }), false);
  assert.equal(shouldBrowserNotify({ ...base, permission: 'denied' }), false);
});
