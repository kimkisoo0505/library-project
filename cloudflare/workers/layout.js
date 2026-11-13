/**
 * 열람실 좌석 배치 (관리자 드래그 편집)
 *
 * 배치 형식 (API · DB 공통):
 *   {
 *     rows: 3~15, cols: 3~15,
 *     seats:    [{ seat_no, row, col }]            // 열람실의 모든 좌석이 정확히 한 번씩, 1칸 차지
 *     fixtures: [{ type, row, col, w, h }]         // 출입구(door) · 칠판/교탁(board) · 창가(window), 최대 12개
 *   }
 * row/col 은 0부터. 좌석과 표시 블록은 서로 겹칠 수 없다.
 * 좌석 수·번호는 바꾸지 않는다 (위치만). DB 에는 rooms.layout(JSON, NULL = 기본 배치)으로 저장한다.
 */
import { HttpError, json, readJson, logEvent } from './router.js';
import { requireAdmin } from './auth.js';
import { broadcastSeatChange } from './seats.js';

export const GRID_MIN = 3;
export const GRID_MAX = 15;
export const FIXTURES_MAX = 12;
export const FIXTURE_TYPES = Object.freeze(['door', 'board', 'window']);

function invalid(message) {
  return new HttpError(400, 'invalid_layout', message);
}

function intIn(value, min, max, name) {
  if (!Number.isInteger(value) || value < min || value > max) throw invalid(`${name} 값이 올바르지 않습니다. (${min}~${max})`);
  return value;
}

/**
 * 기본 배치: 앞줄에 출입구 · 칠판/교탁, 좌석은 3석 + 통로 + 3석, 오른쪽 끝 세로로 창가.
 * (기존 고정 배치도와 같은 모양)
 */
export function defaultLayout(seatNos) {
  const nos = [...seatNos].sort((a, b) => a - b);
  const perRow = 6;
  const rows = Math.min(GRID_MAX, 1 + Math.max(1, Math.ceil(nos.length / perRow)));
  const cols = 8;
  const seats = nos.map((seatNo, i) => {
    const c = i % perRow;
    return { seat_no: seatNo, row: 1 + Math.floor(i / perRow), col: c < 3 ? c : c + 1 };
  });
  return {
    rows,
    cols,
    seats,
    fixtures: [
      { type: 'door', row: 0, col: 0, w: 1, h: 1 },
      { type: 'board', row: 0, col: 1, w: 5, h: 1 },
      { type: 'window', row: 1, col: 7, w: 1, h: rows - 1 },
    ],
  };
}

/**
 * 입력 배치 검증 및 정규화. 잘못되면 HttpError(400, invalid_layout).
 * @param {unknown} input
 * @param {number[]} seatNos 이 열람실의 좌석 번호 전체
 */
