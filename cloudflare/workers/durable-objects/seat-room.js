/**
 * SeatRoom Durable Object
 *
 * 열람실 하나당 하나의 인스턴스(이름: reading-room-1)가 WebSocket 연결을 보관하고
 * 좌석 변경 알림을 모든 클라이언트(키오스크, 관리자, 라즈베리파이)에 전달한다.
 *
 * - WebSocket Hibernation API(state.acceptWebSocket)를 사용해 유휴 시 비용을 줄인다.
 * - 이 객체는 좌석 상태의 "기준"이 아니다. 기준은 항상 D1이며, 여기서는 알림만 중계한다.
 * - 클라이언트가 WebSocket으로 상태를 변경할 수 없다 (ping 외 메시지는 무시).
 */
const MAX_MESSAGE_BYTES = 1024;
const ALLOWED_ROLES = new Set(['viewer', 'device']);

export class SeatRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/broadcast' && request.method === 'POST') {
      const message = await request.text();
      this.#broadcast(message);
      return new Response(null, { status: 204 });
    }

    // 장치 전용 명령 (예: 원격 종료). 일반 화면(viewer)에는 보내지 않는다.
    if (url.pathname === '/command' && request.method === 'POST') {
      const message = await request.text();
      let delivered = 0;
      for (const ws of this.state.getWebSockets('device')) {
        try {
          ws.send(message);
          delivered += 1;
        } catch (err) {
          console.warn('seat_room_command_send_failed', err);
        }
      }
      return new Response(JSON.stringify({ delivered }), { headers: { 'Content-Type': 'application/json' } });
    }

    if (url.pathname === '/connect') {
      if ((request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') {
        return new Response('Expected WebSocket upgrade', { status: 426 });
      }
      const requestedRole = request.headers.get('X-Client-Role') || 'viewer';
      const role = ALLOWED_ROLES.has(requestedRole) ? requestedRole : 'viewer';

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.state.acceptWebSocket(server, [role]);
      server.send(JSON.stringify({ type: 'hello', role, at: new Date().toISOString() }));
      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response('Not found', { status: 404 });
  }

  #broadcast(message) {
    for (const ws of this.state.getWebSockets()) {
      try {
        ws.send(message);
      } catch (err) {
        console.warn('seat_room_send_failed', err);
      }
    }
  }

  async webSocketMessage(ws, message) {
    if (typeof message !== 'string' || message.length > MAX_MESSAGE_BYTES) return;
    let data;
    try {
      data = JSON.parse(message);
    } catch {
      return;
    }
    if (data?.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong', at: new Date().toISOString() }));
    }
  }

  async webSocketClose(ws, code, reason) {
    try {
      ws.close(code, reason);
    } catch {
      // 이미 닫힌 연결
    }
  }

  async webSocketError(ws, error) {
    console.warn('seat_room_ws_error', error);
  }
}
