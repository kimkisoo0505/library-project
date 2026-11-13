// 모바일 웹 블루투스 재실 확인 (web-ble.js) 단위 테스트 — 라즈베리파이 없이 가짜 Pi 로 시험한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createWebBlePresence, webBleSupport, parseResponse,
  BLE_SERVICE, BLE_COMMAND, BLE_RESPONSE, BLE_DEVICE_NAME,
  PING_INTERVAL_MS, PONG_TIMEOUT_MS, FRESH_MS, MAX_RECONNECT_ATTEMPTS,
} from '../src/web-ble.js';

// ----- 가짜 시계 -----
function fakeClock() {
  let t = 1_000_000;
  let id = 0;
  const tasks = new Map(); // id -> { at, fn, every }
  const add = (fn, ms, every) => { id += 1; tasks.set(id, { at: t + ms, fn, every }); return id; };
  return {
    now: () => t,
    timers: {
      setTimeout: (fn, ms) => add(fn, ms, null),
      clearTimeout: (i) => tasks.delete(i),
      setInterval: (fn, ms) => add(fn, ms, ms),
      clearInterval: (i) => tasks.delete(i),
    },
    /** ms 만큼 시간을 진행하며 그 사이 타이머와 대기 중인 Promise 를 처리 */
    async advance(ms) {
      const end = t + ms;
      for (;;) {
        await flush();
        let next = null;
        for (const [i, task] of tasks) if (task.at <= end && (!next || task.at < next[1].at)) next = [i, task];
        if (!next) break;
        const [i, task] = next;
        t = task.at;
        if (task.every) task.at += task.every; else tasks.delete(i);
        task.fn();
      }
      t = end;
      await flush();
    },
  };
}
const flush = async () => { for (let i = 0; i < 20; i += 1) await Promise.resolve(); };

// ----- 가짜 Pi (GATT 서버) -----
function fakePi(clock, { name = BLE_DEVICE_NAME } = {}) {
  const pi = { responsive: true, reachable: true, writes: [], connects: 0, disconnects: 0 };
  const listeners = { disconnected: new Set(), notify: new Set() };
  const response = {
    uuid: BLE_RESPONSE,
    value: null,
    async startNotifications() { return this; },
    addEventListener(type, fn) { if (type === 'characteristicvaluechanged') listeners.notify.add(fn); },
    removeEventListener(type, fn) { listeners.notify.delete(fn); },
  };
  const send = (text) => {
    response.value = new DataView(new TextEncoder().encode(text).buffer);
    for (const fn of [...listeners.notify]) fn({ target: response });
  };
  const command = {
    uuid: BLE_COMMAND,
    async writeValueWithResponse(bytes) {
      if (!device.gatt.connected) throw new Error('GATT Server is disconnected');
      const text = new TextDecoder().decode(bytes);
      pi.writes.push(text);
      const m = /^PING,(\d+)$/.exec(text);
      if (m && pi.responsive) clock.timers.setTimeout(() => { if (device.gatt.connected) send(`PONG,${m[1]}`); }, 50);
    },
  };
  const service = {
    async getCharacteristic(uuid) {
      if (uuid === BLE_COMMAND) return command;
      if (uuid === BLE_RESPONSE) return response;
      throw new Error('no characteristic');
    },
  };
  const device = {
    name,
    gatt: {
      connected: false,
      async connect() {
        pi.connects += 1;
        if (!pi.reachable) throw new Error('Connection failed for unknown reason.');
        this.connected = true;
        return { async getPrimaryService(uuid) { if (uuid !== BLE_SERVICE) throw new Error('no service'); return service; } };
      },
      disconnect() {
        if (!this.connected) return;
        this.connected = false;
        pi.disconnects += 1;
        for (const fn of [...listeners.disconnected]) clock.timers.setTimeout(fn, 0);
      },
    },
    addEventListener(type, fn) { if (type === 'gattserverdisconnected') listeners.disconnected.add(fn); },
    removeEventListener(type, fn) { listeners.disconnected.delete(fn); },
  };
  /** 열람실 밖으로 나감: 연결 끊기고 다시 연결도 안 됨 */
  pi.leave = () => { pi.reachable = false; device.gatt.disconnect(); };
  pi.device = device;
  pi.send = send;
  return pi;
}

