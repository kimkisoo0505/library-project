/**
 * 좌석 변경 알림 WebSocket 클라이언트 (자동 재연결).
 * 서버 알림에는 개인정보가 없으며, 알림을 받으면 REST로 좌석 목록을 다시 조회한다.
 */
function defaultUrl() {
  const explicit = import.meta.env.VITE_WS_URL;
  if (explicit) return explicit;
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${location.host}/api/ws`;
}

export class SeatSocket {
  #ws = null;
  #retry = 0;
  #reconnectTimer = null;
  #pingTimer = null;
  #closedByUser = false;

  constructor({ url = defaultUrl(), onMessage = () => {}, onStatusChange = () => {} } = {}) {
    this.url = url;
    this.onMessage = onMessage;
    this.onStatusChange = onStatusChange;
  }

  connect() {
    this.#closedByUser = false;
    this.#open();
  }

  #open() {
    try {
      this.#ws = new WebSocket(this.url);
    } catch {
      this.#scheduleReconnect();
      return;
    }

    this.#ws.addEventListener('open', () => {
      this.#retry = 0;
      this.onStatusChange(true);
      this.#pingTimer = setInterval(() => this.send({ type: 'ping' }), 25_000);
    });

    this.#ws.addEventListener('message', (event) => {
      try {
        this.onMessage(JSON.parse(event.data));
      } catch {
        // 형식이 잘못된 메시지는 무시
      }
    });

    this.#ws.addEventListener('close', () => {
      clearInterval(this.#pingTimer);
      this.onStatusChange(false);
      if (!this.#closedByUser) this.#scheduleReconnect();
    });
  }

  #scheduleReconnect() {
    clearTimeout(this.#reconnectTimer);
    const delay = Math.min(30_000, 1000 * 2 ** this.#retry) + Math.random() * 500;
    this.#retry += 1;
    this.#reconnectTimer = setTimeout(() => this.#open(), delay);
  }

  send(message) {
    if (this.#ws?.readyState === WebSocket.OPEN) this.#ws.send(JSON.stringify(message));
  }

  close() {
    this.#closedByUser = true;
    clearTimeout(this.#reconnectTimer);
    clearInterval(this.#pingTimer);
    this.#ws?.close(1000, 'client closing');
  }
}
