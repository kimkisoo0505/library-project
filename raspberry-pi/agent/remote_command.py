"""원격 명령 (관리자 화면 → 서버 → 장치 전용 실시간 채널).

현재 지원: shutdown (라즈베리파이 전원 끄기)

검증 (하나라도 어긋나면 무시하고 기록만 남긴다)
  - ALLOW_REMOTE_SHUTDOWN=true 인 장치만 실행
  - 명령의 room 이 이 장치 담당 열람실과 같아야 함
  - expires_at 이 지나지 않았어야 함 (늦게 도착한 명령 무시)
  - 같은 명령 id 는 한 번만 실행
실행
  - LCD 에 "Shutting down" 표시 → 서버에 command_ack 보고 → 3초 후 `systemctl poweroff`
  - 권한: polkit 규칙(raspberry-pi/system/50-library-agent-poweroff.rules)이 pi 사용자에게 전원 끄기만 허용
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from .logger import get_logger, log_event

SUPPORTED_COMMANDS = frozenset({"shutdown"})
POWEROFF_DELAY_SECONDS = 3.0


@dataclass(frozen=True, slots=True)
class RemoteCommand:
    id: str
    command: str
    room: str
    expires_at: datetime


class CommandRejected(ValueError):
    """명령이 검증을 통과하지 못함 (사유를 메시지로)."""


def _parse_time(value: Any) -> datetime:
    text = str(value or "")
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    parsed = datetime.fromisoformat(text)
    if parsed.tzinfo is None:
        raise ValueError("timezone required")
    return parsed


def validate_command(
    message: dict[str, Any],
    *,
    room: str,
    allow_shutdown: bool,
    seen_ids: set[str],
    now: datetime | None = None,
) -> RemoteCommand:
    now = now or datetime.now(timezone.utc)
    command = str(message.get("command") or "")
    cmd_id = str(message.get("id") or "")[:64]
    if command not in SUPPORTED_COMMANDS:
        raise CommandRejected(f"unsupported_command:{command[:20]}")
    if not cmd_id:
        raise CommandRejected("missing_id")
    if cmd_id in seen_ids:
        raise CommandRejected("duplicate")
    if str(message.get("room") or "").upper() != room:
        raise CommandRejected("other_room")
    try:
        expires_at = _parse_time(message.get("expires_at"))
    except ValueError as exc:
        raise CommandRejected("invalid_expiry") from exc
    if expires_at <= now:
        raise CommandRejected("expired")
    if command == "shutdown" and not allow_shutdown:
        raise CommandRejected("shutdown_not_allowed")
    return RemoteCommand(cmd_id, command, room, expires_at)


async def run_poweroff() -> int:
    """systemctl poweroff (polkit 규칙으로 pi 사용자에게만 허용). 반환: 종료 코드"""
    proc = await asyncio.create_subprocess_exec(
        "systemctl", "poweroff", "--no-wall",
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    _, err = await proc.communicate()
    if proc.returncode:
        get_logger("command").warning("poweroff 실패: %s", err.decode(errors="replace")[:200])
    return proc.returncode or 0


class RemoteCommandHandler:
    def __init__(
        self,
        *,
        room: str,
        allow_shutdown: bool,
        report: Callable[..., Awaitable[Any]],
        show_message: Callable[[str, str], None] = lambda a, b: None,
        clear_message: Callable[[], None] = lambda: None,
        poweroff: Callable[[], Awaitable[int]] = run_poweroff,
        delay_seconds: float = POWEROFF_DELAY_SECONDS,
    ) -> None:
        self._room = room
        self._allow_shutdown = allow_shutdown
        self._report = report
        self._show = show_message
        self._clear = clear_message
        self._poweroff = poweroff
        self._delay = delay_seconds
        self._seen: set[str] = set()
        self._log = get_logger("command")

    async def handle(self, message: dict[str, Any]) -> str:
        """반환: 'rejected:<사유>' / 'executed' / 'failed'"""
        try:
            cmd = validate_command(message, room=self._room, allow_shutdown=self._allow_shutdown, seen_ids=self._seen)
        except CommandRejected as exc:
            reason = str(exc)
            log_event(self._log, "command.rejected", "원격 명령 거부", level=logging.WARNING,
                      command=message.get("command"), reason=reason)
            await self._safe_report(message, f"rejected:{reason}")
            return f"rejected:{reason}"

        self._seen.add(cmd.id)
        log_event(self._log, "command.shutdown", "원격 종료 명령 수신 - 전원을 끕니다", level=logging.WARNING, command_id=cmd.id)
        self._show("Shutting down", "Unplug after 30s")
        await self._safe_report(message, "accepted")
        await asyncio.sleep(self._delay)
        code = await self._poweroff()
        if code != 0:
            self._clear()
            await self._safe_report(message, f"failed:exit_{code}")
            return "failed"
        return "executed"

    async def _safe_report(self, message: dict[str, Any], result: str) -> None:
        try:
            await self._report("command_ack", command_id=str(message.get("id") or "")[:64],
                               command=str(message.get("command") or "")[:20], result=result[:64])
        except Exception as exc:  # noqa: BLE001
            log_event(self._log, "command.report_failed", "명령 결과 보고 실패", level=logging.WARNING, error=repr(exc))
