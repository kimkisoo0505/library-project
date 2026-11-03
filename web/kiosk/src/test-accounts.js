/**
 * 테스트용 예시 학생 계정 안내 (가짜 계정, 실제 학생 정보 아님)
 *
 * ⚠️ 공개 사이트에 비밀번호가 노출되므로 시험 기간에만 사용한다.
 *    실제 운영 전에는 반드시
 *      1) .env.production 의 VITE_SHOW_TEST_ACCOUNTS=false 로 끄고
 *      2) cloudflare/scripts/accounts.mjs 로 비밀번호 재설정 또는 비활성화한다.
 *    VITE_SHOW_TEST_ACCOUNTS 가 'true' 가 아니면 이 목록은 빌드 결과물에서 제거된다.
 *
 * 계정 발급: cloudflare/scripts/accounts.mjs (운영 D1과 로컬 D1의 비밀번호를 동일하게 맞춰 둠)
 */
export const SHOW_TEST_ACCOUNTS = import.meta.env.VITE_SHOW_TEST_ACCOUNTS === 'true';

export const TEST_STUDENTS = SHOW_TEST_ACCOUNTS
  ? [
      { studentNo: 'TEST-0001', name: '테스트학생1', password: 'JEzveJCCMPJx' },
      { studentNo: 'TEST-0002', name: '테스트학생2', password: 'KzkydLNyWPmV' },
      { studentNo: 'TEST-0003', name: '테스트학생3', password: 'R6rhtTA72rp4' },
    ]
  : [];
