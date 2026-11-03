/**
 * 임시 상태 표시줄 (시연/점검용). VITE_SHOW_SYSTEM_STATUS=true 일 때만 표시.
 *  - 라즈베리파이(A) / 아두이노(B) / 아두이노(C) 연결 여부
 *  - 라즈베리파이가 연결된 Wi-Fi 이름과 신호 세기
 *  - 경기대 도서관 서버(중앙/금화) 값을 정상적으로 불러왔는지
 */
export const SHOW_SYSTEM_STATUS = import.meta.env.VITE_SHOW_SYSTEM_STATUS === 'true';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function ago(iso) {
  const t = Date.parse(iso ?? '');
  if (Number.isNaN(t)) return null;
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  return s < 60 ? `${s}초 전` : `${Math.round(s / 60)}분 전`;
}

function item(ok, label, detail) {
  const li = el('li', `ss-item ${ok === true ? 'is-ok' : ok === false ? 'is-bad' : 'is-unknown'}`);
  li.append(el('span', 'ss-dot'), el('span', 'ss-label', label), el('span', 'ss-detail', detail));
  li.setAttribute('aria-label', `${label}: ${detail}`);
  return li;
}

function networkText(network) {
  if (!network) return '네트워크 정보 없음';
  if (network.type === 'wifi') {
    const extra = [network.signal != null ? `신호 ${network.signal}%` : null, network.band].filter(Boolean).join(', ');
    return `Wi-Fi: ${network.ssid ?? '(이름 확인 불가)'}${extra ? ` (${extra})` : ''}`;
  }
  if (network.type === 'ethernet') return '유선 LAN 연결';
  if (network.type === 'none') return '네트워크 없음';
  return '네트워크 확인 불가';
}

export function createSystemStatusBar() {
  const element = el('section', 'system-status');
  element.setAttribute('aria-label', '시스템 연결 상태 (임시)');
  const title = el('h2', null, '시스템 상태 (임시)');
  const list = el('ul', 'ss-list');
  const meta = el('p', 'hint ss-meta');
  element.append(title, list, meta);

  return {
    element,
    update(data) {
      list.replaceChildren();
      for (const d of data.devices ?? []) {
        const seen = ago(d.last_seen_at);
        let detail;
        if (d.online) {
          detail = d.kind === 'raspberry-pi'
            ? `연결됨 · ${networkText(d.network)}${d.lcd === true ? ' · LCD 정상' : d.lcd === false ? ' · LCD 오류' : ''}`
            : '연결됨';
        } else {
          detail = seen ? `연결 안 됨 (마지막 보고 ${seen})` : '연결 안 됨';
        }
        list.append(item(d.online, d.label, detail));
      }
      const cl = data.central_library ?? {};
      const clSeen = ago(cl.fetched_at);
      list.append(item(
        cl.ok,
        '경기대 도서관 서버',
        cl.ok ? `정상 수신 (${clSeen})` : cl.fetched_at ? `수신 지연/실패 (마지막 성공 ${clSeen})` : '수신 기록 없음',
      ));
      meta.textContent = `상태 확인: ${new Date().toLocaleTimeString('ko-KR')}`;
    },
    showError() {
      list.replaceChildren(item(false, '서버', '상태를 불러올 수 없습니다'));
    },
  };
}
