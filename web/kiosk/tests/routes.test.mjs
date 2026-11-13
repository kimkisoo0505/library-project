// 화면 주소(키오스크 / 개인 사용 / 관리자) 결정 단위 테스트
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRoute, ROUTES } from '../src/common/routes.js';
import { switchMode, MODE_ROUTES, MODE_STORAGE_KEY } from '../src/common/usage-mode.js';

test('정해진 주소는 그대로 연다', () => {
  for (const hash of ['#/kiosk', '#/personal', '#/admin']) {
    assert.equal(resolveRoute(hash, { inApp: false, mode: 'kiosk' }), hash);
    assert.equal(resolveRoute(hash, { inApp: false, mode: 'personal' }), hash);
  }
});

test('#/ · 빈 주소 · 모르는 주소 → 저장된 모드(또는 기기 기본값) 화면', () => {
  for (const hash of ['', '#', '#/', '#/home', '#/kiosk/x']) {
    assert.equal(resolveRoute(hash, { inApp: false, mode: 'kiosk' }), '#/kiosk', hash);
    assert.equal(resolveRoute(hash, { inApp: false, mode: 'personal' }), '#/personal', hash);
  }
});

test('앱(WebView)은 키오스크 주소로 와도 항상 개인 사용 (관리자는 예외)', () => {
  assert.equal(resolveRoute('#/kiosk', { inApp: true, mode: 'personal' }), '#/personal');
  assert.equal(resolveRoute('', { inApp: true, mode: 'personal' }), '#/personal');
  assert.equal(resolveRoute('#/admin', { inApp: true, mode: 'personal' }), '#/admin');
});

test('주소 표: 키오스크·개인은 학생 화면, 관리자는 관리자 화면', () => {
  assert.deepEqual(ROUTES['#/kiosk'], { app: 'kiosk', page: 'home' });
  assert.deepEqual(ROUTES['#/personal'], { app: 'personal', page: 'home' });
  assert.deepEqual(ROUTES['#/admin'], { app: 'admin', page: 'admin' });
  assert.equal(ROUTES.toString, Object.prototype.toString, '프로토타입 이름은 주소로 취급하지 않음');
  assert.equal(resolveRoute('toString', { inApp: false, mode: 'kiosk' }), '#/kiosk');
});

test('토글: 선택을 저장하고 그 모드 주소로 이동', () => {
  const saved = new Map();
  const storage = { getItem: (k) => saved.get(k) ?? null, setItem: (k, v) => saved.set(k, v) };
  const prev = globalThis.location;
  globalThis.location = { hash: '#/kiosk' };
  try {
    switchMode('personal', storage);
    assert.equal(globalThis.location.hash, MODE_ROUTES.personal);
    assert.equal(saved.get(MODE_STORAGE_KEY), 'personal');
    switchMode('admin', storage); // 잘못된 값은 무시
    assert.equal(globalThis.location.hash, '#/personal');
  } finally {
    globalThis.location = prev;
  }
});
