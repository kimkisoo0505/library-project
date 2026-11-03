"""클라우드 좌석 상태의 로컬 캐시.

- 좌석 상태의 기준은 클라우드(D1)이다. 이 캐시는 오직 클라우드 스냅샷으로만 갱신된다.
- Arduino 연결 단절, 클라우드 연결 단절 시에도 좌석 상태를 임의로 바꾸지 않는다.
  대신 '오래된(stale)' 상태로 표시하고 신규 요청 전달을 막는다.
"""

from __future__ import annotations

import logging
import time
from collections.abc import Callable, Iterable, Mapping
from dataclasses import asdict, dataclass, replace
from enum import StrEnum
from typing import Any

from .logger import get_logger, log_event

TOTAL_SEATS = 30


class SeatState(StrEnum):
    AVAILABLE = "available"
    RESERVED = "reserved"
    OCCUPIED = "occupied"
    MAINTENANCE = "maintenance"
    UNKNOWN = "unknown"


@dataclass(slots=True)
class Seat:
    seat_id: int
    label: str
    state: SeatState = SeatState.UNKNOWN


class SnapshotError(ValueError):
    """클라우드 스냅샷 형식 오류."""


class SeatManager:
    def __init__(
        self,
        total_seats: int = TOTAL_SEATS,
        stale_after_seconds: float = 120.0,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._total = total_seats
        self._stale_after = stale_after_seconds
        self._clock = clock
        self._seats: dict[int, Seat] = {i: Seat(i, f"A{i:02d}") for i in range(1, total_seats + 1)}
        self._cloud_online = False
        self._last_sync: float | None = None
        self._log = get_logger("seats")

    @property
    def cloud_online(self) -> bool:
        return self._cloud_online

    @property
    def last_sync(self) -> float | None:
        return self._last_sync

    def apply_snapshot(self, seats: Iterable[Mapping[str, Any]]) -> int:
        """클라우드 전체 스냅샷 적용. 형식이 하나라도 틀리면 아무것도 바꾸지 않는다.

        Returns:
            상태가 바뀐 좌석 수
        """
        parsed: dict[int, tuple[str, SeatState]] = {}
        for item in seats:
            try:
                seat_id = int(item["id"])
                state = SeatState(str(item["state"]))
                label = str(item.get("label") or f"A{seat_id:02d}")
            except (KeyError, TypeError, ValueError) as exc:
                raise SnapshotError(f"좌석 항목 형식 오류: {item!r}") from exc
            if not 1 <= seat_id <= self._total:
                raise SnapshotError(f"좌석 번호 범위 오류: {seat_id}")
            if state is SeatState.UNKNOWN:
                raise SnapshotError("클라우드 스냅샷에 unknown 상태가 포함될 수 없습니다")
            if seat_id in parsed:
                raise SnapshotError(f"중복 좌석 번호: {seat_id}")
            parsed[seat_id] = (label, state)

        if len(parsed) != self._total:
            raise SnapshotError(f"스냅샷 좌석 수 불일치: {len(parsed)}/{self._total}")

        changed = 0
        for seat_id, (label, state) in parsed.items():
            seat = self._seats[seat_id]
            if seat.state is not state or seat.label != label:
                changed += 1
            seat.state = state
            seat.label = label
        self._last_sync = self._clock()
        log_event(self._log, "seats.snapshot_applied", "좌석 스냅샷 적용", changed=changed)
        return changed

    def mark_cloud_online(self) -> None:
        if not self._cloud_online:
            log_event(self._log, "cloud.online", "클라우드 연결됨")
        self._cloud_online = True

    def mark_cloud_offline(self) -> None:
        """연결 상태 플래그만 바꾼다. 좌석 상태는 마지막으로 확인된 값을 유지한다."""
        if self._cloud_online:
            log_event(self._log, "cloud.offline", "클라우드 연결 끊김 - 신규 요청 차단", level=logging.WARNING)
        self._cloud_online = False

    def on_serial_disconnected(self) -> None:
        """Arduino 단절은 좌석 상태에 영향을 주지 않는다 (명시적으로 아무것도 변경하지 않음)."""
        log_event(self._log, "seats.unchanged_on_serial_disconnect", "Arduino 단절 - 좌석 상태 유지",
                  level=logging.WARNING)

    def is_stale(self) -> bool:
        return self._last_sync is None or (self._clock() - self._last_sync) > self._stale_after

    def can_forward_requests(self) -> bool:
        """신규 예약 등 상태 변경 요청을 클라우드로 전달할 수 있는지.

        에이전트는 요청을 '승인'하지 않는다. 클라우드와 연결되어 있고 최신 상태일 때만 전달한다.
        """
        return self._cloud_online and not self.is_stale()

    def get(self, seat_id: int) -> Seat:
        return replace(self._seats[seat_id])

    def snapshot(self) -> list[dict[str, Any]]:
        return [{**asdict(seat), "state": seat.state.value} for seat in self._seats.values()]
