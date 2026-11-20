/**
 * 이용 기록 · 통계 · 공부 시간.
 *
 * 공부 시간(분) = 착석(checked_in_at) ~ 종료 시각.
 *   종료 시각 = 퇴실 시각(checked_out_at) → 없으면 ended_at → 이용 중이면 지금.
 *   단, 이용 종료 시각(usage_ends_at, 재실 확인으로 늘어난 값 포함)을 넘지 않는다
 *   (자동 퇴실 Cron 이 최대 1분 늦게 처리한 시간은 공부 시간에 넣지 않음).
 * 날짜·시간대 구분은 한국 시간(UTC+9, 서머타임 없음)으로 한다. 저장 값은 그대로 UTC 이다.
 *
 * 계산은 모두 아래 순수 함수로 하고(tests/stats.test.mjs), 핸들러는 DB 조회만 한다.
 * 관리자 통계에는 학생별 순위·학번을 넣지 않는다 (개인정보 최소화).
 */
import { HttpError, json, parsePositiveInt } from './router.js';
import { requireStudent, requireAdmin } from './auth.js';

export const KST_OFFSET_MS = 9 * 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
const HOUR_MS = 60 * 60_000;
export const MY_DAILY_DAYS = 7;
export const ADMIN_DAYS_DEFAULT = 7;
export const ADMIN_DAYS_MAX = 31;
export const HISTORY_LIMIT_DEFAULT = 20;
export const HISTORY_LIMIT_MAX = 50;

/** ms → 한국 날짜 'YYYY-MM-DD' */
export function kstDateKey(ms) {
  return new Date(ms + KST_OFFSET_MS).toISOString().slice(0, 10);
}

/** 한국 날짜 'YYYY-MM-DD' 의 0시(UTC ms) */
export function kstDayStart(key) {
  return Date.parse(`${key}T00:00:00.000Z`) - KST_OFFSET_MS;
}

/** 오늘을 포함한 최근 n일의 한국 날짜 목록 (오래된 날 → 오늘) */
export function recentKstDays(n, now = Date.now()) {
  const todayStart = kstDayStart(kstDateKey(now));
  return Array.from({ length: n }, (_, i) => kstDateKey(todayStart - (n - 1 - i) * DAY_MS));
}

function parseMs(iso) {
  const ms = Date.parse(iso ?? '');
  return Number.isNaN(ms) ? null : ms;
}

/**
 * 한 예약의 실제 공부 구간 [start, end) (ms). 착석하지 않았거나 길이가 0 이하이면 null.
 * @param {{status: string, checked_in_at?: string|null, checked_out_at?: string|null, ended_at?: string|null, usage_ends_at?: string|null}} r
 */
export function studyInterval(r, now = Date.now()) {
  const start = parseMs(r.checked_in_at);
  if (start == null) return null;
  let end = parseMs(r.checked_out_at) ?? parseMs(r.ended_at);
  if (end == null) end = r.status === 'occupied' ? now : null;
  if (end == null) return null;
  const limit = parseMs(r.usage_ends_at);
  if (limit != null && limit < end) end = limit;
  if (end > now) end = now;
  return end > start ? { start, end } : null;
}

export function studyMinutes(r, now = Date.now()) {
  const iv = studyInterval(r, now);
  return iv ? Math.floor((iv.end - iv.start) / 60_000) : 0;
}

/** 구간을 [from, to) 로 자른 길이(ms) */
function overlapMs(iv, from, to) {
  return Math.max(0, Math.min(iv.end, to) - Math.max(iv.start, from));
}

/** 공부 구간을 한국 날짜별로 나눈다 (자정을 넘긴 이용은 두 날짜에 나뉨). → Map<날짜, ms> */
export function splitByKstDay(iv) {
  const out = new Map();
  let cursor = iv.start;
  while (cursor < iv.end) {
    const key = kstDateKey(cursor);
    const next = Math.min(iv.end, kstDayStart(key) + DAY_MS);
    out.set(key, (out.get(key) ?? 0) + (next - cursor));
    cursor = next;
  }
  return out;
}

const toMinutes = (ms) => Math.floor(ms / 60_000);

