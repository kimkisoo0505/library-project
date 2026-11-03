/**
 * 경기대학교 중앙도서관(수원) / 금화도서관(서울) 공석 현황 연동
 *
 * 출처: libgate.kyonggi.ac.kr 공개 조회 API (로그인 불필요, 개인정보 없음)
 *   GET /libraries/lib-status/{캠퍼스}  1 = 수원(중앙도서관), 2 = 서울(금화도서관)
 *
 * 학교 서버 부담을 줄이기 위해:
 *  - 이용자 요청마다 호출하지 않고 D1(external_snapshots)에 저장한 마지막 결과를 응답한다.
 *  - 결과가 FRESH_MS 보다 오래되면 백그라운드(ctx.waitUntil)로 갱신한다 (stale-while-revalidate).
 *  - attempted_at 을 조건부 UPSERT 로 선점해 동시에 여러 요청이 와도 1건만 외부 호출한다.
 *  - 이용자가 없으면 외부 호출도 없다.
 *
 * 외부 응답은 신뢰하지 않는 입력으로 취급한다: 숫자/짧은 문자열만 추출하고 범위를 제한한다.
 */
import { json, nowIso, logEvent } from './router.js';

export const SOURCE = 'kgu-library-status';
const BASE_URL = 'https://libgate.kyonggi.ac.kr';
const USER_AGENT = 'KGU-Reserve-Library/0.1 (+https://library-kiosk.kimkisoo0505.workers.dev)';

export const CAMPUSES = Object.freeze([
  { id: 1, campus: '수원캠퍼스', library: '중앙도서관' },
  { id: 2, campus: '서울캠퍼스', library: '금화도서관' },
]);

const FRESH_MS = 60_000;          // 이보다 오래된 결과는 갱신 시도
const CLAIM_MS = 20_000;          // 갱신 시도 간 최소 간격 (실패 시 재시도 간격 포함)
const STALE_MS = 10 * 60_000;     // 이보다 오래되면 화면에 "오래된 정보"로 표시
const TIMEOUT_MS = 6_000;
const MAX_ROOMS = 50;

// ---------------------------------------------------------------- 정규화

function toCount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.min(Math.floor(n), 100_000) : 0;
}

function toText(value, max = 60) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
}

export function toHours(start, end) {
  const fmt = (t) => {
    const s = String(t ?? '');
    return /^\d{4}$/.test(s) ? `${s.slice(0, 2)}:${s.slice(2)}` : null;
  };
  const a = fmt(start);
  const b = fmt(end);
  return a && b ? `${a}~${b}` : null;
}

/** libgate lib-status 응답의 data 배열 -> 우리 형식 */
export function normalizeCampus(campus, data) {
  if (!Array.isArray(data)) throw new Error('unexpected_payload');
  const rooms = data.slice(0, MAX_ROOMS).map((r) => {
    const total = toCount(r?.cnt);
    const inUse = toCount(r?.inUse);
    const fixed = toCount(r?.fix);
    const unavailable = toCount(r?.unavailable) + toCount(r?.disabled);
    return {
      code: toCount(r?.code),
      name: toText(r?.name) || '이름 없음',
      total,
      available: Math.min(toCount(r?.available), total),
      in_use: Math.min(inUse, total),
      fixed,
      unavailable,
      hours: toHours(r?.startTm, r?.endTm),
    };
  });
  return {
    id: campus.id,
    campus: campus.campus,
    library: campus.library,
    total: rooms.reduce((sum, r) => sum + r.total, 0),
    available: rooms.reduce((sum, r) => sum + r.available, 0),
    rooms,
  };
}

