// 장치 상태 / 시스템 상태 단위 테스트
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemStatus, normalizeDeviceStatus } from '../workers/system-status.js';

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
