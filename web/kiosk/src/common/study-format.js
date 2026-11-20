/**
 * 공부 기록 표시용 순수 함수 (DOM·CSS 없음 → tests/study-format.test.mjs 에서 바로 테스트).
 */

/** 분 → "3시간 20분" / "45분" / "0분" */
export function formatMinutes(min) {
  const m = Math.max(0, Math.floor(Number(min) || 0));
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h === 0) return `${r}분`;
  return r ? `${h}시간 ${r}분` : `${h}시간`;
}

/** 분 → 막대 위 짧은 표시 "3.5h" / "45m" */
export function shortMinutes(min) {
  const m = Math.max(0, Math.floor(Number(min) || 0));
  if (m < 60) return `${m}m`;
  const h = Math.round((m / 60) * 10) / 10;
  return `${h}h`;
}

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

/** 'YYYY-MM-DD'(한국 날짜) → { md: '11/20', wd: '목' } */
export function dayLabel(key) {
  const [y, mo, d] = String(key).split('-').map(Number);
  const wd = WEEKDAYS[new Date(Date.UTC(y, mo - 1, d)).getUTCDay()];
  return { md: `${mo}/${d}`, wd };
}

/** 이용 기록 상태 문구 */
export function historyStatusLabel(item) {
  switch (item.status) {
    case 'reserved': return '예약 중';
    case 'occupied': return '이용 중';
    case 'cancelled': return item.end_reason === 'admin_release' ? '관리자 해제' : '예약 취소';
    case 'expired': return '미착석 자동 취소';
    case 'completed':
      if (item.end_reason === 'time_expired') return '시간 종료 퇴실';
      if (item.end_reason === 'admin_release') return '관리자 해제';
      return '퇴실';
    default: return item.status ?? '';
  }
}