/**
 * 학생 본인 통계.
 * @param {Array<object>} rows 본인 예약 전체 (seat_id, seat_label, room 포함)
 */
export function computeMyStats(rows, now = Date.now()) {
  const days = recentKstDays(MY_DAILY_DAYS, now);
  const dailyMs = new Map(days.map((d) => [d, 0]));
  const studyDays = new Set();
  const seatCounts = new Map();
  let totalMs = 0;
  let sessions = 0;
  let longestMs = 0;
  let noShows = 0;
  let cancelled = 0;

  for (const r of rows) {
    if (r.end_reason === 'hold_timeout') noShows += 1;
    if (r.end_reason === 'user_cancelled') cancelled += 1;
    const iv = studyInterval(r, now);
    if (!iv) continue;
    const ms = iv.end - iv.start;
    sessions += 1;
    totalMs += ms;
    longestMs = Math.max(longestMs, ms);
    for (const [day, dayMs] of splitByKstDay(iv)) {
      studyDays.add(day);
      if (dailyMs.has(day)) dailyMs.set(day, dailyMs.get(day) + dayMs);
    }
    const seat = seatCounts.get(r.seat_id) ?? { seat_id: r.seat_id, label: r.seat_label, room: r.room, count: 0, last: 0 };
    seat.count += 1;
    seat.last = Math.max(seat.last, iv.start);
    seatCounts.set(r.seat_id, seat);
  }

  // 연속 공부 일수: 오늘(또는 오늘 아직 안 했다면 어제)부터 거꾸로 이어진 날 수
  let streak = 0;
  let cursor = kstDayStart(kstDateKey(now));
  if (!studyDays.has(kstDateKey(cursor))) cursor -= DAY_MS;
  while (studyDays.has(kstDateKey(cursor))) { streak += 1; cursor -= DAY_MS; }

  // 자주 앉는 자리: 이용 횟수 → 최근 이용 순
  const favorite = [...seatCounts.values()].sort((a, b) => b.count - a.count || b.last - a.last)[0] ?? null;
  const daily = days.map((date) => ({ date, minutes: toMinutes(dailyMs.get(date)) }));

  return {
    generated_at: new Date(now).toISOString(),
    timezone: 'Asia/Seoul',
    total_study_minutes: toMinutes(totalMs),
    sessions,
    reservations: rows.length,
    no_shows: noShows,
    cancelled,
    today_minutes: daily[daily.length - 1].minutes,
    week_minutes: daily.reduce((sum, d) => sum + d.minutes, 0),
    average_session_minutes: sessions ? toMinutes(totalMs / sessions) : 0,
    longest_session_minutes: toMinutes(longestMs),
    study_days: studyDays.size,
    streak_days: streak,
    favorite_seat: favorite ? { seat_id: favorite.seat_id, label: favorite.label, room: favorite.room, count: favorite.count } : null,
    daily,
  };
}

/** 이용 기록 한 줄 (화면 표시용) */
export function historyItem(r, now = Date.now()) {
  return {
    id: r.id,
    seat_id: r.seat_id,
    seat_label: r.seat_label,
    room: r.room,
    room_name: r.room_name,
    status: r.status,
    end_reason: r.end_reason ?? null,
    reserved_at: r.reserved_at,
    checked_in_at: r.checked_in_at ?? null,
    ended_at: r.checked_out_at ?? r.ended_at ?? null,
    usage_hours: r.usage_hours ?? null,
    study_minutes: studyMinutes(r, now),
  };
}

/**
 * 관리자 통계 (최근 days 일, 한국 날짜 기준).
 * @param {Array<object>} rows 기간과 겹칠 수 있는 예약 (room 포함)
 * @param {Array<{code: string, name: string, seats: number}>} rooms
 */
