/**
 * 예약 / 취소 / 착석 / 퇴실 / 만료 처리 및 장치 이벤트 수신.
 *
 * 원자성 원칙:
 *  - 생성: INSERT ... SELECT ... WHERE EXISTS(좌석 사용 가능) + 부분 UNIQUE 인덱스
 *          (좌석당 활성 예약 1건, 학생당 활성 예약 1건)로 동시 요청 중 하나만 성공한다.
 *  - 상태 전이: UPDATE ... WHERE id = ? AND status = '<이전 상태>' RETURNING 으로
 *          조건이 맞을 때만 한 번에 변경한다. "조회 후 변경" 패턴을 쓰지 않는다.
 */
import { HttpError, json, readJson, nowIso, logEvent, parsePositiveInt } from './router.js';
import { requireStudent, requireAdmin, requireDevice } from './auth.js';
import { parseSeatId, broadcastSeatChange } from './seats.js';

function holdMinutes(env) {
  const n = Number(env.RESERVATION_HOLD_MINUTES);
  return Number.isFinite(n) && n > 0 && n <= 120 ? n : 15;
}

function uniqueViolation(err) {
  const message = String(err?.message ?? err);
  if (!/UNIQUE constraint failed/i.test(message)) return null;
  if (message.includes('reservations.student_id')) return 'student';
  if (message.includes('reservations.seat_id')) return 'seat';
  return 'unknown';
}

/** 착석 기한이 지난 예약을 만료 처리한다. Cron 및 예약 생성 직전에 호출된다. */
export async function expireStaleReservations(env) {
  const now = nowIso();
  const { results } = await env.DB.prepare(
    `UPDATE reservations
        SET status = 'expired', ended_at = ?1, end_reason = 'hold_timeout'
      WHERE status = 'reserved' AND expires_at <= ?1
      RETURNING id, seat_id, student_id`,
  ).bind(now).all();

  for (const row of results ?? []) {
    await logEvent(env, {
      source: 'system',
      eventType: 'reservation.expired',
      actorType: 'system',
      seatId: row.seat_id,
      reservationId: row.id,
    });
    await broadcastSeatChange(env, row.seat_id, 'reservation.expired');
  }
  return results?.length ?? 0;
}

export async function handleCreateReservation(ctx) {
  const { env } = ctx;
  const auth = await requireStudent(ctx);
  const body = await readJson(ctx.request);
  const seatId = parseSeatId(body.seat_id);

  await expireStaleReservations(env);

  const now = new Date();
  const reservedAt = nowIso(now);
  const expiresAt = nowIso(new Date(now.getTime() + holdMinutes(env) * 60_000));

  let row;
  try {
    row = await env.DB.prepare(
      `INSERT INTO reservations (seat_id, student_id, status, reserved_at, expires_at)
       SELECT ?1, ?2, 'reserved', ?3, ?4
        WHERE EXISTS (SELECT 1 FROM seats WHERE id = ?1 AND status = 'available')
       RETURNING id, seat_id, status, reserved_at, expires_at`,
    ).bind(seatId, auth.subjectId, reservedAt, expiresAt).first();
  } catch (err) {
    const conflict = uniqueViolation(err);
    if (!conflict) throw err;
    await logEvent(env, {
      source: 'web',
      eventType: 'reservation.conflict',
      actorType: 'student',
      actorId: auth.subjectId,
      seatId,
      payload: { conflict },
    });
    if (conflict === 'student') {
      throw new HttpError(409, 'student_has_active_reservation', '이미 이용 중이거나 예약한 좌석이 있습니다.');
    }
    throw new HttpError(409, 'seat_already_reserved', '이미 다른 사용자가 예약한 좌석입니다.');
  }

  if (!row) {
    const exists = await env.DB.prepare('SELECT 1 FROM seats WHERE id = ?1').bind(seatId).first();
    if (!exists) throw new HttpError(404, 'seat_not_found', '존재하지 않는 좌석입니다.');
    throw new HttpError(409, 'seat_unavailable', '현재 예약할 수 없는 좌석입니다.');
  }

  await logEvent(env, {
    source: 'web',
    eventType: 'reservation.created',
    actorType: 'student',
    actorId: auth.subjectId,
    seatId,
    reservationId: row.id,
  });
  await broadcastSeatChange(env, seatId, 'reservation.created');
  return json({ reservation: row }, 201);
}

export async function handleMyReservation(ctx) {
  const auth = await requireStudent(ctx);
  const row = await ctx.env.DB.prepare(
    `SELECT r.id, r.seat_id, s.label AS seat_label, rm.code AS room, rm.name AS room_name,
            r.status, r.reserved_at, r.expires_at, r.checked_in_at
       FROM reservations r
       JOIN seats s ON s.id = r.seat_id
       JOIN rooms rm ON rm.id = s.room_id
      WHERE r.student_id = ?1 AND r.status IN ('reserved', 'occupied')`,
  ).bind(auth.subjectId).first();
  return json({ reservation: row ?? null });
}

/**
 * 본인 예약의 상태를 조건부로 전이한다.
 * @returns {Promise<Response>}
 */
async function transitionOwn(ctx, { sql, eventType, notFoundMessage }) {
  const { env } = ctx;
  const auth = await requireStudent(ctx);
  const reservationId = parsePositiveInt(ctx.params.id, 'reservation_id');

  const row = await env.DB.prepare(sql).bind(nowIso(), reservationId, auth.subjectId).first();
  if (!row) {
    throw new HttpError(409, 'invalid_reservation_state', notFoundMessage);
  }

  await logEvent(env, {
    source: 'web',
    eventType,
    actorType: 'student',
    actorId: auth.subjectId,
    seatId: row.seat_id,
    reservationId: row.id,
  });
  await broadcastSeatChange(env, row.seat_id, eventType);
  return json({ reservation: row });
}

