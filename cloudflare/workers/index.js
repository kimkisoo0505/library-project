/**
 * Cloudflare Workers 진입점
 * - fetch: REST API 및 WebSocket 라우팅
 * - scheduled: Cron 트리거로 만료 예약 정리
 */
import { Router, json, errorResponse } from './router.js';
import { handleStudentLogin, handleAdminLogin, handleLogout, handleMe } from './auth.js';
import { handleListSeats, handleAdminListSeats, handleAdminSetSeatStatus, handleWebSocket } from './seats.js';
import {
  handleCreateReservation,
  handleMyReservation,
  handleCancelReservation,
  handleCheckIn,
  handleCheckOut,
  handleAdminReleaseReservation,
  handleAdminEvents,
  handleDeviceEvent,
  expireStaleReservations,
} from './reservations.js';

import { handleCentralLibrary, handleDeviceCentralLibrary } from './central-library.js';
import { handleDeviceStatus, handleSystemStatus } from './system-status.js';

export { SeatRoom } from './durable-objects/seat-room.js';

const router = new Router()
  .get('/api/health', () => json({ ok: true, service: 'library-seat-api', time: new Date().toISOString() }))

  // 인증 (학생 / 관리자 분리)
  .post('/api/auth/login', handleStudentLogin)
  .post('/api/admin/login', handleAdminLogin)
  .post('/api/auth/logout', handleLogout)
  .get('/api/auth/me', handleMe)

  // 좌석
  .get('/api/seats', handleListSeats)

  // 외부: 경기대 중앙도서관 / 금화도서관 공석 현황 (캐시)
  .get('/api/central-library', handleCentralLibrary)

  // 학생 예약
  .post('/api/reservations', handleCreateReservation)
  .get('/api/reservations/me', handleMyReservation)
  .delete('/api/reservations/:id', handleCancelReservation)
  .post('/api/reservations/:id/check-in', handleCheckIn)
  .post('/api/reservations/:id/check-out', handleCheckOut)

  // 관리자
  .get('/api/admin/seats', handleAdminListSeats)
  .post('/api/admin/seats/:id/status', handleAdminSetSeatStatus)
  .post('/api/admin/reservations/:id/release', handleAdminReleaseReservation)
  .get('/api/admin/events', handleAdminEvents)

  // 라즈베리파이 장치
  .post('/api/device/events', handleDeviceEvent)
  .post('/api/device/central-library', handleDeviceCentralLibrary)
  .post('/api/device/status', handleDeviceStatus)

  // 현장 장치 / 외부 연동 상태 (키오스크 임시 상태 표시줄)
  .get('/api/system-status', handleSystemStatus)

  // 실시간
  .get('/api/ws', handleWebSocket);

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin');
  if (!origin) return {};
  const allowed = String(env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!allowed.includes(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}

function withHeaders(response, headers) {
  if (response.status === 101 || Object.keys(headers).length === 0) return response;
  const copy = new Response(response.body, response);
  for (const [key, value] of Object.entries(headers)) copy.headers.set(key, value);
  return copy;
}

export default {
  async fetch(request, env, ctx) {
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }
    let response;
    try {
      response = await router.handle(request, env, ctx);
    } catch (err) {
      response = errorResponse(err);
    }
    return withHeaders(response, cors);
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(
      expireStaleReservations(env).then((count) => {
        if (count > 0) console.log(JSON.stringify({ log: 'cron_expired', count }));
      }),
    );
  },
};