export function computeAdminStats(rows, rooms, days, now = Date.now()) {
  const dayKeys = recentKstDays(days, now);
  const from = kstDayStart(dayKeys[0]);
  const to = now;
  const daily = new Map(dayKeys.map((d) => [d, { date: d, reservations: 0, check_ins: 0, no_shows: 0, study_minutes: 0 }]));
  const hourMs = new Array(24).fill(0);   // 시간대(한국 시각)별 좌석 사용 시간 합
  const hourSpan = new Array(24).fill(0); // 시간대별로 기간 안에 실제로 지나간 시간 (평균 계산용)
  const roomStats = new Map(rooms.map((r) => [r.code, { code: r.code, name: r.name, seats: r.seats, check_ins: 0, study_minutes: 0, study_ms: 0 }]));
  const students = new Set();
  let reservations = 0;
  let checkIns = 0;
  let noShows = 0;
  let cancelled = 0;
  let totalMs = 0;
  let sessions = 0;

  for (const r of rows) {
    const reservedAt = parseMs(r.reserved_at);
    if (reservedAt != null && reservedAt >= from && reservedAt < to) {
      reservations += 1;
      students.add(r.student_id);
      const day = daily.get(kstDateKey(reservedAt));
      if (day) day.reservations += 1;
      if (r.end_reason === 'hold_timeout') { noShows += 1; if (day) day.no_shows += 1; }
      if (r.end_reason === 'user_cancelled') cancelled += 1;
    }
    const checkedIn = parseMs(r.checked_in_at);
    if (checkedIn != null && checkedIn >= from && checkedIn < to) {
      checkIns += 1;
      const day = daily.get(kstDateKey(checkedIn));
      if (day) day.check_ins += 1;
      const room = roomStats.get(r.room);
      if (room) room.check_ins += 1;
    }

    const iv = studyInterval(r, now);
    if (!iv) continue;
    const clipped = { start: Math.max(iv.start, from), end: Math.min(iv.end, to) };
    if (clipped.end <= clipped.start) continue;
    sessions += 1;
    totalMs += clipped.end - clipped.start;
    const room = roomStats.get(r.room);
    if (room) room.study_ms += clipped.end - clipped.start;
    for (const [key, ms] of splitByKstDay(clipped)) {
      const day = daily.get(key);
      if (day) day.study_minutes += ms / 60_000;
    }
    // 한 시간 단위로 잘라 시간대에 더한다
    let cursor = clipped.start;
    while (cursor < clipped.end) {
      const hourStart = Math.floor(cursor / HOUR_MS) * HOUR_MS;
      const next = Math.min(clipped.end, hourStart + HOUR_MS);
      hourMs[new Date(hourStart + KST_OFFSET_MS).getUTCHours()] += next - cursor;
      cursor = next;
    }
  }

  // 시간대별 "기간 중 평균 사용 좌석 수" = 사용 시간 합 / 그 시간대가 기간 안에서 지나간 시간
  for (let t = Math.floor(from / HOUR_MS) * HOUR_MS; t < to; t += HOUR_MS) {
    hourSpan[new Date(t + KST_OFFSET_MS).getUTCHours()] += overlapMs({ start: t, end: t + HOUR_MS }, from, to);
  }
  const hourly = hourMs.map((ms, hour) => ({
    hour,
    avg_occupied: hourSpan[hour] ? Math.round((ms / hourSpan[hour]) * 10) / 10 : 0,
  }));
  const totalSeats = rooms.reduce((sum, r) => sum + (Number(r.seats) || 0), 0);

  return {
    generated_at: new Date(now).toISOString(),
    timezone: 'Asia/Seoul',
    days,
    from: new Date(from).toISOString(),
    totals: {
      reservations,
      check_ins: checkIns,
      no_shows: noShows,
      cancelled,
      no_show_rate: reservations ? Math.round((noShows / reservations) * 1000) / 1000 : 0,
      unique_students: students.size,
      study_minutes: toMinutes(totalMs),
      average_session_minutes: sessions ? toMinutes(totalMs / sessions) : 0,
      total_seats: totalSeats,
    },
    daily: [...daily.values()].map((d) => ({ ...d, study_minutes: Math.floor(d.study_minutes) })),
    hourly,
    rooms: [...roomStats.values()].map(({ study_ms, ...room }) => ({ ...room, study_minutes: toMinutes(study_ms) })),
  };
}

// ---------------------------------------------------------------------------
// 핸들러
// ---------------------------------------------------------------------------