function fakeBluetooth(pi, { cancel = false, known = [] } = {}) {
  const bt = {
    requests: [],
    async requestDevice(options) {
      bt.requests.push(options);
      if (cancel) { const e = new Error('User cancelled the requestDevice() chooser.'); e.name = 'NotFoundError'; throw e; }
      return pi.device;
    },
    async getDevices() { return known; },
  };
  return bt;
}

function setup(opts = {}) {
  const clock = fakeClock();
  const pi = fakePi(clock);
  const bluetooth = fakeBluetooth(pi, opts);
  const states = [];
  const ble = createWebBlePresence({ bluetooth, onChange: (s) => states.push(s), now: clock.now, timers: clock.timers });
  return { clock, pi, bluetooth, ble, states, last: () => states.at(-1) };
}

// ----- 테스트 -----
test('지원 여부: https + navigator.bluetooth 필요', () => {
  assert.equal(webBleSupport({ bluetooth: { requestDevice() {} } }, true), 'ok');
  assert.equal(webBleSupport({ bluetooth: { requestDevice() {} } }, false), 'insecure');
  assert.equal(webBleSupport({}, true), 'no-api', 'iPhone Safari / Firefox');
});

test('응답 해석', () => {
  assert.deepEqual(parseResponse('PONG,12'), { type: 'PONG', seq: 12 });
  assert.deepEqual(parseResponse('ERR,0,BAD_FORMAT'), { type: 'ERR', seq: 0 });
  assert.deepEqual(parseResponse('junk'), { type: 'junk', seq: null });
});

test('켜기: 서비스 UUID 로 기기 선택 → 연결 → PONG 받으면 자리 확인됨', async () => {
  const { clock, bluetooth, ble, last } = setup();
  const started = ble.start();
  await clock.advance(0);
  assert.equal(await started, true);
  assert.deepEqual(bluetooth.requests[0].filters, [{ services: [BLE_SERVICE] }, { name: BLE_DEVICE_NAME }]);
  assert.equal(last().piConnected, true);
  await clock.advance(100); // PONG 도착
  assert.equal(last().inRange, true);
  assert.equal(last().rssi, null, 'Web Bluetooth 는 신호 세기를 주지 않는다');
  assert.equal(ble.active, true);
});

test('선택 창에서 취소하면 조용히 원래 상태로', async () => {
  const { clock, ble, last } = setup({ cancel: true });
  const started = ble.start();
  await clock.advance(0);
  assert.equal(await started, false);
  assert.equal(last().status, 'idle');
  assert.equal(last().reason, '');
  assert.equal(ble.active, false);
});

test('10초마다 PING, 개인정보 없이 PING 만 보낸다', async () => {
  const { clock, pi, ble } = setup();
  ble.start();
  await clock.advance(PING_INTERVAL_MS * 3 + 100);
  assert.equal(pi.writes.length, 4, '연결 직후 1번 + 10초마다 3번');
  for (const w of pi.writes) assert.match(w, /^PING,\d{1,3}$/);
});

