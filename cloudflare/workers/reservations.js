/**
 * 예약 / 취소 / 착석 / 퇴실 / 만료 처리 및 장치 이벤트 수신.
 *
 * 원자성 원칙:
 *  - 생성: INSERT ... SELECT ... WHERE EXISTS(좌석 사용 가능) + 부분 UNIQUE 인덱스
 *          (좌석당 활성 예약 1건, 학생당 활성 예약 1건)로 동시 요청 중 하나만 성공한다.
 *  - 상태 전이: UPDATE ... WHERE id = ? AND status = '<이전 상태>' RETURNING 으로
 *          조건이 맞을 때만 한 번에 변경한다. "조회 후 변경" 패턴을 쓰지 않는다.
 *
 * 이용 시간 (migration 0005):
 *  - 착석 시 1~4시간을 고르고 usage_ends_at 을 기록한다.
 *  - usage_ends_at 이 지나면 Cron 이 자동 퇴실 (end_reason = 'time_expired').
 *  - 재실 확인(모바일 앱 블루투스)이 오면 남은 시간이 2시간 미만일 때 2시간으로 올린다.
 */
import { HttpError, json, readJson, nowIso, logEvent, parsePositiveInt } from './router.js';
import { requireStudent, requireAdmin, requireDevice } from './auth.js';
import { parseSeatId, broadcastSeatChange } from './seats.js';
import { EXPECTED_DEVICES } from './system-status.js';

export const USAGE_HOURS_MIN = 1;
export const USAGE_HOURS_MAX = 4;
/** 재실 확인 시 남은 이용 시간을 이 값 아래로 내려가지 않게 유지한다 */
export const PRESENCE_KEEP_MS = 2 * 60 * 60_000;
/** 이보다 오래 재실 확인이 없다가 다시 오면 "돌아옴"으로 기록·방송한다 */
const PRESENCE_RETURN_MS = 10 * 60_000;

/** 블루투스 재실 확인이 가능한 열람실 (라즈베리파이 담당 열람실) */
export const PRESENCE_ROOMS = Object.freeze(
  EXPECTED_DEVICES.filter((d) => d.kind === 'raspberry-pi').map((d) => d.room),
);

/** 착석 요청의 이용 시간(시간 단위 정수 1~4) 검증 */
export function parseUsageHours(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < USAGE_HOURS_MIN || n > USAGE_HOURS_MAX) {
    throw new HttpError(400, 'invalid_usage_hours', `이용 시간은 ${USAGE_HOURS_MIN}~${USAGE_HOURS_MAX}시간 중에서 골라 주세요.`);
  }
  return n;
}

/** 재실 확인 후의 이용 종료 시각: 남은 시간이 2시간 미만이면 지금+2시간, 아니면 그대로 */
export function presenceEndsAt(currentEndsAt, now = Date.now()) {
  const keep = now + PRESENCE_KEEP_MS;
  const current = Date.parse(currentEndsAt ?? '');
  return Number.isNaN(current) || current < keep ? new Date(keep).toISOString() : new Date(current).toISOString();
}

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

/**
 * 착석 기한이 지난 예약을 만료 처리하고, 이용 시간이 끝난 좌석을 자동 퇴실 처리한다.
 * Cron(1분) 및 예약 생성 직전에 호출된다.
 */
export async function expireStaleReservations(env) {
  const now = nowIso();
  const expired = await expireHolds(env, now);
  const finished = await finishUsage(env, now);
  return expired + finished;
}

/** 이용 시간이 끝난 좌석 자동 퇴실 */
async function finishUsage(env, now) {
  const { results } = await env.DB.prepare(
    `UPDATE reservations
        SET status = 'completed', checked_out_at = ?1, ended_at = ?1, end_reason = 'time_expired'
      WHERE status = 'occupied' AND usage_ends_at IS NOT NULL AND usage_ends_at <= ?1
      RETURNING id, seat_id, student_id`,
  ).bind(now).all();

  for (const row of results ?? []) {
    await logEvent(env, {
      source: 'system',
      eventType: 'reservation.time_expired',
      actorType: 'system',
      seatId: row.seat_id,
      reservationId: row.id,
    });
    await broadcastSeatChange(env, row.seat_id, 'reservation.time_expired');
  }
  return results?.length ?? 0;
}