export function parseLayout(input, seatNos) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('배치 형식이 올바르지 않습니다.');
  const rows = intIn(input.rows, GRID_MIN, GRID_MAX, '줄 수');
  const cols = intIn(input.cols, GRID_MIN, GRID_MAX, '칸 수');
  if (!Array.isArray(input.seats) || !Array.isArray(input.fixtures ?? [])) throw invalid('배치 형식이 올바르지 않습니다.');

  const occupied = new Map(); // "r,c" -> 이름
  const take = (r, c, name) => {
    const key = `${r},${c}`;
    if (occupied.has(key)) throw new HttpError(400, 'layout_overlap', `${occupied.get(key)}와(과) ${name}이(가) 같은 칸에 있습니다.`);
    occupied.set(key, name);
  };

  const expected = new Set(seatNos);
  const seen = new Set();
  const seats = input.seats.map((s) => {
    if (!s || typeof s !== 'object') throw invalid('좌석 위치 형식이 올바르지 않습니다.');
    const seatNo = s.seat_no;
    if (!expected.has(seatNo)) throw invalid(`이 열람실에 없는 좌석 번호입니다: ${String(seatNo).slice(0, 10)}`);
    if (seen.has(seatNo)) throw invalid(`좌석 ${seatNo}번이 두 번 들어 있습니다.`);
    seen.add(seatNo);
    const row = intIn(s.row, 0, rows - 1, `좌석 ${seatNo}번 줄`);
    const col = intIn(s.col, 0, cols - 1, `좌석 ${seatNo}번 칸`);
    take(row, col, `좌석 ${seatNo}번`);
    return { seat_no: seatNo, row, col };
  });
  if (seen.size !== expected.size) throw invalid('모든 좌석의 위치가 있어야 합니다.');

  const rawFixtures = input.fixtures ?? [];
  if (rawFixtures.length > FIXTURES_MAX) throw invalid(`표시 블록은 ${FIXTURES_MAX}개까지입니다.`);
  const fixtures = rawFixtures.map((f, i) => {
    if (!f || typeof f !== 'object' || !FIXTURE_TYPES.includes(f.type)) throw invalid('표시 블록 종류가 올바르지 않습니다.');
    const row = intIn(f.row, 0, rows - 1, '표시 블록 줄');
    const col = intIn(f.col, 0, cols - 1, '표시 블록 칸');
    const w = intIn(f.w, 1, cols - col, '표시 블록 가로 크기');
    const h = intIn(f.h, 1, rows - row, '표시 블록 세로 크기');
    for (let r = row; r < row + h; r += 1) {
      for (let c = col; c < col + w; c += 1) take(r, c, `표시 블록 ${i + 1}`);
    }
    return { type: f.type, row, col, w, h };
  });

  seats.sort((a, b) => a.seat_no - b.seat_no);
  return { rows, cols, seats, fixtures };
}

/** DB 값 → 화면용 배치. 저장값이 없거나 좌석 구성이 바뀌어 맞지 않으면 기본 배치. */
export function resolveLayout(stored, seatNos) {
  if (stored) {
    try {
      return { ...parseLayout(JSON.parse(stored), seatNos), custom: true };
    } catch (err) {
      console.error('layout_invalid_stored', String(err?.message ?? err).slice(0, 120));
    }
  }
  return { ...defaultLayout(seatNos), custom: false };
}

/**
 * POST /api/admin/rooms/:code/layout
 * body: { "version": <편집 시작 시 layout_version>, "layout": {...} | null }   (null = 기본 배치로)
 */
export async function handleAdminSetRoomLayout(ctx) {
  const admin = await requireAdmin(ctx);
  const code = String(ctx.params.code ?? '').toUpperCase();
  if (!/^[A-Z]$/.test(code)) throw new HttpError(400, 'invalid_parameter', '열람실 코드가 올바르지 않습니다.');
  const body = await readJson(ctx.request);
  if (!Number.isInteger(body.version) || body.version < 0) throw new HttpError(400, 'invalid_parameter', 'version이 필요합니다.');

  const { results } = await ctx.env.DB.prepare(
    'SELECT s.seat_no FROM seats s JOIN rooms rm ON rm.id = s.room_id WHERE rm.code = ?1 ORDER BY s.seat_no',
  ).bind(code).all();
  if (results.length === 0) throw new HttpError(404, 'room_not_found', '존재하지 않는 열람실입니다.');
  const seatNos = results.map((r) => r.seat_no);

  const reset = body.layout === null;
  const stored = reset ? null : JSON.stringify(parseLayout(body.layout, seatNos));

  // 편집을 시작한 버전과 같을 때만 저장 (조건부 UPDATE, 동시 편집 덮어쓰기 방지)
  const updated = await ctx.env.DB.prepare(
    `UPDATE rooms SET layout = ?1, layout_version = layout_version + 1
      WHERE code = ?2 AND layout_version = ?3
      RETURNING layout, layout_version`,
  ).bind(stored, code, body.version).first();
  if (!updated) {
    throw new HttpError(409, 'layout_conflict', '다른 관리자가 먼저 배치를 바꿨습니다. 편집을 취소한 뒤 다시 편집하세요.');
  }

  await logEvent(ctx.env, {
    source: 'admin',
    eventType: 'room.layout_changed',
    actorType: 'admin',
    actorId: admin.subjectId,
    payload: { room: code, reset, version: updated.layout_version },
  });
  await broadcastSeatChange(ctx.env, null, 'room.layout_changed');
  return json({ room: code, layout: resolveLayout(updated.layout, seatNos), layout_version: updated.layout_version });
}
