/**
 * 현장 장치 상태 (키오스크 임시 상태 표시줄용)
 *
 *  POST /api/device/status  (장치 토큰) : 장치가 30초마다 최신 상태 보고
 *  GET  /api/system-status  (공개)      : 라즈베리파이(A) / 아두이노(B, C) 연결 여부,
 *                                          라즈베리파이 Wi-Fi, 경기대 도서관 서버 조회 상태
 *
 * 장치 입력도 신뢰하지 않는다: 허용된 필드만 정규화해서 저장한다. IP/MAC 등은 저장하지 않는다.
 */
import { json, nowIso, readJson, HttpError, logEvent } from './router.js';
import { requireDevice, requireAdmin } from './auth.js';
import { SOURCE as CENTRAL_LIBRARY_SOURCE } from './central-library.js';
import { SEAT_ROOM_NAME } from './seats.js';

const COMMAND_TTL_MS = 60_000;       // 원격 명령 유효 시간 (늦게 도착한 명령은 장치가 무시)
export const SHUTDOWN_CONFIRM_TEXT = 'SHUTDOWN';

const ONLINE_MS = 90_000;            // 마지막 보고가 90초 이내면 연결됨
const CENTRAL_OK_MS = 3 * 60_000;    // 중앙도서관 정보가 3분 이내 갱신되었으면 정상

/** 열람실별 담당 장치 (HARDWARE.md 와 일치) */
export const EXPECTED_DEVICES = Object.freeze([
  { room: 'A', kind: 'raspberry-pi', label: '라즈베리파이 (열람실 A)' },
  { room: 'B', kind: 'arduino', label: '아두이노 (열람실 B)' },
  { room: 'C', kind: 'arduino', label: '아두이노 (열람실 C)' },
]);

const NETWORK_TYPES = new Set(['wifi', 'ethernet', 'none', 'unknown']);
const BANDS = new Set(['2.4GHz', '5GHz']);

function text(value, max) {
  if (value == null) return null;
  const s = String(value).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
  return s || null;
}

function flag(value) {
  return value === true ? true : value === false ? false : null;
}

/** 장치 보고 본문 정규화 */
export function normalizeDeviceStatus(body) {
  const room = String(body?.room ?? '').trim().toUpperCase();
  if (!/^[A-Z]$/.test(room)) throw new HttpError(400, 'invalid_room', 'room 값이 올바르지 않습니다.');
  const net = body?.network ?? {};
  const type = NETWORK_TYPES.has(net.type) ? net.type : 'unknown';
  const signal = Number.isInteger(net.signal) && net.signal >= 0 && net.signal <= 100 ? net.signal : null;
  return {
    room,
    agent_version: text(body?.agent_version, 20),
    network: {
      type,
      ssid: type === 'wifi' ? text(net.ssid, 64) : null,
      signal: type === 'wifi' ? signal : null,
      band: type === 'wifi' && BANDS.has(net.band) ? net.band : null,
    },
    lcd: flag(body?.lcd),
    serial: flag(body?.serial),
    central_library: flag(body?.central_library),
  };
}

