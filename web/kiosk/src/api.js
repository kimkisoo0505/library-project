/**
 * Workers REST API 클라이언트.
 * - 학생/관리자 세션 토큰을 분리 보관 (sessionStorage, 실패 시 메모리)
 * - 응답 성공 전에는 어떤 상태 변경도 성공으로 간주하지 않는다.
 */
const API_BASE = (import.meta.env.VITE_API_BASE || '/api').replace(/\/+$/, '');

const TOKEN_KEYS = { student: 'library.session.student', admin: 'library.session.admin' };
const memoryStore = new Map();

export const session = {
  get(type) {
    const key = TOKEN_KEYS[type];
    try {
      return sessionStorage.getItem(key) ?? memoryStore.get(key) ?? null;
    } catch {
      return memoryStore.get(key) ?? null;
    }
  },
  set(type, token) {
    const key = TOKEN_KEYS[type];
    memoryStore.set(key, token);
    try { sessionStorage.setItem(key, token); } catch { /* 메모리만 사용 */ }
  },
  clear(type) {
    const key = TOKEN_KEYS[type];
    memoryStore.delete(key);
    try { sessionStorage.removeItem(key); } catch { /* 무시 */ }
  },
};

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function request(path, { method = 'GET', body, auth = null, timeoutMs = 10_000 } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (auth) {
    const token = session.get(auth);
    if (!token) throw new ApiError(401, 'unauthenticated', '로그인이 필요합니다.');
    headers.Authorization = `Bearer ${token}`;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch {
    throw new ApiError(0, 'network_error', '서버에 연결할 수 없습니다. 요청이 처리되었는지 좌석 현황을 다시 확인하세요.');
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = null; }
  }
  if (!response.ok) {
    throw new ApiError(
      response.status,
      data?.error?.code ?? 'http_error',
      data?.error?.message ?? `요청이 실패했습니다. (${response.status})`,
    );
  }
  return data;
}

export const api = {
  health: () => request('/health'),

  studentLogin: (studentNo, password) =>
    request('/auth/login', { method: 'POST', body: { student_no: studentNo, password } }),
  adminLogin: (username, password) =>
    request('/admin/login', { method: 'POST', body: { username, password } }),
  logout: (type) => request('/auth/logout', { method: 'POST', auth: type }),
  me: (type) => request('/auth/me', { auth: type }),

  listSeats: () => request('/seats', { auth: session.get('student') ? 'student' : null }),
  centralLibrary: () => request('/central-library'),
  myReservation: () => request('/reservations/me', { auth: 'student' }),
  createReservation: (seatId) => request('/reservations', { method: 'POST', auth: 'student', body: { seat_id: seatId } }),
  cancelReservation: (id) => request(`/reservations/${encodeURIComponent(id)}`, { method: 'DELETE', auth: 'student' }),
  checkIn: (id) => request(`/reservations/${encodeURIComponent(id)}/check-in`, { method: 'POST', auth: 'student' }),
  checkOut: (id) => request(`/reservations/${encodeURIComponent(id)}/check-out`, { method: 'POST', auth: 'student' }),

  adminListSeats: () => request('/admin/seats', { auth: 'admin' }),
  adminSetSeatStatus: (seatId, status, reason = '') =>
    request(`/admin/seats/${encodeURIComponent(seatId)}/status`, { method: 'POST', auth: 'admin', body: { status, reason } }),
  adminReleaseReservation: (id, reason) =>
    request(`/admin/reservations/${encodeURIComponent(id)}/release`, { method: 'POST', auth: 'admin', body: { reason } }),
  adminEvents: (limit = 50) => request(`/admin/events?limit=${encodeURIComponent(limit)}`, { auth: 'admin' }),
};
