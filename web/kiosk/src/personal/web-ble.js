/**
 * 모바일 웹 블루투스 재실 확인 (Web Bluetooth) — 앱 없이 브라우저만으로 자동 연장.
 *
 * 앱(mobile-app)과 같은 Pi GATT 규격(docs/BLE_GATT_SPEC.md)을 쓴다:
 *   서비스 27fb1000-…, Command(쓰기) 27fb1001-…, Response(알림) 27fb1002-…, 명령 `PING,<seq>` → `PONG,<seq>`
 *
 * 앱과 다른 점 (브라우저 제약):
 *  - Web Bluetooth 는 신호 세기(RSSI)를 주지 않는다. 그래서 "열람실 장치(LIB-SEAT-PI)와 연결되어 있고
 *    PING 에 계속 응답이 온다" = 블루투스 거리 안에 있다 로 판단한다 (앱의 신호 세기 기준보다 덜 정밀).
 *  - 처음 연결은 반드시 사용자가 버튼을 눌러 기기 선택 창에서 고른다 (브라우저 보안 규칙).
 *    이미 허락한 기기는 끊겨도 자동으로 다시 연결하고, 지원하는 브라우저에선 새로고침 후에도 다시 연결한다.
 *  - 화면이 꺼지거나 다른 앱으로 가면 브라우저가 멈춰 확인이 끊길 수 있다 (앱과 같은 "화면 켜 둔 동안" 동작).
 *  - Android 의 Chrome·Edge·삼성 인터넷 등에서 동작. iPhone(Safari)·Firefox 는 Web Bluetooth 를 지원하지 않는다.
 *
 * 블루투스로는 학번·토큰 등 개인정보를 보내지 않는다. 연장 요청은 웹이 자기 학생 세션으로 서버에 보낸다.
 * 이 모듈은 브라우저 API 와 시계를 주입받을 수 있어 Pi 없이 테스트할 수 있다 (tests/web-ble.test.mjs).
 */
export const BLE_SERVICE = '27fb1000-18b4-466c-94a3-08bcf22ef878';
export const BLE_COMMAND = '27fb1001-18b4-466c-94a3-08bcf22ef878';
export const BLE_RESPONSE = '27fb1002-18b4-466c-94a3-08bcf22ef878';
export const BLE_DEVICE_NAME = 'LIB-SEAT-PI';

export const PING_INTERVAL_MS = 10_000;  // 10초마다 PING
export const PONG_TIMEOUT_MS = 3_000;    // 3초 안에 PONG 이 없으면 놓친 것으로
export const FRESH_MS = 25_000;          // 마지막 PONG 이 25초 이내면 "자리에 있음"
export const MISSES_BEFORE_RECONNECT = 2;
export const RECONNECT_DELAYS_MS = Object.freeze([2_000, 4_000, 8_000, 16_000, 30_000]);
export const MAX_RECONNECT_ATTEMPTS = 10;

/** 'ok' | 'no-api' (지원 안 하는 브라우저) | 'insecure' (https 아님) */
export function webBleSupport(nav = globalThis.navigator, secure = globalThis.isSecureContext) {
  if (!secure) return 'insecure';
  if (!nav?.bluetooth || typeof nav.bluetooth.requestDevice !== 'function') return 'no-api';
  return 'ok';
}

/** Pi 응답 한 줄 해석: `PONG,12` → { type: 'PONG', seq: 12 } */
export function parseResponse(text) {
  const parts = String(text ?? '').trim().split(',');
  const seq = Number(parts[1]);
  return { type: parts[0] ?? '', seq: Number.isInteger(seq) ? seq : null };
}

/**
 * @param {{
 *   bluetooth?: Bluetooth,
 *   onChange: (state: { status: string, piConnected: boolean, inRange: boolean, rssi: null, threshold: null, reason: string }) => void,
 *   now?: () => number,
 *   timers?: { setTimeout: Function, clearTimeout: Function, setInterval: Function, clearInterval: Function },
 * }} options
 */