export async function handleDeviceStatus(ctx) {
  const device = await requireDevice(ctx);
  const status = normalizeDeviceStatus(await readJson(ctx.request, 4 * 1024));
  await ctx.env.DB.prepare(
    `INSERT INTO device_status (device_id, room, last_seen_at, payload) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT (device_id) DO UPDATE SET room = excluded.room, last_seen_at = excluded.last_seen_at, payload = excluded.payload`,
  ).bind(device.deviceId, status.room, nowIso(), JSON.stringify(status)).run();
  return json({ accepted: true }, 202);
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

/** DB 행 -> 공개 응답 (순수 함수, 테스트 용이) */
export function buildSystemStatus(rows, central, now = Date.now()) {
  const byRoom = new Map();
  for (const row of rows) {
    const prev = byRoom.get(row.room);
    if (!prev || row.last_seen_at > prev.last_seen_at) byRoom.set(row.room, row);
  }
  const devices = EXPECTED_DEVICES.map((expected) => {
    const row = byRoom.get(expected.room);
    const status = row ? safeParse(row.payload) : null;
    const age = row ? now - Date.parse(row.last_seen_at) : Infinity;
    return {
      ...expected,
      online: age <= ONLINE_MS,
      last_seen_at: row?.last_seen_at ?? null,
      network: status?.network ?? null,
      lcd: status?.lcd ?? null,
      serial: status?.serial ?? null,
    };
  });

  const fetchedAge = central?.fetched_at ? now - Date.parse(central.fetched_at) : Infinity;
  return {
    devices,
    central_library: {
      ok: fetchedAge <= CENTRAL_OK_MS && !central?.last_error,
      fetched_at: central?.fetched_at ?? null,
      degraded: Boolean(central?.last_error),
    },
    generated_at: new Date(now).toISOString(),
  };
}

export async function handleSystemStatus({ env }) {
  const [{ results }, central] = await Promise.all([
    env.DB.prepare('SELECT device_id, room, last_seen_at, payload FROM device_status').all(),
    env.DB.prepare('SELECT fetched_at, last_error FROM external_snapshots WHERE source = ?1').bind(CENTRAL_LIBRARY_SOURCE).first(),
  ]);
  return json(buildSystemStatus(results ?? [], central));
}

/**
 * POST /api/admin/devices/:room/shutdown  (관리자 전용)
 * body: { "confirm": "SHUTDOWN" }
 *
 * 안전 장치:
 *  - 관리자 세션 + 확인 문자열 필요
 *  - 라즈베리파이 담당 열람실만 대상 (아두이노는 해당 없음)
 *  - 장치가 지금 연결되어 있을 때만 보냄 (오프라인 장치에 명령을 쌓아두지 않음)
 *  - 명령에 만료 시각을 넣어 늦게 도착하면 장치가 무시
 *  - 요청은 events 에 기록
 */
export async function handleAdminDeviceShutdown(ctx) {
  const admin = await requireAdmin(ctx);
  const room = String(ctx.params.room ?? '').toUpperCase();
  const expected = EXPECTED_DEVICES.find((d) => d.room === room);
  if (!expected) throw new HttpError(404, 'device_not_found', '존재하지 않는 장치입니다.');
  if (expected.kind !== 'raspberry-pi') {
    throw new HttpError(400, 'unsupported_device', '원격 종료는 라즈베리파이만 지원합니다.');
  }

  const body = await readJson(ctx.request, 1024);
  if (body.confirm !== SHUTDOWN_CONFIRM_TEXT) {
    throw new HttpError(400, 'confirmation_required', `확인 문자열 "${SHUTDOWN_CONFIRM_TEXT}" 가 필요합니다.`);
  }

  const row = await ctx.env.DB.prepare(
    'SELECT device_id, last_seen_at FROM device_status WHERE room = ?1 ORDER BY last_seen_at DESC LIMIT 1',
  ).bind(room).first();
  const online = row && Date.now() - Date.parse(row.last_seen_at) <= ONLINE_MS;
  if (!online) throw new HttpError(409, 'device_offline', '장치가 연결되어 있지 않아 명령을 보낼 수 없습니다.');

  const now = new Date();
  const command = {
    type: 'device.command',
    command: 'shutdown',
    id: crypto.randomUUID(),
    room,
    issued_at: now.toISOString(),
    expires_at: new Date(now.getTime() + COMMAND_TTL_MS).toISOString(),
  };

  const stub = ctx.env.SEAT_ROOM.get(ctx.env.SEAT_ROOM.idFromName(SEAT_ROOM_NAME));
  const res = await stub.fetch('https://seat-room/command', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
  });
  const { delivered = 0 } = await res.json().catch(() => ({}));

  await logEvent(ctx.env, {
    source: 'admin',
    eventType: 'device.shutdown_requested',
    actorType: 'admin',
    actorId: admin.subjectId,
    payload: { room, device_id: row.device_id, command_id: command.id, delivered },
  });
  if (delivered === 0) {
    throw new HttpError(409, 'device_not_listening', '장치의 실시간 연결이 없어 명령을 전달하지 못했습니다.');
  }
  return json({ accepted: true, command_id: command.id, delivered, expires_at: command.expires_at }, 202);
}