async function fetchCampus(campus, fetchImpl = fetch) {
  const response = await fetchImpl(`${BASE_URL}/libraries/lib-status/${campus.id}`, {
    headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`http_${response.status}`);
  const body = await response.json();
  if (body?.code !== 1) throw new Error('api_error');
  return normalizeCampus(campus, body.data);
}

/**
 * 두 캠퍼스를 조회한다. 한쪽만 실패하면 그 캠퍼스는 이전 결과를 유지한다.
 * @returns {{ campuses: object[], errors: string[] }}
 */
export async function fetchAllCampuses(previous, fetchImpl = fetch) {
  const results = await Promise.allSettled(CAMPUSES.map((c) => fetchCampus(c, fetchImpl)));
  const prevById = new Map((previous?.campuses ?? []).map((c) => [c.id, c]));
  const campuses = [];
  const errors = [];
  results.forEach((result, i) => {
    const campus = CAMPUSES[i];
    if (result.status === 'fulfilled') {
      campuses.push({ ...result.value, fetched_at: nowIso() });
    } else {
      errors.push(`${campus.library}: ${String(result.reason?.message ?? result.reason).slice(0, 80)}`);
      if (prevById.has(campus.id)) campuses.push(prevById.get(campus.id));
    }
  });
  return { campuses, errors };
}

// ---------------------------------------------------------------- 저장 / 갱신

async function readSnapshot(env) {
  return env.DB.prepare(
    'SELECT payload, fetched_at, attempted_at, last_error FROM external_snapshots WHERE source = ?1',
  ).bind(SOURCE).first();
}

/** 갱신 권한 선점: 마지막 시도가 CLAIM_MS 이전일 때만 성공 (원자적) */
async function claimRefresh(env) {
  const now = new Date();
  const row = await env.DB.prepare(
    `INSERT INTO external_snapshots (source, attempted_at) VALUES (?1, ?2)
     ON CONFLICT (source) DO UPDATE SET attempted_at = excluded.attempted_at
      WHERE external_snapshots.attempted_at <= ?3
     RETURNING source`,
  ).bind(SOURCE, nowIso(now), nowIso(new Date(now.getTime() - CLAIM_MS))).first();
  return Boolean(row);
}

export async function refreshSnapshot(env, snapshot) {
  if (!(await claimRefresh(env))) return false;
  const previous = snapshot?.payload ? safeParse(snapshot.payload) : null;
  let campuses = [];
  let errors = [];
  try {
    ({ campuses, errors } = await fetchAllCampuses(previous));
  } catch (err) {
    errors = [String(err?.message ?? err).slice(0, 120)];
  }
  const lastError = errors.length ? errors.join(' / ') : null;
  const anyFresh = campuses.some((c) => c.fetched_at && Date.now() - Date.parse(c.fetched_at) < CLAIM_MS);

  if (anyFresh) {
    await env.DB.prepare(
      'UPDATE external_snapshots SET payload = ?2, fetched_at = ?3, last_error = ?4 WHERE source = ?1',
    ).bind(SOURCE, JSON.stringify({ campuses }), nowIso(), lastError).run();
  } else {
    await env.DB.prepare('UPDATE external_snapshots SET last_error = ?2 WHERE source = ?1')
      .bind(SOURCE, lastError).run();
  }

  // 상태가 바뀔 때만 이벤트 기록 (실패가 계속되어도 로그가 넘치지 않도록)
  const wasFailing = Boolean(snapshot?.last_error);
  if (lastError && !wasFailing) {
    await logEvent(env, { source: 'system', eventType: 'external.central_library_failed', actorType: 'system', payload: { error: lastError } });
  } else if (!lastError && wasFailing) {
    await logEvent(env, { source: 'system', eventType: 'external.central_library_recovered', actorType: 'system' });
  }
  return true;
}

function safeParse(text) {
  try { return JSON.parse(text); } catch { return null; }
}

// ---------------------------------------------------------------- API

/** GET /api/central-library */
export async function handleCentralLibrary({ env, ctx }) {
  let snapshot = await readSnapshot(env);
  const age = snapshot?.fetched_at ? Date.now() - Date.parse(snapshot.fetched_at) : Infinity;

  if (age > FRESH_MS) {
    if (!snapshot?.payload) {
      // 저장된 결과가 전혀 없으면 이번 요청에서 기다렸다가 응답
      await refreshSnapshot(env, snapshot);
      snapshot = await readSnapshot(env);
    } else {
      ctx.waitUntil(refreshSnapshot(env, snapshot).catch((err) => console.error('central_library_refresh_failed', err)));
    }
  }

  const payload = snapshot?.payload ? safeParse(snapshot.payload) : null;
  const fetchedAt = snapshot?.fetched_at ?? null;
  const currentAge = fetchedAt ? Date.now() - Date.parse(fetchedAt) : Infinity;
  return json(
    {
      source: '경기대학교 도서관 (libgate.kyonggi.ac.kr)',
      available: Boolean(payload?.campuses?.length),
      fetched_at: fetchedAt,
      stale: currentAge > STALE_MS,
      degraded: Boolean(snapshot?.last_error),   // 최근 조회 일부/전부 실패 (상세 사유는 관리자 이벤트 로그)
      campuses: payload?.campuses ?? [],
    },
    200,
    { 'Cache-Control': 'public, max-age=30' },
  );
}
