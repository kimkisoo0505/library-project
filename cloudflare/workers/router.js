/**
 * 경량 라우터와 공통 HTTP/로그 유틸리티.
 * 외부 의존성 없이 Cloudflare Workers 런타임에서 동작한다.
 */

export class HttpError extends Error {
  /**
   * @param {number} status HTTP 상태 코드
   * @param {string} code   기계가 읽는 오류 코드
   * @param {string} message 사용자에게 보여줄 메시지
   * @param {object} [details]
   */
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers,
    },
  });
}

export function errorResponse(err) {
  if (err instanceof HttpError) {
    const body = { error: { code: err.code, message: err.message } };
    if (err.details) body.error.details = err.details;
    return json(body, err.status);
  }
  console.error('unhandled_error', err);
  return json({ error: { code: 'internal_error', message: '서버 내부 오류가 발생했습니다.' } }, 500);
}

/** JSON 본문을 읽고 객체인지 검증한다. */
export async function readJson(request, maxBytes = 16 * 1024) {
  const length = Number(request.headers.get('Content-Length') || 0);
  if (length > maxBytes) {
    throw new HttpError(413, 'payload_too_large', '요청 본문이 너무 큽니다.');
  }
  const contentType = request.headers.get('Content-Type') || '';
  if (!contentType.toLowerCase().includes('application/json')) {
    throw new HttpError(415, 'unsupported_media_type', 'Content-Type은 application/json이어야 합니다.');
  }
  let data;
  try {
    data = await request.json();
  } catch {
    throw new HttpError(400, 'invalid_json', 'JSON 본문 형식이 올바르지 않습니다.');
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new HttpError(400, 'invalid_json', 'JSON 객체가 필요합니다.');
  }
  return data;
}

export function nowIso(date = new Date()) {
  return date.toISOString();
}

export function parsePositiveInt(value, name = 'id') {
  const n = typeof value === 'number' ? value : Number(String(value ?? ''));
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new HttpError(400, 'invalid_parameter', `${name} 값이 올바르지 않습니다.`);
  }
  return n;
}

/**
 * events 테이블에 이벤트를 기록한다.
 * 로그 실패가 본 요청을 실패시키지 않도록 예외를 삼키고 콘솔(Workers Logs)에 남긴다.
 * payload에 비밀번호/토큰을 넣지 말 것.
 */
export async function logEvent(env, {
  source,
  eventType,
  actorType = null,
  actorId = null,
  seatId = null,
  reservationId = null,
  payload = null,
}) {
  const occurredAt = nowIso();
  console.log(JSON.stringify({ log: 'event', occurredAt, source, eventType, actorType, actorId, seatId, reservationId }));
  try {
    await env.DB.prepare(
      `INSERT INTO events (occurred_at, source, event_type, actor_type, actor_id, seat_id, reservation_id, payload)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    )
      .bind(
        occurredAt,
        source,
        eventType,
        actorType,
        actorId == null ? null : String(actorId),
        seatId,
        reservationId,
        payload == null ? null : JSON.stringify(payload),
      )
      .run();
  } catch (err) {
    console.error('event_log_failed', eventType, err);
  }
}

/**
 * 경로 패턴(`/api/reservations/:id`)을 정규식으로 변환해 매칭하는 라우터.
 * 핸들러는 { request, env, ctx, url, params } 를 받아 Response를 반환한다.
 */
export class Router {
  #routes = [];

  on(method, pattern, handler) {
    const keys = [];
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    const source = escaped.replace(/:(\w+)/g, (_, key) => {
      keys.push(key);
      return '([^/]+)';
    });
    this.#routes.push({ method: method.toUpperCase(), regex: new RegExp(`^${source}/?$`), keys, handler });
    return this;
  }

  get(pattern, handler) { return this.on('GET', pattern, handler); }
  post(pattern, handler) { return this.on('POST', pattern, handler); }
  delete(pattern, handler) { return this.on('DELETE', pattern, handler); }

  async handle(request, env, ctx) {
    const url = new URL(request.url);
    let pathMatched = false;

    for (const route of this.#routes) {
      const match = route.regex.exec(url.pathname);
      if (!match) continue;
      pathMatched = true;
      if (route.method !== request.method) continue;

      const params = {};
      try {
        route.keys.forEach((key, i) => { params[key] = decodeURIComponent(match[i + 1]); });
      } catch {
        throw new HttpError(400, 'invalid_path', '경로 형식이 올바르지 않습니다.');
      }
      return route.handler({ request, env, ctx, url, params });
    }

    if (pathMatched) throw new HttpError(405, 'method_not_allowed', '허용되지 않은 메서드입니다.');
    throw new HttpError(404, 'not_found', '요청한 경로를 찾을 수 없습니다.');
  }
}
