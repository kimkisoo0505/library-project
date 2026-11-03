"""열람실 LCD 화면 내용 계산 (하드웨어와 분리된 순수 로직).

  1줄: 평소에는 비어 있음. 웹에서 이 열람실 좌석의 '착석'이 처리되면
       "Welcome" 을 welcome_seconds 동안 표시한 뒤, 마지막 글자부터 한 글자씩 지운다.
  2줄: 이 열람실의 "Use {사용중} Free {공석}"
       - 사용중 = 예약 + 착석, 공석 = 이용 가능 (점검 좌석은 어느 쪽에도 넣지 않음)
       - 클라우드 미연결 또는 좌석 정보가 오래되면 "Offline" (틀린 숫자를 보여주지 않기 위함)
"""

from __future__ import annotations

import math
import time
from collections.abc import Callable
from dataclasses import dataclass

from .seat_manager import SeatManager, SeatState

WELCOME_TEXT = "Welcome"


@dataclass(frozen=True, slots=True)
class Frame:
    line1: str
    line2: str


class RoomDisplay:
    def __init__(
        self,
        room: str,
        seats: SeatManager,
        *,
        welcome_seconds: float = 2.0,
        erase_step_seconds: float = 0.15,
        idle_text: str = "",
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.room = room
        self._seats = seats
        self._welcome_seconds = welcome_seconds
        self._erase_step = erase_step_seconds
        self._idle_text = idle_text
        self._clock = clock
        self._welcome_started: float | None = None

    def show_welcome(self) -> None:
        """진행 중인 애니메이션이 있어도 처음부터 다시 시작한다."""
        self._welcome_started = self._clock()

    def _line1(self, now: float) -> str:
        if self._welcome_started is None:
            return self._idle_text
        elapsed = now - self._welcome_started
        if elapsed < self._welcome_seconds:
            return WELCOME_TEXT
        removed = math.floor((elapsed - self._welcome_seconds) / self._erase_step) + 1
        remaining = len(WELCOME_TEXT) - removed
        if remaining <= 0:
            self._welcome_started = None
            return self._idle_text
        return WELCOME_TEXT[:remaining]

    def _line2(self) -> str:
        if not self._seats.can_forward_requests():
            return "Offline"
        used = free = 0
        for seat in self._seats.snapshot(self.room):
            state = seat["state"]
            if state in (SeatState.RESERVED, SeatState.OCCUPIED):
                used += 1
            elif state == SeatState.AVAILABLE:
                free += 1
        return f"Use {used} Free {free}"

    @property
    def animating(self) -> bool:
        return self._welcome_started is not None

    def frame(self) -> Frame:
        return Frame(self._line1(self._clock()), self._line2())

    def next_tick(self, idle_interval: float = 0.5) -> float:
        """다음 화면 확인까지 기다릴 시간 (애니메이션 중에는 짧게)."""
        return min(self._erase_step / 2, idle_interval) if self.animating else idle_interval
