/**
 * 좌석 조회, 관리자 좌석 상태 변경, 실시간 브로드캐스트, WebSocket 연결.
 *
 * 좌석의 표시 상태(state)는 다음 규칙으로 파생된다.
 *   seats.status = 'maintenance'          -> maintenance
 *   활성 예약(reserved/occupied) 존재      -> 해당 예약 상태
 *   그 외                                  -> available
 */
import { HttpError, json, readJson, nowIso, logEvent, parsePositiveInt } from './router.js';
import { authenticate, requireAdmin, requireDevice } from './auth.js';

// 실시간 알림 허브(Durable Object) 이름. 모든 열람실이 하나의 허브를 공유한다.
export const SEAT_ROOM_NAME = 'reading-room-1';
const MAX_SEAT_ID = 10_000;

/** seat_id 는 전체 열람실에서 고유한 좌석 번호. 실제 존재 여부는 DB 조건문이 판단한다. */
export function parseSeatId(value) {
  const seatId = parsePositiveInt(value, 'seat_id');
  if (seatId > MAX_SEAT_ID) throw new HttpError(400, 'invalid_parameter', 'seat_id 값이 범위를 벗어났습니다.');
  return seatId;
}

/** ?room=A 형식의 열람실 코드 (없으면 null = 전체) */
export function parseRoomCode(url) {
  const raw = url.searchParams.get('room');
  if (raw == null || raw === '') return null;
  const code = raw.trim().toUpperCase();
  if (!/^[A-Z]$/.test(code)) throw new HttpError(400, 'invalid_parameter', 'room 값이 올바르지 않습니다.');
  return code;
}

async function querySeats(env) {
  const { results } = await env.DB.prepare(
    `SELECT s.id, s.label, s.seat_no, s.status AS seat_status, s.updated_at,
            rm.code AS room_code, rm.name AS room_name, rm.sort_order AS room_order,
            r.id AS reservation_id, r.student_id, r.status AS reservation_status,
            r.reserved_at, r.expires_at, r.checked_in_at
       FROM seats s
       JOIN rooms rm ON rm.id = s.room_id
       LEFT JOIN reservations r
         ON r.seat_id = s.id AND r.status IN ('reserved', 'occupied')
      ORDER BY rm.sort_order, s.seat_no`,
  ).all();
  return results;
}

/** 열람실별 요약 (전체 좌석 기준) */
function summarizeRooms(rows) {
  const rooms = new Map();
  for (const row of rows) {
    if (!rooms.has(row.room_code)) {
      rooms.set(row.room_code, { code: row.room_code, name: row.room_name, total: 0, available: 0 });
    }
    const room = rooms.get(row.room_code);
    room.total += 1;
    if (seatState(row) === 'available') room.available += 1;
  }
  return [...rooms.values()];
}

function filterRoom(rows, roomCode) {
  if (!roomCode) return rows;
  const filtered = rows.filter((row) => row.room_code === roomCode);
  if (filtered.length === 0) throw new HttpError(404, 'room_not_found', '존재하지 않는 열람실입니다.');
  return filtered;
}

function seatState(row) {
  if (row.seat_status === 'maintenance') return 'maintenance';
  return row.reservation_status || 'available';
}

/** 공개용: 다른 학생의 식별 정보는 포함하지 않는다. */
function toPublicSeat(row, viewerStudentId) {
  const mine = viewerStudentId != null && row.student_id === viewerStudentId;
  const seat = {
    id: row.id,
    room: row.room_code,
    seat_no: row.seat_no,
    label: row.label,
    state: seatState(row),
    mine,
  };
  if (mine) {
    seat.reservation_id = row.reservation_id;
    seat.expires_at = row.expires_at;
  }
  return seat;
}

export async function handleListSeats({ request, env, url }) {
  const roomCode = parseRoomCode(url);
  let viewer = null;
  if (request.headers.get('Authorization')) {
    try {
      viewer = await authenticate(request, env, 'student');
    } catch {
      viewer = null; // 좌석 현황은 비로그인으로도 조회 가능
    }
  }
  const rows = await querySeats(env);
  return json({
    rooms: summarizeRooms(rows),
    seats: filterRoom(rows, roomCode).map((row) => toPublicSeat(row, viewer?.subjectId)),
    generated_at: nowIso(),
  });
}

