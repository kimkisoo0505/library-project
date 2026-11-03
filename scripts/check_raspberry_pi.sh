#!/usr/bin/env bash
# =====================================================================
# Raspberry Pi 현장 환경 점검 스크립트 (읽기 전용, 아무것도 변경하지 않음)
# 사용법: bash scripts/check_raspberry_pi.sh
# =====================================================================
set -u

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENT_DIR="$PROJECT_ROOT/raspberry-pi"
FAILURES=0

ok()   { printf '\033[32m[ OK ]\033[0m %-24s %s\n' "$1" "${2:-}"; }
warn() { printf '\033[33m[WARN]\033[0m %-24s %s\n' "$1" "${2:-}"; }
fail() { printf '\033[31m[FAIL]\033[0m %-24s %s\n' "$1" "${2:-}"; FAILURES=$((FAILURES + 1)); }

echo "== 도서관 좌석 시스템 라즈베리파이 점검 =="
echo "프로젝트: $PROJECT_ROOT"
echo

# 시스템 정보
HOST="$(hostname)"
[ "$HOST" = "library-server" ] && ok "hostname" "$HOST" || warn "hostname" "$HOST (예상: library-server)"
[ "$(id -un)" = "pi" ] && ok "user" "pi" || warn "user" "$(id -un) (예상: pi)"

if [ -r /etc/os-release ]; then
  . /etc/os-release
  ok "OS" "${PRETTY_NAME:-unknown}"
fi
MODEL="$(tr -d '\0' < /proc/device-tree/model 2>/dev/null || echo unknown)"
ok "model" "$MODEL"

# Python 3.13
if command -v python3 >/dev/null 2>&1; then
  PYV="$(python3 -c 'import sys; print("%d.%d" % sys.version_info[:2])')"
  if python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 13) else 1)'; then
    ok "python3" "$PYV"
  else
    fail "python3" "$PYV (3.13 이상 필요)"
  fi
else
  fail "python3" "없음"
fi

# 가상환경 및 패키지
if [ -x "$AGENT_DIR/.venv/bin/python" ]; then
  ok "venv" "$AGENT_DIR/.venv"
  for pkg in serial httpx websockets dotenv; do
    if "$AGENT_DIR/.venv/bin/python" -c "import $pkg" 2>/dev/null; then ok "pkg:$pkg"; else fail "pkg:$pkg" "미설치 (pip install -r requirements.txt)"; fi
  done
else
  warn "venv" "없음 (python3 -m venv .venv)"
fi

# .env 권한 (내용은 출력하지 않음)
if [ -f "$AGENT_DIR/.env" ]; then
  PERM="$(stat -c '%a' "$AGENT_DIR/.env")"
  [ "$PERM" = "600" ] && ok ".env" "권한 $PERM" || warn ".env" "권한 $PERM (chmod 600 권장)"
  if grep -Eq '^SERVO_ENABLED=(1|true|yes|on)' "$AGENT_DIR/.env"; then
    fail "SERVO_ENABLED" "true 로 설정됨 (현재 단계에서는 false 여야 함)"
  fi
else
  warn ".env" "없음 (cp .env.example .env)"
fi

# 시리얼 장치 및 권한
SERIAL_FOUND=0
for dev in /dev/ttyACM* /dev/ttyUSB* /dev/library-arduino; do
  [ -e "$dev" ] || continue
  SERIAL_FOUND=1
  if [ -r "$dev" ] && [ -w "$dev" ]; then ok "serial" "$dev"; else warn "serial" "$dev (읽기/쓰기 권한 없음)"; fi
done
[ "$SERIAL_FOUND" -eq 1 ] || warn "serial" "Arduino 장치 없음 (USB 연결 확인)"
id -nG | grep -qw dialout && ok "group:dialout" || fail "group:dialout" "sudo usermod -aG dialout $(id -un)"

# 전원 상태
if command -v vcgencmd >/dev/null 2>&1; then
  THR="$(vcgencmd get_throttled 2>/dev/null | cut -d= -f2)"
  [ "$THR" = "0x0" ] && ok "power/throttle" "$THR" || warn "power/throttle" "$THR (저전압/스로틀 이력)"
fi

# 디스크 / 메모리
DISK_USE="$(df -P / | awk 'NR==2 {print $5}' | tr -d '%')"
[ "$DISK_USE" -lt 85 ] && ok "disk /" "${DISK_USE}% 사용" || warn "disk /" "${DISK_USE}% 사용"
ok "memory" "$(free -m | awk '/Mem:/ {print $7 " MB available"}')"

# 시간 동기화 (예약 만료 시각 비교에 중요)
if command -v timedatectl >/dev/null 2>&1; then
  SYNC="$(timedatectl show -p NTPSynchronized --value 2>/dev/null)"
  [ "$SYNC" = "yes" ] && ok "time sync" "NTP 동기화됨" || warn "time sync" "NTP 미동기화"
fi

# 외부 발신 연결 (DNS + HTTPS 도달 여부만 확인)
if getent hosts cloudflare.com >/dev/null 2>&1; then ok "DNS" "cloudflare.com"; else fail "DNS" "이름 해석 실패"; fi
if command -v curl >/dev/null 2>&1; then
  if curl -sS -o /dev/null --max-time 5 https://cloudflare.com; then ok "HTTPS outbound" "가능"; else fail "HTTPS outbound" "실패"; fi
fi

# 인바운드 포트 노출 점검 (에이전트는 리슨 포트를 열지 않아야 함)
if command -v ss >/dev/null 2>&1; then
  LISTEN="$(ss -tlnH 2>/dev/null | awk '{print $4}' | grep -vE '^(127\.|\[::1\]|::1)' | tr '\n' ' ')"
  [ -z "$LISTEN" ] && ok "listening ports" "외부 리슨 없음" || warn "listening ports" "$LISTEN(ssh 외 불필요한 포트 확인)"
fi

# 서비스 상태
if systemctl list-unit-files library-agent.service >/dev/null 2>&1 && systemctl cat library-agent >/dev/null 2>&1; then
  ok "service" "$(systemctl is-active library-agent 2>/dev/null)"
else
  warn "service" "library-agent 미등록"
fi

echo
if [ "$FAILURES" -gt 0 ]; then
  echo "필수 항목 $FAILURES 개 실패"
  exit 1
fi
echo "필수 항목 모두 통과"