export function createWebBlePresence({ bluetooth = globalThis.navigator?.bluetooth, onChange, now = Date.now, timers = globalThis } = {}) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  /** idle | choosing | connecting | connected | reconnecting | failed */
  let status = 'idle';
  let reason = '';
  let device = null;
  let command = null;
  let response = null;
  let lastPongAt = 0;
  let misses = 0;
  let seq = 0;
  let pingTimer = null;
  let reconnectTimer = null;
  let reconnectAttempts = 0;
  let generation = 0; // stop()/새 연결 이후 늦게 도착한 콜백을 무시하기 위한 번호
  const pending = new Map(); // seq -> timeout

  const inRange = () => status === 'connected' && lastPongAt > 0 && now() - lastPongAt < FRESH_MS;

  function snapshot() {
    return {
      status,
      piConnected: status === 'connected',
      inRange: inRange(),
      rssi: null,      // Web Bluetooth 는 신호 세기를 제공하지 않음
      threshold: null,
      reason,
    };
  }

  function emit() {
    try { onChange?.(snapshot()); } catch { /* 화면 갱신 오류가 연결을 멈추게 하지 않는다 */ }
  }

  function setStatus(next, nextReason = '') {
    status = next;
    reason = nextReason;
    emit();
  }

  function clearPending() {
    for (const t of pending.values()) timers.clearTimeout(t);
    pending.clear();
  }

  function stopLoops() {
    if (pingTimer) timers.clearInterval(pingTimer);
    pingTimer = null;
    if (reconnectTimer) timers.clearTimeout(reconnectTimer);
    reconnectTimer = null;
    clearPending();
  }

  function onNotify(event) {
    const value = event?.target?.value;
    let text = '';
    try {
      text = decoder.decode(value instanceof DataView ? value : new Uint8Array(value?.buffer ?? []));
    } catch { return; }
    const msg = parseResponse(text);
    if (msg.type !== 'PONG' || msg.seq == null || !pending.has(msg.seq)) return;
    timers.clearTimeout(pending.get(msg.seq));
    pending.delete(msg.seq);
    lastPongAt = now();
    misses = 0;
    emit();
  }

  async function ping() {
    if (status !== 'connected' || !command) return;
    seq = (seq % 999) + 1;
    const mySeq = seq;
    const myGen = generation;
    pending.set(mySeq, timers.setTimeout(() => {
      pending.delete(mySeq);
      if (myGen !== generation || status !== 'connected') return;
      misses += 1;
      emit(); // 응답이 늦어지면 "자리 확인" 표시가 꺼질 수 있다
      if (misses >= MISSES_BEFORE_RECONNECT) {
        // 연결은 살아 있는데 응답이 없음 → 끊고 다시 연결
        misses = 0;
        try { device?.gatt?.disconnect(); } catch { /* 이미 끊김 */ }
      }
    }, PONG_TIMEOUT_MS));
    try {
      const bytes = encoder.encode(`PING,${mySeq}`);
      if (typeof command.writeValueWithResponse === 'function') await command.writeValueWithResponse(bytes);
      else await command.writeValue(bytes);
    } catch {
      // 쓰기 실패는 위 타임아웃이 놓친 것으로 처리한다
    }
  }

  function onDisconnected() {
    if (status === 'idle' || status === 'failed') return;
    stopLoops();
    command = null;
    response = null;
    scheduleReconnect();
  }

  function scheduleReconnect() {
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      setStatus('failed', '열람실 장치와 연결이 끊겼어요. 다시 눌러 연결하세요.');
      return;
    }
    const delay = RECONNECT_DELAYS_MS[Math.min(reconnectAttempts, RECONNECT_DELAYS_MS.length - 1)];
    reconnectAttempts += 1;
    setStatus('reconnecting', `연결이 끊겨 다시 연결하는 중 (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
    const myGen = generation;
    reconnectTimer = timers.setTimeout(async () => {
      reconnectTimer = null;
      if (myGen !== generation) return;
      const ok = await connectGatt(myGen);
      if (!ok && myGen === generation && status !== 'idle') scheduleReconnect();
    }, delay);
  }

  /** 이미 고른 기기에 GATT 연결 + 알림 구독 + PING 시작. 사용자 동작 없이도 가능 */
  async function connectGatt(myGen) {
    try {
      const server = await device.gatt.connect();
      const service = await server.getPrimaryService(BLE_SERVICE);
      const cmd = await service.getCharacteristic(BLE_COMMAND);
      const resp = await service.getCharacteristic(BLE_RESPONSE);
      if (myGen !== generation) { try { device.gatt.disconnect(); } catch { /* 무시 */ } return false; }
      await resp.startNotifications();
      resp.addEventListener('characteristicvaluechanged', onNotify);
      command = cmd;
      response = resp;
      reconnectAttempts = 0;
      misses = 0;
      lastPongAt = 0;
      setStatus('connected');
      pingTimer = timers.setInterval(ping, PING_INTERVAL_MS);
      ping();
      return true;
    } catch (err) {
      if (myGen === generation) reason = `연결 실패: ${String(err?.message ?? err).slice(0, 60)}`;
      return false;
    }
  }

  function attach(nextDevice) {
    if (device && device !== nextDevice) {
      try { device.removeEventListener('gattserverdisconnected', onDisconnected); } catch { /* 무시 */ }
    }
    device = nextDevice;
    device.addEventListener('gattserverdisconnected', onDisconnected);
  }

  async function firstConnect(myGen) {
    setStatus('connecting');
    const ok = await connectGatt(myGen);
    if (!ok && myGen === generation) setStatus('failed', reason || '열람실 장치에 연결하지 못했어요. 열람실 안에서 다시 눌러 주세요.');
    return ok;
  }

  return {
    /** 버튼을 눌렀을 때 (사용자 동작 안에서 호출해야 기기 선택 창이 뜬다) */
    async start() {
      if (!bluetooth) { setStatus('failed', '이 브라우저는 블루투스를 지원하지 않아요.'); return false; }
      if (status === 'choosing' || status === 'connecting' || status === 'connected') return status === 'connected';
      generation += 1;
      const myGen = generation;
      stopLoops();
      reconnectAttempts = 0;
      setStatus('choosing');
      let chosen;
      try {
        chosen = await bluetooth.requestDevice({
          filters: [{ services: [BLE_SERVICE] }, { name: BLE_DEVICE_NAME }],
          optionalServices: [BLE_SERVICE],
        });
      } catch (err) {
        if (myGen !== generation) return false;
        const cancelled = err?.name === 'NotFoundError';
        setStatus(cancelled ? 'idle' : 'failed', cancelled ? '' : `블루투스를 사용할 수 없어요: ${String(err?.message ?? err).slice(0, 60)}`);
        return false;
      }
      if (myGen !== generation) return false;
      attach(chosen);
      return firstConnect(myGen);
    },

    /** 새로고침 후: 이미 허락한 기기가 있으면 선택 창 없이 다시 연결 (getDevices 지원 브라우저만) */
    async resume() {
      if (!bluetooth || typeof bluetooth.getDevices !== 'function' || status !== 'idle') return false;
      let devices = [];
      try { devices = await bluetooth.getDevices(); } catch { return false; }
      const known = devices.find((d) => d?.name === BLE_DEVICE_NAME) ?? null;
      if (!known || status !== 'idle') return false;
      generation += 1;
      const myGen = generation;
      attach(known);
      const ok = await firstConnect(myGen);
      if (!ok && myGen === generation) setStatus('idle'); // 조용히 실패 → 버튼으로 다시
      return ok;
    },

    /** 화면으로 돌아왔을 때 등: 바로 한 번 확인 */
    pingNow() { if (status === 'connected') ping(); },

    /** 퇴실·로그아웃·열람실 A 가 아님: 연결을 끊고 멈춘다 */
    stop() {
      generation += 1;
      stopLoops();
      if (response) {
        try { response.removeEventListener('characteristicvaluechanged', onNotify); } catch { /* 무시 */ }
      }
      command = null;
      response = null;
      lastPongAt = 0;
      misses = 0;
      reconnectAttempts = 0;
      const d = device;
      if (status !== 'idle') { status = 'idle'; reason = ''; emit(); }
      try { if (d?.gatt?.connected) d.gatt.disconnect(); } catch { /* 이미 끊김 */ }
    },

    /** 신선도(25초) 만료를 화면에 반영하기 위해 주기적으로 호출 */
    refresh() { emit(); },
    get state() { return snapshot(); },
    get active() { return status !== 'idle' && status !== 'failed'; },
  };
}
