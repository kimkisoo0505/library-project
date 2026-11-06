// 장치 상태 / 시스템 상태 단위 테스트
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemStatus, normalizeBle, normalizeDeviceStatus } from '../workers/system-status.js';

const NOW = Date.parse('2026-11-04T10:00:00.000Z');
const ago = (ms) => new Date(NOW - ms).toISOString();

test('normalizeDeviceStatus: 허용 필드만, 범위 검증', () => {
  const s = normalizeDeviceStatus({
    room: 'a', agent_version: '0.1.0', ip: '192.168.0.2', mac: 'aa:bb',
    network: { type: 'wifi', ssid: 'SK_WiFi\u0007GIGA', signal: 60, band: '5GHz', ip: 'x' },
    lcd: true, serial: 'yes', central_library: false,
  });
  assert.equal(s.room, 'A');
  assert.deepEqual(s.network, { type: 'wifi', ssid: 'SK_WiFiGIGA', signal: 60, band: '5GHz' });
  assert.equal(s.lcd, true);
  assert.equal(s.serial, null, '불리언이 아니면 null');
  assert.equal(s.central_library, false);
  assert.ok(!('ip' in s) && !('mac' in s) && !('ip' in s.network), 'IP/MAC 은 저장하지 않음');
});

test('normalizeDeviceStatus: 이상한 값 방어', () => {
  const s = normalizeDeviceStatus({ room: 'B', network: { type: 'satellite', ssid: 'x', signal: 999, band: '60GHz' } });
  assert.deepEqual(s.network, { type: 'unknown', ssid: null, signal: null, band: null });
  const e = normalizeDeviceStatus({ room: 'A', network: { type: 'ethernet', ssid: 'leak', signal: 50 } });
  assert.deepEqual(e.network, { type: 'ethernet', ssid: null, signal: null, band: null });
  assert.throws(() => normalizeDeviceStatus({ room: 'AB' }));
  assert.throws(() => normalizeDeviceStatus({}));
});

test('buildSystemStatus: 90초 이내 보고 = 연결됨, 보고 없는 아두이노 = 연결 안 됨', () => {
  const rows = [{ device_id: 'library-server', room: 'A', last_seen_at: ago(20_000),
                  payload: JSON.stringify({ network: { type: 'wifi', ssid: 'Hotspot', signal: 80, band: '2.4GHz' }, lcd: true, serial: false }) }];
  const r = buildSystemStatus(rows, { fetched_at: ago(30_000), last_error: null }, NOW);
  assert.deepEqual(r.devices.map((d) => [d.room, d.kind, d.online]), [['A', 'raspberry-pi', true], ['B', 'arduino', false], ['C', 'arduino', false]]);
  assert.equal(r.devices[0].network.ssid, 'Hotspot');
  assert.equal(r.devices[1].last_seen_at, null);
  assert.deepEqual(r.central_library, { ok: true, fetched_at: ago(30_000), degraded: false });
});

test('buildSystemStatus: 오래된 보고 / 중앙도서관 실패·지연', () => {
  const rows = [{ device_id: 'library-server', room: 'A', last_seen_at: ago(120_000), payload: '{}' }];
  const stale = buildSystemStatus(rows, { fetched_at: ago(10 * 60_000), last_error: null }, NOW);
  assert.equal(stale.devices[0].online, false);
  assert.equal(stale.central_library.ok, false);
  const failed = buildSystemStatus([], { fetched_at: ago(10_000), last_error: '중앙도서관: http_526' }, NOW);
  assert.deepEqual([failed.central_library.ok, failed.central_library.degraded], [false, true]);
  assert.equal(buildSystemStatus([], null, NOW).central_library.ok, false);
});

test('normalizeBle: 주소 끝 4자리만, 최대 5대, 이름·전체 주소 버림', () => {
  const b = normalizeBle({
    server: true,
    connected: [
      { id: '60:d5', since: '2026-11-07T10:00:00Z', name: '홍길동의 Galaxy', address: '5D:C0:9A:CD:60:D5' },
      { id: '5D:C0:9A:CD:60:D5' },               // 전체 주소 → 버림
      { id: 'EE:FF', since: 'not-a-date' },
      ...Array.from({ length: 10 }, () => ({ id: '11:22' })),
    ],
  });
  assert.equal(b.server, true);
  assert.deepEqual(b.connected[0], { id: '60:D5', since: '2026-11-07T10:00:00.000Z' });
  assert.deepEqual(b.connected[1], { id: 'EE:FF', since: null });
  assert.ok(b.connected.length <= 5);
  assert.ok(!JSON.stringify(b).includes('Galaxy') && !JSON.stringify(b).includes('5D:C0'));
  assert.equal(normalizeBle(null), null);
  assert.deepEqual(normalizeBle({ server: 'yes' }), { server: null, connected: null });
});

test('buildSystemStatus: 라즈베리파이에만 ble 정보', () => {
  const rows = [{ device_id: 'library-server', room: 'A', last_seen_at: ago(10_000),
                  payload: JSON.stringify({ ble: { server: true, connected: [{ id: '60:D5', since: null }] } }) }];
  const r = buildSystemStatus(rows, null, NOW);
  assert.deepEqual(r.devices[0].ble, { server: true, connected: [{ id: '60:D5', since: null }] });
  assert.ok(!('ble' in r.devices[1]));
  const old = buildSystemStatus([{ ...rows[0], payload: '{}' }], null, NOW);
  assert.equal(old.devices[0].ble, null, '구버전 에이전트 보고 = 정보 없음');
});
