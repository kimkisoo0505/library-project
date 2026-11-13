/**
 * 사용 모드: 개인 사용(personal) / 키오스크(kiosk)
 *
 * - 키오스크 모드: 입구에 놓인 공용 기기. 누구나 쓰는 화면이므로 개인 특화 기능을 보이지 않는다.
 * - 개인 사용 모드: 본인 휴대폰. 개인 특화 기능(현재: 블루투스 좌석 자동 연장)을 보이고, 자동 로그아웃(90초)을 하지 않는다.
 * - 키오스크 모드에서만 일정 시간 입력이 없으면 자동 로그아웃한다.
 *
 * 기본값: 휴대폰(Android·iPhone)으로 접속하면 개인 사용, 그 외(PC·태블릿 키오스크 등)는 키오스크.
 * 사용자가 상단 토글로 바꾸면 그 기기(브라우저)에 기억한다. 앱(WebView)은 항상 개인 사용.
 */
export const MODES = Object.freeze(['personal', 'kiosk']);
export const MODE_LABELS = Object.freeze({ personal: '개인 사용', kiosk: '키오스크' });
export const MODE_STORAGE_KEY = 'library.kiosk.mode';

/** 휴대폰인지 (태블릿·PC 는 아님). userAgentData 가 있으면 우선 사용 */
export function isPhone(nav = globalThis.navigator) {
  if (typeof nav?.userAgentData?.mobile === 'boolean') return nav.userAgentData.mobile;
  const ua = String(nav?.userAgent ?? '');
  return /iPhone|iPod/.test(ua) || /Android.+Mobile/.test(ua) || /Mobile.+Firefox/.test(ua);
}

export function defaultMode(nav = globalThis.navigator) {
  return isPhone(nav) ? 'personal' : 'kiosk';
}

/** 저장된 선택 → 없거나 잘못되면 기본값. 앱은 항상 personal */
export function loadMode({ inApp = false, nav = globalThis.navigator, storage = globalThis.localStorage } = {}) {
  if (inApp) return 'personal';
  let saved = null;
  try { saved = storage?.getItem(MODE_STORAGE_KEY) ?? null; } catch { saved = null; }
  return MODES.includes(saved) ? saved : defaultMode(nav);
}

export function saveMode(mode, storage = globalThis.localStorage) {
  if (!MODES.includes(mode)) return;
  try { storage?.setItem(MODE_STORAGE_KEY, mode); } catch { /* 저장 불가 환경: 이번 화면에서만 적용 */ }
}
