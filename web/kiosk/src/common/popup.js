/**
 * 화면 가운데 알림 팝업 (개인 사용 · 키오스크 화면 공용).
 *
 * show({ kind, title, body, action?, autoCloseMs? }) — 여러 개가 오면 차례대로 보여 준다.
 *   kind: 'success' | 'warn' | 'info'
 *   action: { label, run } — [확인] 옆의 보조 버튼 (예: 알림 받기). 누르면 팝업을 닫고 run() 을 호출한다.
 *   autoCloseMs: 공용 키오스크처럼 다음 사람이 써야 하는 화면에서 저절로 닫히게 할 때
 * 내용은 textContent 로만 넣는다. 열릴 때 [확인]에 포커스, Esc·[확인]·바깥 누르기로 닫고 원래 포커스로 돌린다.
 */
import './popup.css';

const ICONS = { success: '✓', warn: '!', info: 'i' };

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

export function createPopup() {
  const scrim = el('div', 'popup-scrim');
  const box = el('div', 'popup');
  box.setAttribute('role', 'alertdialog');
  box.setAttribute('aria-modal', 'true');
  box.setAttribute('aria-labelledby', 'popup-title');
  box.setAttribute('aria-describedby', 'popup-body');
  scrim.append(box);
  scrim.hidden = true;

  const queue = [];
  let current = null;
  let timer = null;
  let returnFocus = null;

  function close() {
    clearTimeout(timer);
    timer = null;
    current = null;
    scrim.classList.remove('show');
    scrim.hidden = true;
    if (queue.length) { open(queue.shift()); return; }
    try { returnFocus?.focus?.({ preventScroll: true }); } catch { /* 이미 사라진 요소 */ }
    returnFocus = null;
  }

  function open(item) {
    current = item;
    const kind = ICONS[item.kind] ? item.kind : 'info';
    const icon = el('div', `popup-icon popup-${kind}`, ICONS[kind]);
    icon.setAttribute('aria-hidden', 'true');
    const title = el('h2', 'popup-title', item.title);
    title.id = 'popup-title';
    const body = el('p', 'popup-body', item.body ?? '');
    body.id = 'popup-body';
    const actions = el('div', 'popup-actions');
    if (item.action) {
      const extra = el('button', 'popup-btn popup-btn-ghost', item.action.label);
      extra.type = 'button';
      extra.addEventListener('click', () => { const run = item.action.run; close(); run?.(); });
      actions.append(extra);
    }
    const ok = el('button', 'popup-btn', '확인');
    ok.type = 'button';
    ok.addEventListener('click', close);
    actions.append(ok);
    box.replaceChildren(icon, title, body, actions);
    scrim.hidden = false;
    // 다음 프레임에 클래스를 붙여 나타나는 애니메이션이 동작하게 한다
    requestAnimationFrame(() => scrim.classList.add('show'));
    ok.focus({ preventScroll: true });
    if (item.autoCloseMs > 0) timer = setTimeout(close, item.autoCloseMs);
  }

  scrim.addEventListener('click', (event) => { if (event.target === scrim) close(); });
  box.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { event.stopPropagation(); close(); return; }
    if (event.key === 'Tab') {
      // 포커스를 팝업 안에 가둔다
      const buttons = [...box.querySelectorAll('button')];
      const i = buttons.indexOf(document.activeElement);
      const next = event.shiftKey ? (i <= 0 ? buttons.length - 1 : i - 1) : (i + 1) % buttons.length;
      event.preventDefault();
      buttons[next]?.focus();
    }
  });

  return {
    element: scrim,
    show(item) {
      if (!item?.title) return;
      if (current) {
        // 같은 내용이 연달아 오면(실시간 갱신 중복 등) 한 번만
        if (current.title === item.title && current.body === item.body) return;
        queue.push(item);
        return;
      }
      returnFocus = document.activeElement;
      open(item);
    },
    close,
    /** 로그아웃 등: 남은 팝업을 모두 닫는다 */
    clear() { queue.length = 0; if (current) close(); },
    get open() { return current != null; },
  };
}
