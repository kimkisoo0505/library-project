/**
 * 임시 상태 표시줄 (시연/점검용). VITE_SHOW_SYSTEM_STATUS=true 일 때만 표시.
 *  - 라즈베리파이(A) / 아두이노(B) / 아두이노(C) 연결 여부
 *  - 라즈베리파이가 연결된 Wi-Fi 이름과 신호 세기
 *  - 경기대 도서관 서버(중앙/금화) 값을 정상적으로 불러왔는지
 *  - 라즈베리파이에 BLE 로 연결된 모바일 기기 (앱 통신 시험용, 주소 끝 4자리만 표시)
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

function since(iso) {
  const t = Date.parse(iso ?? '');
  if (Number.isNaN(t)) return null;
  const m = Math.max(0, Math.floor((Date.now() - t) / 60_000));
  return m < 1 ? '방금' : m < 60 ? `${m}분째` : `${Math.floor(m / 60)}시간째`;
}

/** 라즈베리파이 보고의 ble 필드 -> [ok, detail] */
export function bleStatusText(pi) {
  if (!pi) return [null, '라즈베리파이 정보 없음'];
  if (!pi.online) return [null, '라즈베리파이 연결 안 됨 · 확인 불가'];
  const ble = pi.ble;
  if (!ble) return [null, '정보 없음 (에이전트 업데이트 필요)'];
  if (ble.server === false) return [false, 'BLE 서버 꺼짐'];
  if (!Array.isArray(ble.connected)) return [null, 'BLE 서버 실행 중 · 연결 정보 확인 불가'];
  if (ble.connected.length === 0) return [null, 'BLE 서버 실행 중 · 연결된 기기 없음'];
  const list = ble.connected
    .map((c) => `…${c.id}${since(c.since) ? ` (${since(c.since)})` : ''}`)
    .join(', ');
  return [true, `${ble.connected.length}대 연결 · ${list}`];
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
      const pi = (data.devices ?? []).find((d) => d.kind === 'raspberry-pi');
      const [bleOk, bleDetail] = bleStatusText(pi);
      list.append(item(bleOk, '모바일 기기 (BLE, 임시)', bleDetail));
      meta.textContent = `상태 확인: ${new Date().toLocaleTimeString('ko-KR')}`;
    },
    showError() {
      list.replaceChildren(item(false, '서버', '상태를 불러올 수 없습니다'));
    },
  };
}
