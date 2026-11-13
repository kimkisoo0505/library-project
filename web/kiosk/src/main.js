/**
 * 해시 라우터: 키오스크(#/kiosk) · 개인 사용(#/personal) · 관리자(#/admin) 는 서로 별개의 코드와 스타일이다.
 *
 * 한 페이지에서는 한 화면만 불러온다. 다른 화면으로 가면(예: 키오스크 → 개인 사용, 학생 → 관리자)
 * 페이지를 새로 열어, 각 화면의 CSS 가 섞이지 않게 한다. 화면 코드는 필요할 때만 불러온다(동적 import).
 */
import { IN_APP } from './common/app-detect.js';
import { loadMode } from './common/usage-mode.js';
import { ROUTES, resolveRoute } from './common/routes.js';

const LOADERS = {
  kiosk: () => import('./kiosk/home.js').then((m) => m.renderKioskHome),
  personal: () => import('./personal/home.js').then((m) => m.renderPersonalHome),
  admin: () => import('./admin/admin.js').then((m) => m.renderAdmin),
};

const root = document.querySelector('#app');
let currentApp = null;
let cleanup = null;

async function navigate() {
  const target = resolveRoute(location.hash, { inApp: IN_APP, mode: loadMode({ inApp: IN_APP }) });
  if (target !== location.hash) history.replaceState(null, '', target); // #/ 등 → 실제 화면 주소로 (기록 안 남김)
  const { app, page } = ROUTES[target];
  if (currentApp === app) return;
  if (currentApp) { location.reload(); return; } // 다른 화면: 새로 열어 스타일이 섞이지 않게
  currentApp = app;
  root.replaceChildren();
  root.dataset.page = page; // 화면별 레이아웃(폭) 구분용
  root.dataset.mode = app;
  const render = await LOADERS[app]();
  if (typeof cleanup === 'function') cleanup();
  cleanup = render(root);
}

window.addEventListener('hashchange', navigate);
navigate();