export async function handleAdminListSeats(ctx) {
  await requireAdmin(ctx);
  const roomCode = parseRoomCode(ctx.url);
  const rows = await querySeats(ctx.env);
  return json({
    rooms: summarizeRooms(rows),
    seats: filterRoom(rows, roomCode).map((row) => ({
      id: row.id,
      room: row.room_code,
      seat_no: row.seat_no,
      label: row.label,
      state: seatState(row),
      seat_status: row.seat_status,
      updated_at: row.updated_at,
      reservation: row.reservation_id
        ? {
            id: row.reservation_id,
            student_id: row.student_id,
            status: row.reservation_status,
            reserved_at: row.reserved_at,
            expires_at: row.expires_at,
            checked_in_at: row.checked_in_at,
          }
        : null,
    })),
    generated_at: nowIso(),
  });
}

/** 관리자: 좌석을 점검(maintenance) 또는 사용 가능(available)으로 전환 */
export async function handleAdminSetSeatStatus(ctx) {
  const admin = await requireAdmin(ctx);
  const seatId = parseSeatId(ctx.params.id);
  const body = await readJson(ctx.request);
  const status = body.status;
  const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 200) : '';
  if (status !== 'available' && status !== 'maintenance') {
    throw new HttpError(400, 'invalid_parameter', 'status는 available 또는 maintenance여야 합니다.');
  }

  // 활성 예약이 있는 좌석은 점검 전환 불가 (먼저 예약을 해제해야 함) - 조건부 UPDATE로 원자적 처리
  const updated = await ctx.env.DB.prepare(
    `UPDATE seats SET status = ?1, updated_at = ?2
      WHERE id = ?3
        AND (?1 = 'available'
             OR NOT EXISTS (SELECT 1 FROM reservations
                             WHERE seat_id = ?3 AND status IN ('reserved', 'occupied')))
      RETURNING id, status`,
  ).bind(status, nowIso(), seatId).first();

  if (!updated) {
    const exists = await ctx.env.DB.prepare('SELECT 1 FROM seats WHERE id = ?1').bind(seatId).first();
    if (!exists) throw new HttpError(404, 'seat_not_found', '존재하지 않는 좌석입니다.');
    throw new HttpError(409, 'seat_in_use', '활성 예약이 있는 좌석은 점검 상태로 바꿀 수 없습니다.');
  }

  await logEvent(ctx.env, {
    source: 'admin',
    eventType: 'seat.status_changed',
    actorType: 'admin',
    actorId: admin.subjectId,
    seatId,
    payload: { status, reason },
  });
  await broadcastSeatChange(ctx.env, seatId, 'seat.status_changed');
  return json({ seat: updated });
}

/**
 * Durable Object(SeatRoom)를 통해 연결된 모든 클라이언트에 변경 알림을 보낸다.
 * 알림에는 개인정보를 넣지 않으며, 클라이언트는 알림을 받으면 /api/seats를 다시 조회한다.
 */
export async function broadcastSeatChange(env, seatId, reason) {
  try {
    const stub = env.SEAT_ROOM.get(env.SEAT_ROOM.idFromName(SEAT_ROOM_NAME));
    await stub.fetch('https://seat-room/broadcast', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'seats.changed', seat_id: seatId, reason, at: nowIso() }),
    });
  } catch (err) {
    // 브로드캐스트 실패는 DB 상태에 영향을 주지 않는다. 클라이언트는 주기적 재조회로 복구한다.
    console.error('broadcast_failed', seatId, reason, err);
  }
}

/** GET /api/ws : 좌석 변경 알림 구독. ?role=device 는 장치 토큰 필요 */
export async function handleWebSocket(ctx) {
  const { request, env, url } = ctx;
  if ((request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') {
    throw new HttpError(426, 'upgrade_required', 'WebSocket 업그레이드가 필요합니다.');
  }

  let role = 'viewer';
  if (url.searchParams.get('role') === 'device') {
    const device = await requireDevice(ctx);
    role = 'device';
    await logEvent(env, { source: 'device', eventType: 'device.ws_connected', actorType: 'device', actorId: device.deviceId });
  }

  const headers = new Headers(request.headers);
  headers.set('X-Client-Role', role); // 클라이언트가 보낸 값을 덮어쓴다
  const stub = env.SEAT_ROOM.get(env.SEAT_ROOM.idFromName(SEAT_ROOM_NAME));
  return stub.fetch(new Request('https://seat-room/connect', { headers }));
}
