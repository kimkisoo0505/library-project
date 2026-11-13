/**
 * 화면 주소 (해시 라우팅)
 *   #/kiosk     키오스크 모드 학생 화면   (src/kiosk/)
 *   #/personal  개인 사용 모드 학생 화면 (src/personal/)
 *   #/admin     관리자 화면             (src/admin/)
 *   그 외(#/ 등) → 저장된 모드 또는 기기 기본값(휴대폰=개인, 그 외=키오스크)의 화면으로 보낸다.
 * 앱(WebView)은 항상 개인 사용 화면.
 */
export const ROUTES = Object.freeze({
  '#/kiosk': { app: 'kiosk', page: 'home' },
  '#/personal': { app: 'personal', page: 'home' },
  '#/admin': { app: 'admin', page: 'admin' },
});

/**
 * @param {string} hash location.hash
 * @param {{ inApp: boolean, mode: 'personal'|'kiosk' }} ctx mode = 저장된 선택 또는 기본값
 * @returns {string} 실제로 열 주소 (ROUTES 의 키)
 */
export function resolveRoute(hash, { inApp, mode }) {
  if (inApp && hash !== '#/admin') return '#/personal';
  if (Object.hasOwn(ROUTES, hash)) return hash;
  return mode === 'personal' ? '#/personal' : '#/kiosk';
}