test('Pi 가 응답하지 않으면 자리 확인이 풀리고, 끊고 다시 연결해 회복한다', async () => {
  const { clock, pi, ble, last } = setup();
  ble.start();
  await clock.advance(100);
  assert.equal(last().inRange, true);
  pi.responsive = false;
  // PING(10초) → 응답 없음(13초) → PING(20초) → 응답 없음(23초): 2번 놓치면 끊고 재연결 시작
  await clock.advance(2 * PING_INTERVAL_MS + PONG_TIMEOUT_MS + 1);
  assert.equal(last().inRange, false);
  assert.equal(pi.disconnects, 1, 'PONG 2번 놓치면 연결을 끊는다');
  assert.equal(last().status, 'reconnecting');
  await clock.advance(FRESH_MS);
  assert.equal(last().inRange, false, '다시 연결돼도 응답이 없으면 자리 확인 안 됨');
  pi.responsive = true;
  await clock.advance(3_000); // 2초 뒤 재연결 + PONG
  assert.equal(last().status, 'connected');
  assert.equal(last().inRange, true);
});

test('연결 직후 PONG 을 받기 전에는 자리 확인 전 (응답이 와야 근처)', async () => {
  const { clock, pi, ble, last } = setup();
  pi.responsive = false;
  ble.start();
  await clock.advance(10);
  assert.equal(last().status, 'connected');
  assert.equal(last().inRange, false);
});

test('열람실을 떠나 연결이 안 되면 단계적으로 재시도 후 포기', async () => {
  const { clock, pi, ble, last } = setup();
  ble.start();
  await clock.advance(100);
  pi.leave();
  await clock.advance(1);
  assert.equal(last().status, 'reconnecting');
  assert.equal(last().inRange, false);
  await clock.advance(10 * 60_000);
  assert.equal(last().status, 'failed');
  assert.equal(pi.connects, 1 + MAX_RECONNECT_ATTEMPTS);
  assert.equal(ble.active, false);
});

test('돌아와서 다시 연결되면 자동으로 회복 (재시도 중에)', async () => {
  const { clock, pi, ble, last } = setup();
  ble.start();
  await clock.advance(100);
  pi.leave();
  await clock.advance(7_000); // 2초, 4초 재시도 실패
  pi.reachable = true;
  await clock.advance(9_000); // 8초 재시도 성공
  assert.equal(last().status, 'connected');
  assert.equal(last().inRange, true);
});

test('끄기: 연결을 끊고 더 이상 PING 하지 않으며, 늦은 응답은 무시', async () => {
  const { clock, pi, ble, last } = setup();
  ble.start();
  await clock.advance(100);
  ble.stop();
  await clock.advance(1);
  assert.equal(last().status, 'idle');
  assert.equal(pi.device.gatt.connected, false);
  const sent = pi.writes.length;
  await clock.advance(PING_INTERVAL_MS * 3);
  assert.equal(pi.writes.length, sent, '끈 뒤 PING 없음');
  assert.equal(last().status, 'idle', '끊김 이벤트로 재연결하지 않음');
});

test('새로고침 후: 이미 허락한 기기면 선택 창 없이 다시 연결', async () => {
  const clock = fakeClock();
  const pi = fakePi(clock);
  const bluetooth = fakeBluetooth(pi, { known: [pi.device] });
  const states = [];
  const ble = createWebBlePresence({ bluetooth, onChange: (s) => states.push(s), now: clock.now, timers: clock.timers });
  const resumed = ble.resume();
  await clock.advance(100);
  assert.equal(await resumed, true);
  assert.equal(bluetooth.requests.length, 0, '선택 창을 띄우지 않음');
  assert.equal(states.at(-1).inRange, true);
});

test('새로고침 후: 허락한 기기가 없으면 아무것도 하지 않음 (버튼으로 켜기)', async () => {
  const { clock, ble, states } = setup();
  const resumed = ble.resume();
  await clock.advance(0);
  assert.equal(await resumed, false);
  assert.equal(states.length, 0);
});

test('엉뚱한 응답(seq 불일치, 다른 명령)으로는 자리 확인되지 않는다', async () => {
  const { clock, pi, ble, last } = setup();
  pi.responsive = false;
  ble.start();
  await clock.advance(10);
  pi.send('PONG,999');
  pi.send('ERR,1,BUSY');
  await clock.advance(10);
  assert.equal(last().inRange, false);
});
