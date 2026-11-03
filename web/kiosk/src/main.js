import './style.css';
import { renderHome } from './pages/home.js';
import { renderAdmin } from './pages/admin.js';

/** 해시 기반 라우팅: #/ (키오스크), #/admin (관리자) */
const routes = {
  '#/': renderHome,
  '#/admin': renderAdmin,
};

const root = document.querySelector('#app');
let cleanup = null;

function navigate() {
  if (typeof cleanup === 'function') cleanup();
  root.replaceChildren();
  const render = routes[location.hash] ?? routes['#/'];
  cleanup = render(root);
}

window.addEventListener('hashchange', navigate);
navigate();