const MY_ROWS_SQL = `
  SELECT r.id, r.seat_id, s.label AS seat_label, rm.code AS room, rm.name AS room_name,
         r.status, r.reserved_at, r.checked_in_at, r.checked_out_at, r.ended_at, r.end_reason,
         r.usage_hours, r.usage_ends_at
    FROM reservations r
    JOIN seats s ON s.id = r.seat_id
    JOIN rooms rm ON rm.id = s.room_id`;

/** GET /api/reservations/me/stats — 내 공부 시간·이용 통계 */
export async function handleMyStats(ctx) {
  const auth = await requireStudent(ctx);
  const { results } = await ctx.env.DB.prepare(`${MY_ROWS_SQL} WHERE r.student_id = ?1`)
    .bind(auth.subjectId).all();
  return json({ stats: computeMyStats(results ?? []) });
}

/** GET /api/reservations/me/history?limit=20&before_id= — 내 이용 기록 (최신순) */
export async function handleMyHistory(ctx) {
  const auth = await requireStudent(ctx);
  const params = ctx.url.searchParams;
  const limitRaw = Number(params.get('limit') || HISTORY_LIMIT_DEFAULT);
  const limit = Number.isInteger(limitRaw) ? Math.min(Math.max(limitRaw, 1), HISTORY_LIMIT_MAX) : HISTORY_LIMIT_DEFAULT;
  const beforeParam = params.get('before_id');
  const beforeId = beforeParam ? parsePositiveInt(beforeParam, 'before_id') : Number.MAX_SAFE_INTEGER;

  // limit + 1 개를 읽어 다음 페이지가 있는지 확인한다
  const { results } = await ctx.env.DB.prepare(
    `${MY_ROWS_SQL} WHERE r.student_id = ?1 AND r.id < ?2 ORDER BY r.id DESC LIMIT ?3`,
  ).bind(auth.subjectId, beforeId, limit + 1).all();
  const rows = results ?? [];
  const now = Date.now();
  const items = rows.slice(0, limit).map((r) => historyItem(r, now));
  return json({
    history: items,
    next_before_id: rows.length > limit ? items[items.length - 1].id : null,
  });
}

/** GET /api/admin/stats?days=7 — 기간 통계 (1~31일) */
export async function handleAdminStats(ctx) {
  await requireAdmin(ctx);
  const daysParam = ctx.url.searchParams.get('days');
  const days = daysParam == null ? ADMIN_DAYS_DEFAULT : Number(daysParam);
  if (!Number.isInteger(days) || days < 1 || days > ADMIN_DAYS_MAX) {
    throw new HttpError(400, 'invalid_parameter', `days 는 1~${ADMIN_DAYS_MAX} 사이 정수여야 합니다.`);
  }
  const now = Date.now();
  const from = kstDayStart(recentKstDays(days, now)[0]);
  const fromIso = new Date(from).toISOString();

  // 기간 안에 예약했거나, 기간 안에 끝났거나, 아직 진행 중인 예약 (기간 전에 착석해 기간까지 이어진 이용 포함)
  const [{ results: rows }, { results: rooms }] = await Promise.all([
    ctx.env.DB.prepare(
      `SELECT r.student_id, r.status, r.reserved_at, r.checked_in_at, r.checked_out_at, r.ended_at,
              r.end_reason, r.usage_ends_at, rm.code AS room
         FROM reservations r
         JOIN seats s ON s.id = r.seat_id
         JOIN rooms rm ON rm.id = s.room_id
        WHERE r.reserved_at >= ?1 OR r.ended_at >= ?1 OR r.status IN ('reserved', 'occupied')`,
    ).bind(fromIso).all(),
    ctx.env.DB.prepare(
      `SELECT rm.code, rm.name, COUNT(s.id) AS seats
         FROM rooms rm LEFT JOIN seats s ON s.room_id = rm.id
        GROUP BY rm.id ORDER BY rm.sort_order, rm.code`,
    ).all(),
  ]);
  return json({ stats: computeAdminStats(rows ?? [], rooms ?? [], days, now) });
}
