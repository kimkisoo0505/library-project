import logging
import unittest
from typing import Any

from agent.cloud_client import CloudUnavailableError
from agent.event_handler import EventHandler
from agent.seat_manager import SeatManager, SeatState, SnapshotError
from agent.serial_manager import SerialMessage

logging.getLogger("agent").setLevel(logging.CRITICAL)


def full_snapshot(overrides: dict[int, str] | None = None) -> list[dict[str, Any]]:
    overrides = overrides or {}
    return [{"id": i, "label": f"A{i:02d}", "state": overrides.get(i, "available")} for i in range(1, 31)]


class FakeClock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


class SeatManagerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.clock = FakeClock()
        self.seats = SeatManager(stale_after_seconds=60, clock=self.clock)

    def test_initial_state_is_unknown_and_blocked(self) -> None:
        self.assertEqual(len(self.seats.snapshot()), 30)
        self.assertTrue(all(s["state"] == "unknown" for s in self.seats.snapshot()))
        self.assertFalse(self.seats.can_forward_requests())

    def test_apply_snapshot_updates_states(self) -> None:
        changed = self.seats.apply_snapshot(full_snapshot({3: "reserved", 7: "occupied"}))
        self.assertEqual(changed, 30)
        self.assertIs(self.seats.get(3).state, SeatState.RESERVED)
        self.assertIs(self.seats.get(7).state, SeatState.OCCUPIED)
        self.assertEqual(self.seats.apply_snapshot(full_snapshot({3: "reserved", 7: "occupied"})), 0)

    def test_invalid_snapshot_changes_nothing(self) -> None:
        self.seats.apply_snapshot(full_snapshot({1: "occupied"}))
        bad_cases = [
            full_snapshot()[:29],                                   # 좌석 누락
            full_snapshot() + [{"id": 31, "state": "available"}],   # 범위 초과
            full_snapshot({2: "flying"}),                           # 알 수 없는 상태
            full_snapshot({2: "unknown"}),                          # unknown 금지
            full_snapshot()[:29] + [{"id": 1, "state": "available"}],  # 중복
        ]
        for bad in bad_cases:
            with self.subTest(bad=len(bad)), self.assertRaises(SnapshotError):
                self.seats.apply_snapshot(bad)
        self.assertIs(self.seats.get(1).state, SeatState.OCCUPIED)

    def test_cloud_offline_keeps_states_and_blocks_requests(self) -> None:
        self.seats.mark_cloud_online()
        self.seats.apply_snapshot(full_snapshot({5: "occupied"}))
        self.assertTrue(self.seats.can_forward_requests())

        self.seats.mark_cloud_offline()
        self.assertFalse(self.seats.can_forward_requests())
        self.assertIs(self.seats.get(5).state, SeatState.OCCUPIED)

    def test_stale_snapshot_blocks_requests(self) -> None:
        self.seats.mark_cloud_online()
        self.seats.apply_snapshot(full_snapshot())
        self.clock.now += 61
        self.assertTrue(self.seats.is_stale())
        self.assertFalse(self.seats.can_forward_requests())

    def test_serial_disconnect_does_not_change_states(self) -> None:
        self.seats.apply_snapshot(full_snapshot({9: "reserved"}))
        before = self.seats.snapshot()
        self.seats.on_serial_disconnected()
        self.assertEqual(self.seats.snapshot(), before)

    def test_get_returns_copy(self) -> None:
        seat = self.seats.get(1)
        seat.state = SeatState.OCCUPIED
        self.assertIs(self.seats.get(1).state, SeatState.UNKNOWN)


class FakeCloud:
    def __init__(self, *, fail: bool = False) -> None:
        self.fail = fail
        self.events: list[tuple[str, dict[str, Any]]] = []

    async def fetch_seats(self) -> list[dict[str, Any]]:
        if self.fail:
            raise CloudUnavailableError("offline")
        return full_snapshot()

    async def post_device_event(self, event_type: str, **fields: Any) -> dict[str, Any]:
        if self.fail:
            raise CloudUnavailableError("offline")
        self.events.append((event_type, fields))
        return {"accepted": True}


class FakeSerial:
    connected = True

    def __init__(self) -> None:
        self.sent: list[tuple[str, ...]] = []

    async def send(self, kind: str, *fields: str) -> bool:
        self.sent.append((kind, *fields))
        return True


class EventHandlerSafetyTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.seats = SeatManager()
        self.cloud = FakeCloud()
        self.serial = FakeSerial()
        self.handler = EventHandler(self.seats)
        self.handler.attach(cloud=self.cloud, serial=self.serial)

    async def press(self) -> None:
        await self.handler.on_serial_message(SerialMessage("BTN", ("1", "PRESS"), "BTN,1,PRESS"))

    async def test_button_rejected_while_offline(self) -> None:
        await self.press()
        self.assertEqual(self.cloud.events, [])
        self.assertIn(("STATUS", "OFFLINE"), self.serial.sent)

    async def test_button_forwarded_when_online_and_fresh(self) -> None:
        await self.handler.on_cloud_connection_change(True)
        await self.press()
        self.assertEqual(self.cloud.events[-1], ("button", {"button_id": 1, "action": "PRESS"}))
        self.assertIn(("STATUS", "ONLINE"), self.serial.sent)

    async def test_forward_failure_marks_offline_without_retry(self) -> None:
        await self.handler.on_cloud_connection_change(True)
        self.cloud.fail = True
        await self.press()
        self.assertFalse(self.seats.cloud_online)
        self.assertEqual(self.serial.sent[-1], ("STATUS", "OFFLINE"))

    async def test_serial_disconnect_keeps_seat_states(self) -> None:
        await self.handler.on_cloud_connection_change(True)
        before = self.seats.snapshot()
        await self.handler.on_serial_connection_change(False)
        self.assertEqual(self.seats.snapshot(), before)
        self.assertEqual(self.cloud.events[-1][0], "serial_disconnected")


if __name__ == "__main__":
    unittest.main()
