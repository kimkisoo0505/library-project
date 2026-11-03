import logging
import unittest
from datetime import datetime, timedelta, timezone
from typing import Any

from agent.event_handler import EventHandler
from agent.remote_command import CommandRejected, RemoteCommandHandler, validate_command
from agent.room_display import RoomDisplay
from agent.seat_manager import SeatManager

logging.getLogger("agent").setLevel(logging.CRITICAL)
NOW = datetime(2026, 11, 4, 10, 0, tzinfo=timezone.utc)


def cmd(**overrides: Any) -> dict[str, Any]:
    base = {"type": "device.command", "command": "shutdown", "id": "c-1", "room": "A",
            "issued_at": "2026-11-04T10:00:00.000Z", "expires_at": "2026-11-04T10:01:00.000Z"}
    base.update(overrides)
    return base


class ValidateTests(unittest.TestCase):
    def ok(self, message: dict[str, Any], **kw: Any):
        args = {"room": "A", "allow_shutdown": True, "seen_ids": set(), "now": NOW}
        args.update(kw)
        return validate_command(message, **args)

    def test_valid(self) -> None:
        c = self.ok(cmd())
        self.assertEqual((c.id, c.command, c.room), ("c-1", "shutdown", "A"))

    def test_rejections(self) -> None:
        cases = {
            "unsupported_command:reboot": (cmd(command="reboot"), {}),
            "other_room": (cmd(room="B"), {}),
            "expired": (cmd(expires_at="2026-11-04T09:59:59Z"), {}),
            "invalid_expiry": (cmd(expires_at="soon"), {}),
            "duplicate": (cmd(), {"seen_ids": {"c-1"}}),
            "missing_id": (cmd(id=""), {}),
            "shutdown_not_allowed": (cmd(), {"allow_shutdown": False}),
        }
        for reason, (message, kw) in cases.items():
            with self.subTest(reason=reason):
                with self.assertRaises(CommandRejected) as ctx:
                    self.ok(message, **kw)
                self.assertEqual(str(ctx.exception), reason)


class HandlerTests(unittest.IsolatedAsyncioTestCase):
    def make(self, allow: bool = True, exit_code: int = 0):
        self.reports: list[dict[str, Any]] = []
        self.poweroffs = 0
        self.messages: list[tuple[str, str] | None] = []

        async def report(event_type: str, **fields: Any) -> dict:
            self.reports.append({"type": event_type, **fields})
            return {}

        async def poweroff() -> int:
            self.poweroffs += 1
            return exit_code

        return RemoteCommandHandler(
            room="A", allow_shutdown=allow, report=report, poweroff=poweroff, delay_seconds=0,
            show_message=lambda a, b: self.messages.append((a, b)), clear_message=lambda: self.messages.append(None),
        )

    def future_cmd(self, **kw: Any) -> dict[str, Any]:
        exp = (datetime.now(timezone.utc) + timedelta(seconds=60)).isoformat()
        return cmd(expires_at=exp, **kw)

    async def test_shutdown_executes_once(self) -> None:
        h = self.make()
        self.assertEqual(await h.handle(self.future_cmd()), "executed")
        self.assertEqual(self.poweroffs, 1)
        self.assertEqual(self.messages[0], ("Shutting down", "Unplug after 30s"))
        self.assertEqual(self.reports[0]["result"], "accepted")
        self.assertEqual(await h.handle(self.future_cmd()), "rejected:duplicate")
        self.assertEqual(self.poweroffs, 1, "같은 명령은 두 번 실행하지 않음")

    async def test_not_allowed_never_powers_off(self) -> None:
        h = self.make(allow=False)
        self.assertEqual(await h.handle(self.future_cmd()), "rejected:shutdown_not_allowed")
        self.assertEqual(self.poweroffs, 0)
        self.assertEqual(self.reports[-1]["result"], "rejected:shutdown_not_allowed")

    async def test_poweroff_failure_restores_display(self) -> None:
        h = self.make(exit_code=1)
        self.assertEqual(await h.handle(self.future_cmd()), "failed")
        self.assertIsNone(self.messages[-1], "실패하면 종료 메시지를 지움")
        self.assertEqual(self.reports[-1]["result"], "failed:exit_1")

    async def test_event_handler_routes_command(self) -> None:
        received: list[dict] = []

        async def on_command(message: dict) -> None:
            received.append(message)

        class Dummy:
            connected = False
            async def send(self, *a: Any) -> bool: return False
            async def fetch_seats(self) -> list: return []
            async def post_device_event(self, *a: Any, **k: Any) -> dict: return {}

        handler = EventHandler(SeatManager())
        handler.attach(cloud=Dummy(), serial=Dummy(), on_command=on_command)
        await handler.on_cloud_message(cmd())
        self.assertEqual(len(received), 1)


class DisplayMessageTests(unittest.TestCase):
    def test_message_overrides_frame(self) -> None:
        seats = SeatManager()
        display = RoomDisplay("A", seats)
        display.show_message("Shutting down", "Unplug after 30s")
        frame = display.frame()
        self.assertEqual((frame.line1, frame.line2, frame.offline), ("Shutting down", "Unplug after 30s", False))
        display.clear_message()
        self.assertEqual(display.frame().line2, "Offline")


if __name__ == "__main__":
    unittest.main()
