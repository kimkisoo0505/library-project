/**
 * 모바일 앱(WebView) 안에서 열렸는지.
 * 앱(mobile-app)은 WebView 의 User-Agent 끝에 `LibrarySeatApp/<버전>` 을 붙인다.
 * 공용(api.js 의 세션 저장 위치, 주소 이동)과 개인 사용 화면(app-bridge.js)이 함께 쓴다.
 */
export const IN_APP = /\bLibrarySeatApp\/\S+/.test(globalThis.navigator?.userAgent ?? '');
