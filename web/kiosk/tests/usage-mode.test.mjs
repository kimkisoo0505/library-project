// 사용 모드(개인 사용 / 키오스크) 기본값·저장 단위 테스트
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPhone, defaultMode, loadMode, saveMode, MODE_STORAGE_KEY } from '../src/usage-mode.js';

const UA = {
  androidPhone: 'Mozilla/5.0 (Linux; Android 14; SM-S918N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
  androidTablet: 'Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  firefoxAndroid: 'Mozilla/5.0 (Android 14; Mobile; rv:130.0) Gecko/130.0 Firefox/130.0',
};
const memory = (init = {}) => {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), map: m };
};

test('휴대폰이면 개인 사용, PC·태블릿이면 키오스크가 기본', () => {
  assert.equal(defaultMode({ userAgent: UA.androidPhone }), 'personal');
  assert.equal(defaultMode({ userAgent: UA.iphone }), 'personal');
  assert.equal(defaultMode({ userAgent: UA.firefoxAndroid }), 'personal');
  assert.equal(defaultMode({ userAgent: UA.androidTablet }), 'kiosk');
  assert.equal(defaultMode({ userAgent: UA.windows }), 'kiosk');
});

test('userAgentData.mobile 이 있으면 그 값을 우선', () => {
  assert.equal(isPhone({ userAgent: UA.windows, userAgentData: { mobile: true } }), true);
  assert.equal(isPhone({ userAgent: UA.androidPhone, userAgentData: { mobile: false } }), false);
});

test('저장한 선택이 기본값보다 우선, 잘못된 값은 무시', () => {
  const nav = { userAgent: UA.androidPhone };
  assert.equal(loadMode({ nav, storage: memory({ [MODE_STORAGE_KEY]: 'kiosk' }) }), 'kiosk');
  assert.equal(loadMode({ nav, storage: memory({ [MODE_STORAGE_KEY]: 'admin' }) }), 'personal');
  assert.equal(loadMode({ nav, storage: memory() }), 'personal');
});

test('앱(WebView)은 저장값과 관계없이 항상 개인 사용', () => {
  assert.equal(loadMode({ inApp: true, nav: { userAgent: UA.windows }, storage: memory({ [MODE_STORAGE_KEY]: 'kiosk' }) }), 'personal');
});

test('저장: 올바른 값만, 저장소 오류에도 죽지 않음', () => {
  const s = memory();
  saveMode('kiosk', s);
  assert.equal(s.map.get(MODE_STORAGE_KEY), 'kiosk');
  saveMode('hack', s);
  assert.equal(s.map.get(MODE_STORAGE_KEY), 'kiosk');
  const broken = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.doesNotThrow(() => saveMode('personal', broken));
  assert.equal(loadMode({ nav: { userAgent: UA.windows }, storage: broken }), 'kiosk');
});
