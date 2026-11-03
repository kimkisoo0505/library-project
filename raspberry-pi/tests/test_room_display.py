import logging
import unittest

from agent.event_handler import EventHandler
from agent.room_display import WELCOME_TEXT, RoomDisplay
from agent.seat_manager import TOTAL_SEATS, SeatManager, default_label

logging.getLogger("agent").setLevel(logging.CRITICAL)


class FakeClock:
    def __init__(self) -> None:
        self.now = 100.0

    def __call__(self) -> float:
        return self.now


def snapshot(overrides: dict[int, str]) -> list[dict]:
    rows = []
    for i in range(1, TOTAL_SEATS + 1):
        room, label = default_label(i)
        rows.append({"id": i, "room": room, "label": label, "state": overrides.get(i, "available")})
    return rows


class RoomDisplayTests(unittest.TestCase):
    def setUp(self) -> None:
        self.clock = FakeClock()
        self.seats = SeatManager(clock=self.clock)
        self.seats.mark_cloud_online()
        # 열람실 A: 1 예약, 2·3 착석, 4 점검 / 열람실 B: 31 착석 (A 집계에 포함되면 안 됨)
        self.seats.apply_snapshot(snapshot({1: "reserved", 2: "occupied", 3: "occupied", 4: "maintenance", 31: "occupied"}))
        self.display = RoomDisplay("A", self.seats, welcome_seconds=2.0, erase_step_seconds=0.15, clock=self.clock)

    def test_idle_frame_shows_room_counts(self) -> None:
        frame = self.display.frame()
        self.assertEqual(frame.line1, "")
        self.assertEqual(frame.line2, "Use 3 Free 26")  # 사용중 = 예약1 + 착석2, 점검 1석 제외
        self.assertLessEqual(len(frame.line2), 16)

    def test_welcome_held_for_two_seconds(self) -> None:
        self.display.show_welcome()
        for dt in (0.0, 1.0, 1.99):
            self.clock.now = 100.0 + dt
            self.assertEqual(self.display.frame().line1, WELCOME_TEXT, dt)

    def test_welcome_erased_from_last_character(self) -> None:
        self.display.show_welcome()
        seen = []
        t = 0.0
        while t < 4.0:
            self.clock.now = 100.0 + t
            line = self.display.frame().line1
            if not seen or seen[-1] != line:
                seen.append(line)
            t += 0.01
        self.assertEqual(seen, ["Welcome", "Welcom", "Welco", "Welc", "Wel", "We", "W", ""])
        self.assertFalse(self.display.animating)

    def test_erase_timing(self) -> None:
        self.display.show_welcome()
        self.clock.now = 100.0 + 2.0          # 2초 경과 -> 첫 글자 삭제
        self.assertEqual(self.display.frame().line1, "Welcom")
        self.clock.now = 100.0 + 2.0 + 0.15 * 6  # 7번째 삭제 -> 빈 줄
        self.assertEqual(self.display.frame().line1, "")

    def test_rewelcome_restarts_animation(self) -> None:
        self.display.show_welcome()
        self.clock.now = 102.3
        self.assertNotEqual(self.display.frame().line1, WELCOME_TEXT)
        self.display.show_welcome()
        self.assertEqual(self.display.frame().line1, WELCOME_TEXT)

    def test_offline_hides_counts(self) -> None:
        self.seats.mark_cloud_offline()
        self.assertEqual(self.display.frame().line2, "Offline")

    def test_stale_snapshot_hides_counts(self) -> None:
        self.clock.now += 10_000
        self.assertEqual(self.display.frame().line2, "Offline")

    def test_next_tick_faster_while_animating(self) -> None:
        self.assertEqual(self.display.next_tick(), 0.5)
        self.display.show_welcome()
        self.assertLess(self.display.next_tick(), 0.15)


class FakeDisplay:
    def __init__(self, room: str) -> None:
        self.room = room
        self.count = 0

    def show_welcome(self) -> None:
        self.count += 1


class FakeCloud:
    async def fetch_seats(self) -> list[dict]:
        return snapshot({})

    async def post_device_event(self, event_type: str, **fields: object) -> dict:
        return {}


class FakeSerial:
    connected = False

    async def send(self, kind: str, *fields: str) -> bool:
        return False


class WelcomeTriggerTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.seats = SeatManager()
        self.display = FakeDisplay("A")
        self.handler = EventHandler(self.seats)
        self.handler.attach(cloud=FakeCloud(), serial=FakeSerial(), display=self.display)

    async def notify(self, seat_id: object, reason: str) -> None:
        await self.handler.on_cloud_message({"type": "seats.changed", "seat_id": seat_id, "reason": reason})

    async def test_check_in_in_own_room_shows_welcome(self) -> None:
        await self.notify(5, "reservation.checked_in")       # A05
        self.assertEqual(self.display.count, 1)

    async def test_other_room_or_other_reason_ignored(self) -> None:
        await self.notify(35, "reservation.checked_in")      # B05 -> 라즈베리파이(A) 담당 아님
        await self.notify(5, "reservation.created")          # 예약은 Welcome 아님
        await self.notify(5, "reservation.checked_out")
        await self.notify("bad", "reservation.checked_in")
        await self.notify(999, "reservation.checked_in")
        self.assertEqual(self.display.count, 0)


if __name__ == "__main__":
    unittest.main()
