/**
 * 열람실 온도·습도 표시 (room-climate) — 온도 기능은 이 파일에만 있다.
 *
 * 데이터: /api/system-status 의 devices[].environment (열람실 장치가 30초마다 보고)
 *   - 측정값 있음     → "🌡 24.0°C · 💧 45%"
 *   - 센서 오류       → "🌡 온도 센서 점검 중"
 *   - 그 외(센서 없음) → "🌡 온도 센서 설치 예정"
 *
 * 제거 방법: 이 파일 삭제 + pages/home.js 에서 "room-climate" 주석이 붙은 줄 삭제 (+ style.css 의 .room-climate 블록)
 */
import { api } from '../api.js';

const POLL_MS = 30_000;

export function climateText(device) {
  const env = device?.environment;
  if (env && Number.isFinite(env.temperature_c)) {
    const hum = Number.isInteger(env.humidity) ? ` · 💧 ${env.humidity}%` : '';
    return { text: `🌡 ${env.temperature_c.toFixed(1)}°C${hum}`, kind: 'ok' };
  }
  if (env?.sensor_error) return { text: '🌡 온도 센서 점검 중', kind: 'error' };
  return { text: '🌡 온도 센서 설치 예정', kind: 'pending' };
}

export function createRoomClimate() {
  const element = document.createElement('p');
  element.className = 'room-climate is-pending';
  element.setAttribute('aria-live', 'polite');
  let devices = [];
  let room = null;

  function render() {
    const { text, kind } = climateText(devices.find((d) => d.room === room));
    element.textContent = text;
    element.className = `room-climate is-${kind}`;
  }

  async function load() {
    try {
      devices = (await api.systemStatus()).devices ?? [];
    } catch {
      devices = [];   // 불러오지 못하면 '설치 예정' 으로 (예약 기능에는 영향 없음)
    }
    render();
  }

  load();
  const timer = setInterval(() => { if (!document.hidden) load(); }, POLL_MS);

  return {
    element,
    setRoom(code) {
      room = code;
      render();
    },
    stop() {
      clearInterval(timer);
    },
  };
}
