"""BLE 명령 프로토콜 (docs/BLE_GATT_SPEC.md v0).

하드웨어·BlueZ 없이 테스트할 수 있도록 순수 함수로만 구성한다.

안전 원칙
- v0 명령(PING/ECHO/INFO)은 모두 부작용이 없는 응답뿐이다. 이 모듈은 Arduino,
  서보모터, 좌석 상태, 클라우드에 접근하지 않는다.
- 알 수 없는 명령·형식 오류는 거부한다.
- 짧은 시간에 너무 많은 명령이 오면 BUSY로 거부한다(로그·CPU 폭주 방지).
"""

from __future__ import annotations

import re
import time
from collections import deque
from dataclasses import dataclass

SERVICE_UUID = "27fb1000-18b4-466c-94a3-08bcf22ef878"
COMMAND_CHAR_UUID = "27fb1001-18b4-466c-94a3-08bcf22ef878"  # 앱 -> Pi (Write)
RESPONSE_CHAR_UUID = "27fb1002-18b4-466c-94a3-08bcf22ef878"  # Pi -> 앱 (Notify)
STATUS_CHAR_UUID = "27fb1003-18b4-466c-94a3-08bcf22ef878"  # 앱 <- Pi (Read)

DEFAULT_DEVICE_NAME = "LIB-SEAT-PI"
SERVER_VERSION = "0.1"
MAX_MESSAGE_BYTES = 20

_SEQ_RE = re.compile(r"^[0-9]{1,3}$")
_ECHO_TEXT_RE = re.compile(r"^[A-Za-z0-9]+$")
_PRINTABLE_ASCII_RE = re.compile(r"^[\x20-\x7e]+$")


@dataclass(frozen=True)
class Result:
    """명령 처리 결과. response는 Notify로 보낼 바이트."""

    command: str  # 로그용 명령 이름 (형식 오류면 "?")
    ok: bool
    response: bytes
    error: str | None = None


def _err(seq: str, code: str, command: str = "?") -> Result:
    return Result(command=command, ok=False, response=f"ERR,{seq},{code}".encode("ascii"), error=code)


def handle_command(raw: bytes) -> Result:
    """앱이 Command 특성에 쓴 바이트를 해석해 응답을 만든다."""
    if not raw or len(raw) > MAX_MESSAGE_BYTES:
        return _err("0", "BAD_FORMAT")
    try:
        text = raw.decode("ascii")
    except UnicodeDecodeError:
        return _err("0", "BAD_FORMAT")
    if not _PRINTABLE_ASCII_RE.fullmatch(text):
        return _err("0", "BAD_FORMAT")

    parts = text.split(",")
    if len(parts) < 2 or not _SEQ_RE.fullmatch(parts[1]):
        return _err("0", "BAD_FORMAT")
    command, seq = parts[0], str(int(parts[1]))

    if command == "PING" and len(parts) == 2:
        return Result(command, True, f"PONG,{seq}".encode("ascii"))
    if command == "INFO" and len(parts) == 2:
        return Result(command, True, f"INFO,{seq},{SERVER_VERSION}".encode("ascii"))
    if command == "ECHO" and len(parts) == 3 and _ECHO_TEXT_RE.fullmatch(parts[2]):
        return Result(command, True, f"ECHO,{seq},{parts[2]}".encode("ascii"))
    if command in ("PING", "INFO", "ECHO"):
        return _err("0", "BAD_FORMAT", command)
    return _err(seq, "UNKNOWN", command[:12])


def busy_response(raw: bytes) -> bytes:
    """속도 제한에 걸렸을 때의 응답. seq를 읽을 수 있으면 돌려준다."""
    try:
        parts = raw.decode("ascii").split(",")
        seq = str(int(parts[1])) if len(parts) > 1 and _SEQ_RE.fullmatch(parts[1]) else "0"
    except (UnicodeDecodeError, ValueError):
        seq = "0"
    return f"ERR,{seq},BUSY".encode("ascii")


def status_value(uptime_seconds: float) -> bytes:
    """Status 특성(Read) 값: OK,<업타임 초>."""
    return f"OK,{max(0, int(uptime_seconds))}".encode("ascii")


class RateLimiter:
    """window 초 안에 max_events 개까지만 허용 (슬라이딩 윈도우)."""

    def __init__(self, max_events: int = 10, window: float = 1.0, clock=time.monotonic) -> None:
        self.max_events = max_events
        self.window = window
        self._clock = clock
        self._events: deque[float] = deque()

    def allow(self) -> bool:
        now = self._clock()
        while self._events and now - self._events[0] >= self.window:
            self._events.popleft()
        if len(self._events) >= self.max_events:
            return False
        self._events.append(now)
        return True