async function expireHolds(env, now) {
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
            r.status, r.reserved_at, r.expires_at, r.checked_in_at,
            r.usage_hours, r.usage_ends_at, r.last_presence_at
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
async function transitionOwn(ctx, { sql, eventType, notFoundMessage, auth: knownAuth, extraBinds = [], payload }) {
  const { env } = ctx;
  const auth = knownAuth ?? await requireStudent(ctx);
  const reservationId = parsePositiveInt(ctx.params.id, 'reservation_id');

  const row = await env.DB.prepare(sql).bind(nowIso(), reservationId, auth.subjectId, ...extraBinds).first();
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
    payload,
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
 * 착석 처리. body: { "hours": 1~4 } — 이용 시간을 함께 정한다.
 * TODO: 현재는 학생 본인 요청만으로 착석 처리된다. 원격 착석을 막기 위해
 *       이후 단계에서 현장 장치(키오스크/버튼) 확인 절차를 추가해야 한다.
 */
export async function handleCheckIn(ctx) {
  const auth = await requireStudent(ctx);
  const body = await readJson(ctx.request, 1024);
  const hours = parseUsageHours(body.hours);
  const endsAt = nowIso(new Date(Date.now() + hours * 60 * 60_000));
  return transitionOwn(ctx, {
    auth,
    sql: `UPDATE reservations
             SET status = 'occupied', checked_in_at = ?1, usage_hours = ?4, usage_ends_at = ?5
           WHERE id = ?2 AND student_id = ?3 AND status = 'reserved' AND expires_at > ?1
           RETURNING id, seat_id, status, checked_in_at, usage_hours, usage_ends_at`,
    extraBinds: [hours, endsAt],
    payload: { hours },
    eventType: 'reservation.checked_in',
    notFoundMessage: '착석 처리할 수 있는 예약이 없거나 착석 기한이 지났습니다.',
  });
}

/**
 * POST /api/reservations/me/presence — 모바일 앱의 재실 확인 (블루투스로 열람실 장치와 연결됨).
 *
 * 남은 이용 시간이 2시간 미만이면 2시간으로 올린다. 이용 시간이 이미 끝난 예약은 연장하지 않는다.
 * 블루투스 장치가 있는 열람실(PRESENCE_ROOMS)의 좌석만 대상이다.
 * 주의: 보고는 앱이 직접 보내므로 조작된 앱이면 열람실 밖에서도 보낼 수 있다 (docs/API_SPEC.md 참고).
 * 위치·신호 기록은 저장하지 않는다. 마지막 확인 시각만 덮어쓴다.
 */
export async function handlePresence(ctx) {
  const { env } = ctx;
  const auth = await requireStudent(ctx);
  await readJson(ctx.request, 1024); // 본문 형식만 확인 (현재 사용하는 필드 없음)

  const now = Date.now();
  const nowStr = nowIso(new Date(now));
  const keepUntil = nowIso(new Date(now + PRESENCE_KEEP_MS));

  // 로그·방송용으로만 이전 값을 읽는다 (연장 여부 판단은 아래 조건부 UPDATE 가 한다).
  const before = await env.DB.prepare(
    `SELECT last_presence_at, usage_ends_at FROM reservations WHERE student_id = ?1 AND status = 'occupied'`,
  ).bind(auth.subjectId).first();

  const row = await env.DB.prepare(
    `UPDATE reservations
        SET last_presence_at = ?1,
            usage_ends_at = CASE WHEN usage_ends_at < ?2 THEN ?2 ELSE usage_ends_at END
      WHERE student_id = ?3 AND status = 'occupied'
        AND usage_ends_at IS NOT NULL AND usage_ends_at > ?1
        AND seat_id IN (SELECT s.id FROM seats s JOIN rooms rm ON rm.id = s.room_id
                         WHERE rm.code IN (SELECT value FROM json_each(?4)))
      RETURNING id, seat_id, usage_hours, usage_ends_at, last_presence_at`,
  ).bind(nowStr, keepUntil, auth.subjectId, JSON.stringify(PRESENCE_ROOMS)).first();

  if (!row) {
    throw new HttpError(409, 'no_presence_target', '자동 연장할 수 있는 이용 중인 좌석이 없습니다.');
  }

  const lastSeen = Date.parse(before?.last_presence_at ?? '');
  const returned = Number.isNaN(lastSeen) || now - lastSeen > PRESENCE_RETURN_MS;
  const previousEnd = Date.parse(before?.usage_ends_at ?? '');
  const extended = Number.isNaN(previousEnd) || Date.parse(row.usage_ends_at) > previousEnd;
  if (returned) {
    await logEvent(env, {
      source: 'web',
      eventType: 'reservation.presence_returned',
      actorType: 'student',
      actorId: auth.subjectId,
      seatId: row.seat_id,
      reservationId: row.id,
      payload: { usage_ends_at: row.usage_ends_at },
    });
    await broadcastSeatChange(env, row.seat_id, 'reservation.presence');
  }
  return json({ reservation: row, extended, keep_minutes: PRESENCE_KEEP_MS / 60_000 });
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