export function handleCancelReservation(ctx) {
  return transitionOwn(ctx, {
    sql: `UPDATE reservations
             SET status = 'cancelled', ended_at = ?1, end_reason = 'user_cancelled'
           WHERE id = ?2 AND student_id = ?3 AND status = 'reserved'
           RETURNING id, seat_id, status, ended_at`,
    eventType: 'reservation.cancelled',
    notFoundMessage: '취소할 수 있는 예약이 없습니다. (착석 후에는 퇴실을 이용하세요)',
  });
}

/**
 * 착석 처리.
 * TODO: 현재는 학생 본인 요청만으로 착석 처리된다. 원격 착석을 막기 위해
 *       이후 단계에서 현장 장치(키오스크/버튼) 확인 절차를 추가해야 한다.
 */
export function handleCheckIn(ctx) {
  return transitionOwn(ctx, {
    sql: `UPDATE reservations
             SET status = 'occupied', checked_in_at = ?1
           WHERE id = ?2 AND student_id = ?3 AND status = 'reserved' AND expires_at > ?1
           RETURNING id, seat_id, status, checked_in_at`,
    eventType: 'reservation.checked_in',
    notFoundMessage: '착석 처리할 수 있는 예약이 없거나 착석 기한이 지났습니다.',
  });
}

export function handleCheckOut(ctx) {
  return transitionOwn(ctx, {
    sql: `UPDATE reservations
             SET status = 'completed', checked_out_at = ?1, ended_at = ?1, end_reason = 'checked_out'
           WHERE id = ?2 AND student_id = ?3 AND status = 'occupied'
           RETURNING id, seat_id, status, checked_out_at`,
    eventType: 'reservation.checked_out',
    notFoundMessage: '퇴실 처리할 수 있는 이용 기록이 없습니다.',
  });
}

/** 관리자: 활성 예약 강제 해제 (사유 필수) */
export async function handleAdminReleaseReservation(ctx) {
  const { env } = ctx;
  const admin = await requireAdmin(ctx);
  const reservationId = parsePositiveInt(ctx.params.id, 'reservation_id');
  const body = await readJson(ctx.request);
  const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 200) : '';
  if (!reason) throw new HttpError(400, 'reason_required', '해제 사유를 입력해야 합니다.');

  const now = nowIso();
  const row = await env.DB.prepare(
    `UPDATE reservations
        SET status = CASE status WHEN 'reserved' THEN 'cancelled' ELSE 'completed' END,
            ended_at = ?1,
            checked_out_at = CASE status WHEN 'occupied' THEN ?1 ELSE checked_out_at END,
            end_reason = 'admin_release'
      WHERE id = ?2 AND status IN ('reserved', 'occupied')
      RETURNING id, seat_id, status, ended_at`,
  ).bind(now, reservationId).first();
  if (!row) throw new HttpError(409, 'invalid_reservation_state', '해제할 수 있는 활성 예약이 없습니다.');

  await logEvent(env, {
    source: 'admin',
    eventType: 'reservation.admin_released',
    actorType: 'admin',
    actorId: admin.subjectId,
    seatId: row.seat_id,
    reservationId: row.id,
    payload: { reason },
  });
  await broadcastSeatChange(env, row.seat_id, 'reservation.admin_released');
  return json({ reservation: row });
}

/** 관리자: 이벤트 로그 조회 (최신순, before_id 커서) */
export async function handleAdminEvents(ctx) {
  await requireAdmin(ctx);
  const limitRaw = Number(ctx.url.searchParams.get('limit') || 50);
  const limit = Number.isInteger(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 50;
  const beforeParam = ctx.url.searchParams.get('before_id');
  const beforeId = beforeParam ? parsePositiveInt(beforeParam, 'before_id') : Number.MAX_SAFE_INTEGER;

  const { results } = await ctx.env.DB.prepare(
    `SELECT id, occurred_at, source, event_type, actor_type, actor_id, seat_id, reservation_id, payload
       FROM events WHERE id < ?1 ORDER BY id DESC LIMIT ?2`,
  ).bind(beforeId, limit).all();

  return json({
    events: results.map((e) => ({ ...e, payload: e.payload ? safeParse(e.payload) : null })),
  });
}

function safeParse(text) {
  try { return JSON.parse(text); } catch { return null; }
}

const DEVICE_EVENT_TYPES = new Set([
  'agent_started',
  'heartbeat',
  'serial_connected',
  'serial_disconnected',
  'serial_hello',
  'protocol_error',
  'button',
  'command_ack',
]);

/**
 * 라즈베리파이 장치 이벤트 수신.
 * 현재 단계에서는 모든 장치 이벤트를 기록만 하며 좌석 상태를 변경하지 않는다.
 * (버튼 -> 동작 매핑은 HARDWARE.md 설계 확정 후 구현)
 */
export async function handleDeviceEvent(ctx) {
  const device = await requireDevice(ctx);
  const body = await readJson(ctx.request, 4 * 1024);
  const type = typeof body.type === 'string' ? body.type : '';
  if (!DEVICE_EVENT_TYPES.has(type)) {
    throw new HttpError(400, 'invalid_event_type', '지원하지 않는 장치 이벤트입니다.');
  }

  const payload = {};
  for (const key of ['button_id', 'action', 'firmware', 'device_time', 'seq', 'detail', 'command_id', 'command', 'result']) {
    if (body[key] !== undefined) payload[key] = String(body[key]).slice(0, 64);
  }

  await logEvent(ctx.env, {
    source: 'device',
    eventType: `device.${type}`,
    actorType: 'device',
    actorId: device.deviceId,
    payload,
  });
  return json({ accepted: true, action: 'logged_only' }, 202);
}
