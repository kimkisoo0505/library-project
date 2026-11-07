/**
 * 모바일 앱(WebView) 연동 — "앱 모드".
 *
 * 앱(mobile-app)은 WebView 의 User-Agent 끝에 `LibrarySeatApp/<버전>` 을 붙이고,
 * JavaScript 채널 `window.LibraryApp` 을 제공한다. 이 문자열이 보이면 별도 버튼 없이 자동으로 앱 모드가 된다.
 *
 * 역할 분담 (로그인 정보는 앱으로 넘기지 않는다):
 *  - 웹 → 앱: 지금 블루투스 재실 확인이 필요한지 (로그인 여부, 내 좌석 열람실/상태)
 *  - 앱 → 웹: 블루투스 상태 (Pi 연결 여부, 신호 세기, 기준값 이상인지)
 *  - 재실 확인 API 는 웹이 자기 학생 세션으로 직접 호출한다.
 */
export const IN_APP = /\bLibrarySeatApp\/\S+/.test(navigator.userAgent);

/** 블루투스 재실 확인 장치가 있는 열람실 (서버 PRESENCE_ROOMS 와 같게 유지) */
export const PRESENCE_ROOMS = Object.freeze(['A']);

/** 웹 → 앱 메시지 (앱이 아니면 아무것도 하지 않음) */
export function postToApp(message) {
  if (!IN_APP) return;
  try {
    window.LibraryApp?.postMessage(JSON.stringify(message));
  } catch {
    /* 채널이 아직 준비되지 않음 - 다음 상태 변경 때 다시 보낸다 */
  }
}

const presenceListeners = new Set();

/**
 * 앱 → 웹: 앱이 `window.__libraryApp.presence({...})` 를 호출한다.
 * state = { piConnected: bool, rssi: number|null, inRange: bool, threshold: number, reason: string }
 */
export function onAppPresence(listener) {
  presenceListeners.add(listener);
  return () => presenceListeners.delete(listener);
}

if (IN_APP) {
  window.__libraryApp = {
    presence(state) {
      if (!state || typeof state !== 'object') return;
      const clean = {
        piConnected: state.piConnected === true,
        inRange: state.inRange === true,
        rssi: Number.isInteger(state.rssi) ? state.rssi : null,
        threshold: Number.isInteger(state.threshold) ? state.threshold : null,
        reason: typeof state.reason === 'string' ? state.reason.slice(0, 80) : '',
      };
      for (const listener of presenceListeners) listener(clean);
    },
  };
}
