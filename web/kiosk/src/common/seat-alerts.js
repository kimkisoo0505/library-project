/**
 * 좌석 알림 판단 (순수 함수 — DOM·브라우저 API 없음 → tests/seat-alerts.test.mjs).
 *
 * - 내가 누른 동작(예약·착석·퇴실·취소)의 완료 팝업 문구
 * - 서버가 바꾼 상태(미착석 자동 취소, 이용 시간 종료 자동 퇴실, 관리자 해제, 다른 기기에서 처리) 감지
 * - 시간 경고 (착석 마감 5분 전, 이용 종료 10분 전)
 *
 * 알림은 "보여 주기"만 한다. 상태의 기준은 항상 서버이며 이 모듈은 서버 응답을 해석할 뿐이다.
 */

export const HOLD_WARN_MS = 5 * 60_000;   // 착석 마감 5분 전
export const USAGE_WARN_MS = 10 * 60_000; // 이용 종료 10분 전

const TZ = 'Asia/Seoul';

/** ISO → "오후 3:15" (한국 시간) */
export function clock(iso) {
  const d = new Date(iso ?? '');
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('ko-KR', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
}

/** 좌석 목록에서 내 좌석 요약 (없으면 null) */
export function mineSnapshot(seat) {
  if (!seat || !seat.reservation_id) return null;
  return {
    id: seat.reservation_id,
    state: seat.state,
    label: seat.label,
    room: seat.room,
    expires_at: seat.expires_at ?? null,
    usage_ends_at: seat.usage_ends_at ?? null,
  };
}

// ----- 내가 누른 동작 -----

export function reservedAlert({ label, roomName, expiresAt }) {
  return {
    kind: 'success',
    title: '예약이 완료되었습니다',
    body: `${roomName} ${label} 좌석${expiresAt ? ` · ${clock(expiresAt)}까지 자리에 앉아 [착석]을 눌러 주세요.` : ''}`,
    tag: 'seat-reservation',
  };
}

export function checkedInAlert({ label, roomName, hours, usageEndsAt }) {
  return {
    kind: 'success',
    title: '착석이 완료되었습니다',
    body: `${roomName} ${label} 좌석 · ${hours}시간${usageEndsAt ? ` (${clock(usageEndsAt)}까지)` : ''} 이용할 수 있어요.`,
    tag: 'seat-reservation',
  };
}

export function checkedOutAlert({ label, roomName }) {
  return { kind: 'success', title: '퇴실이 완료되었습니다', body: `${roomName} ${label} 좌석을 반납했어요. 수고하셨어요!`, tag: 'seat-reservation' };
}

export function cancelledAlert({ label, roomName }) {
  return { kind: 'success', title: '예약이 취소되었습니다', body: `${roomName} ${label} 좌석이 다른 사람에게 돌아갔어요.`, tag: 'seat-reservation' };
}

// ----- 서버가 바꾼 상태 -----

/**
 * 이전/다음 내 좌석을 비교해 서버(또는 다른 기기)가 바꾼 변화를 찾는다.
 * @param {ReturnType<typeof mineSnapshot>} prev
 * @param {ReturnType<typeof mineSnapshot>} next
 * @param {Map<number, string>} handled 내가 이 화면에서 직접 한 동작 (예약 id → 예상 결과 'occupied' | 'ended')
 * @returns {null | { type: 'checked_in', snap } | { type: 'ended', snap }}  ended 는 종료 사유를 서버에 물어봐야 함
 */
export function detectChange(prev, next, handled = new Map()) {
  if (!prev) return null;
  if (next && next.id === prev.id) {
    if (prev.state === 'reserved' && next.state === 'occupied' && handled.get(prev.id) !== 'occupied') {
      return { type: 'checked_in', snap: next };
    }
    return null;
  }
  // 이전 예약이 사라짐 (또는 다른 예약으로 바뀜)
  if (handled.get(prev.id) === 'ended') return null;
  return { type: 'ended', snap: prev };
}

/** 다른 기기(키오스크 등)에서 착석 처리됨 */
export function remoteCheckInAlert(snap, roomName) {
  return {
    kind: 'success',
    title: '착석이 완료되었습니다',
    body: `${roomName} ${snap.label} 좌석${snap.usage_ends_at ? ` · ${clock(snap.usage_ends_at)}까지 이용할 수 있어요.` : ''}`,
    tag: 'seat-reservation',
  };
}

/** 예약이 끝난 이유별 팝업 (end_reason 은 이용 기록 API 에서 받은 값, 모르면 null) */
export function endedAlert(snap, roomName, endReason) {
  const seat = `${roomName} ${snap.label}`;
  switch (endReason) {
    case 'hold_timeout':
      return { kind: 'warn', title: '예약이 자동 취소되었어요', body: `착석 마감 시각까지 착석하지 않아 ${seat} 좌석 예약이 취소되었어요.`, tag: 'seat-reservation' };
    case 'time_expired':
      return { kind: 'info', title: '이용 시간이 끝나 자동 퇴실되었어요', body: `${seat} 좌석 이용이 끝났어요. 수고하셨어요!`, tag: 'seat-reservation' };
    case 'admin_release':
      return { kind: 'warn', title: '관리자가 좌석을 해제했어요', body: `${seat} 좌석이 관리자에 의해 해제되었어요. 궁금한 점은 열람실 관리자에게 문의하세요.`, tag: 'seat-reservation' };
    case 'user_cancelled':
      return { kind: 'info', title: '예약이 취소되었어요', body: `${seat} 좌석 예약이 다른 기기에서 취소되었어요.`, tag: 'seat-reservation' };
    case 'checked_out':
      return { kind: 'info', title: '퇴실 처리되었어요', body: `${seat} 좌석이 다른 기기에서 퇴실 처리되었어요.`, tag: 'seat-reservation' };
    default:
      return { kind: 'info', title: snap.state === 'occupied' ? '좌석 이용이 끝났어요' : '예약이 끝났어요', body: `${seat} 좌석 상태가 바뀌었어요.`, tag: 'seat-reservation' };
  }
}

// ----- 시간 경고 -----

/**
 * 지금 보내야 할 시간 경고 (한 번 보낸 것은 fired 에 key 로 기록해 다시 보내지 않음).
 * 이용 종료 시각이 블루투스 재실 확인으로 늘어나면 key 가 달라져 다시 경고할 수 있다.
 * @param {ReturnType<typeof mineSnapshot>} snap
 * @param {Set<string>} fired
 * @param {{ roomName: string, presenceRoom?: boolean }} ctx
 */
export function dueWarning(snap, now, fired, { roomName, presenceRoom = false }) {
  if (!snap) return null;
  if (snap.state === 'reserved' && snap.expires_at) {
    const left = Date.parse(snap.expires_at) - now;
    const key = `hold:${snap.id}`;
    if (left > 0 && left <= HOLD_WARN_MS && !fired.has(key)) {
      return {
        key,
        kind: 'warn',
        title: `착석 마감 ${Math.max(1, Math.ceil(left / 60_000))}분 전이에요`,
        body: `${roomName} ${snap.label} 좌석 · ${clock(snap.expires_at)}까지 착석하지 않으면 예약이 자동 취소돼요.`,
        tag: 'seat-warning',
      };
    }
  }
  if (snap.state === 'occupied' && snap.usage_ends_at) {
    const left = Date.parse(snap.usage_ends_at) - now;
    const key = `usage:${snap.id}:${snap.usage_ends_at}`;
    if (left > 0 && left <= USAGE_WARN_MS && !fired.has(key)) {
      return {
        key,
        kind: 'warn',
        title: `이용 시간이 ${Math.max(1, Math.ceil(left / 60_000))}분 남았어요`,
        body: `${roomName} ${snap.label} 좌석 · ${clock(snap.usage_ends_at)}에 자동 퇴실돼요.${presenceRoom ? ' 블루투스 자리 확인이 켜져 있으면 자동으로 연장돼요.' : ''}`,
        tag: 'seat-warning',
      };
    }
  }
  return null;
}

// ----- 브라우저 알림 -----

/**
 * 브라우저 알림을 보낼지: 켜져 있고 허용됐으며, 화면을 보고 있지 않을 때만
 * (화면을 보고 있으면 팝업이 이미 보이므로 같은 내용을 두 번 띄우지 않는다).
 */
export function shouldBrowserNotify({ enabled, permission, visible, focused }) {
  return Boolean(enabled && permission === 'granted' && (!visible || !focused));
}
