/**
 * 브라우저 알림 (Notification API) — 개인 사용 화면 전용 (공용 키오스크에서는 쓰지 않는다).
 *
 * - 사용자가 [브라우저 알림 켜기]를 눌러야 권한을 묻는다 (브라우저 규칙: 버튼 동작 안에서만).
 * - Android Chrome 은 `new Notification()` 을 막으므로 서비스 워커(public/sw.js)의 showNotification 을 쓴다.
 *   이 서비스 워커는 알림을 누르면 이 화면을 여는 일만 하며, 요청 가로채기·캐시는 하지 않는다.
 * - 화면을 보고 있을 때는 팝업만, 다른 탭·앱으로 가 있을 때만 브라우저 알림을 보낸다 (seat-alerts.shouldBrowserNotify).
 * - 이 페이지가 열려 있는 동안만 동작한다 (서버 푸시 없음). 브라우저를 완전히 닫으면 알림이 오지 않는다.
 * - 앱(WebView)·iPhone Safari 등 Notification 이 없는 환경에서는 'no-api'.
 */
import { IN_APP } from './app-detect.js';
import { shouldBrowserNotify } from './seat-alerts.js';

const PREF_KEY = 'library.notify.enabled';
const SW_URL = '/sw.js';
const ICON = '/apple-touch-icon.png';

/** 'ok' | 'no-api' | 'insecure' | 'app' */
export function notifySupport() {
  if (IN_APP) return 'app';
  if (!globalThis.isSecureContext) return 'insecure';
  if (typeof globalThis.Notification !== 'function') return 'no-api';
  return 'ok';
}

/** 'granted' | 'denied' | 'default' | 'unsupported' */
export function notifyPermission() {
  return notifySupport() === 'ok' ? Notification.permission : 'unsupported';
}

function readPref() {
  try { return localStorage.getItem(PREF_KEY) === '1'; } catch { return false; }
}

function writePref(on) {
  try { if (on) localStorage.setItem(PREF_KEY, '1'); else localStorage.removeItem(PREF_KEY); } catch { /* 저장 불가 → 이번 화면에서만 */ }
}

let enabledInMemory = readPref();

/** 켜져 있고 허용된 상태인지 */
export function notifyEnabled() {
  return enabledInMemory && notifyPermission() === 'granted';
}

async function registration() {
  if (!('serviceWorker' in navigator)) return null;
  try {
    await navigator.serviceWorker.register(SW_URL, { scope: '/' });
    // 처음 등록하면 활성화되기 전에는 showNotification 이 실패한다 → 활성화를 기다린다 (최대 5초)
    return await Promise.race([navigator.serviceWorker.ready, new Promise((r) => setTimeout(() => r(null), 5_000))]);
  } catch {
    return null;
  }
}

async function display(title, options) {
  const reg = await registration();
  if (reg?.showNotification) {
    try {
      await reg.showNotification(title, options);
      return true;
    } catch { /* 아래 페이지 알림으로 */ }
  }
  try {
    // 서비스 워커가 없으면 페이지 알림 (데스크톱 브라우저)
    const n = new Notification(title, options);
    n.onclick = () => { window.focus(); n.close(); };
    return true;
  } catch {
    return false;
  }
}

/**
 * [브라우저 알림 켜기] — 반드시 버튼 클릭 안에서 호출.
 * @returns {Promise<'granted' | 'denied' | 'default' | 'unsupported' | 'failed'>}
 */
export async function enableNotify() {
  if (notifySupport() !== 'ok') return 'unsupported';
  let permission = Notification.permission;
  if (permission === 'default') {
    try { permission = await Notification.requestPermission(); } catch { permission = Notification.permission; }
  }
  if (permission !== 'granted') return permission;
  enabledInMemory = true;
  writePref(true);
  const shown = await display('브라우저 알림이 켜졌어요', {
    body: '예약·착석·자동 취소·이용 종료 알림을 이 브라우저로 보내 드려요.',
    icon: ICON,
    tag: 'seat-notify-test',
    data: { url: location.href },
  });
  return shown ? 'granted' : 'failed';
}

export function disableNotify() {
  enabledInMemory = false;
  writePref(false);
}

/** 좌석 알림 보내기 (조건이 맞을 때만). 실패해도 화면 동작에 영향 없음 */
export async function browserNotify({ title, body, tag }) {
  const send = shouldBrowserNotify({
    enabled: enabledInMemory,
    permission: notifyPermission(),
    visible: document.visibilityState === 'visible',
    focused: typeof document.hasFocus === 'function' ? document.hasFocus() : true,
  });
  if (!send) return false;
  try {
    return await display(title, { body, icon: ICON, tag: tag || 'seat', renotify: true, data: { url: location.href } });
  } catch {
    return false;
  }
}

/** 이미 켜 둔 사용자: 화면을 열 때 서비스 워커를 미리 준비해 둔다 */
export function warmUpNotify() {
  if (notifyEnabled()) registration();
}
