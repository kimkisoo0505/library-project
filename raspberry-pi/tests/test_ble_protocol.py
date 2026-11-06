import logging
import unittest

from agent.ble_protocol import (
    COMMAND_CHAR_UUID,
    MAX_MESSAGE_BYTES,
    RESPONSE_CHAR_UUID,
    SERVICE_UUID,
    STATUS_CHAR_UUID,
    RateLimiter,
    busy_response,
    handle_command,
    status_value,
)
from agent.ble_server import BleGattServer, load_settings

logging.getLogger("agent").setLevel(logging.CRITICAL)


class HandleCommandTests(unittest.TestCase):
    def resp(self, raw: bytes) -> bytes:
        return handle_command(raw).response

    def test_ping(self):
        self.assertEqual(self.resp(b"PING,7"), b"PONG,7")
        self.assertEqual(self.resp(b"PING,007"), b"PONG,7")

    def test_echo(self):
        self.assertEqual(self.resp(b"ECHO,12,Hello1"), b"ECHO,12,Hello1")

    def test_info(self):
        r = handle_command(b"INFO,999")
        self.assertTrue(r.ok)
        self.assertTrue(r.response.startswith(b"INFO,999,"))
        self.assertLessEqual(len(r.response), MAX_MESSAGE_BYTES)

    def test_unknown_command_is_rejected_with_seq(self):
        r = handle_command(b"SERVO,3,90")
        self.assertFalse(r.ok)
        self.assertEqual(r.response, b"ERR,3,UNKNOWN")

    def test_bad_formats(self):
        for raw in [
            b"",
            b"PING",
            b"PING,",
            b"PING,1000",
            b"PING,-1",
            b"PING,1,extra",
            b"ECHO,1",
            b"ECHO,1,has space",
            b"ECHO,1,a,b",
            b"ECHO,1,\xed\x95\x9c",  # non-ASCII
            b"PING,1\n",
            b"X" * (MAX_MESSAGE_BYTES + 1),
        ]:
            with self.subTest(raw=raw):
                self.assertEqual(self.resp(raw), b"ERR,0,BAD_FORMAT")

    def test_every_response_fits_one_packet(self):
        for raw in [b"PING,999", b"INFO,999", b"ECHO,999,ABCDEFGHIJK", b"ZZZZZZZZZZZZZZZ,999"]:
            with self.subTest(raw=raw):
                self.assertLessEqual(len(self.resp(raw)), MAX_MESSAGE_BYTES)

    def test_busy_response_keeps_seq_when_possible(self):
        self.assertEqual(busy_response(b"PING,5"), b"ERR,5,BUSY")
        self.assertEqual(busy_response(b"\xff\xfe"), b"ERR,0,BUSY")
        self.assertEqual(busy_response(b"garbage"), b"ERR,0,BUSY")

    def test_status_value(self):
        self.assertEqual(status_value(3600.9), b"OK,3600")
        self.assertEqual(status_value(-5), b"OK,0")


class RateLimiterTests(unittest.TestCase):
    def test_sliding_window(self):
        now = [0.0]
        rl = RateLimiter(max_events=3, window=1.0, clock=lambda: now[0])
        self.assertEqual([rl.allow() for _ in range(4)], [True, True, True, False])
        now[0] = 1.0
        self.assertTrue(rl.allow())


class UuidTests(unittest.TestCase):
    def test_uuids_match_spec_and_mobile_app(self):
        uuids = [SERVICE_UUID, COMMAND_CHAR_UUID, RESPONSE_CHAR_UUID, STATUS_CHAR_UUID]
        self.assertEqual(len(set(uuids)), 4)
        for u in uuids:
            self.assertTrue(u.endswith("-18b4-466c-94a3-08bcf22ef878"))
            self.assertEqual(u, u.lower())


class SettingsTests(unittest.TestCase):
    def test_defaults(self):
        s = load_settings({})
        self.assertEqual(s["name"], "LIB-SEAT-PI")
        self.assertIsNone(s["adapter"])

    def test_name_too_long_rejected(self):
        with self.assertRaises(ValueError):
            load_settings({"BLE_DEVICE_NAME": "TWELVE-CHARS"})


class _Char:
    def __init__(self, uuid: str):
        self.uuid = uuid
        self.value = bytearray()


class _FakeBless:
    """bless.BlessServer 대역: 특성 값과 update_value 호출만 기록."""

    def __init__(self):
        self.chars = {u: _Char(u) for u in (COMMAND_CHAR_UUID, RESPONSE_CHAR_UUID, STATUS_CHAR_UUID)}
        self.notified: list[bytes] = []

    def get_characteristic(self, uuid):
        return self.chars[uuid]

    def update_value(self, service_uuid, char_uuid):
        assert service_uuid == SERVICE_UUID and char_uuid == RESPONSE_CHAR_UUID
        self.notified.append(bytes(self.chars[char_uuid].value))
        return True


class ServerCallbackTests(unittest.TestCase):
    def setUp(self):
        self.srv = BleGattServer("LIB-SEAT-PI", None)
        self.fake = _FakeBless()
        self.srv.server = self.fake

    def test_write_command_notifies_response(self):
        self.srv._on_write(self.fake.chars[COMMAND_CHAR_UUID], bytearray(b"PING,1"))
        self.assertEqual(self.fake.notified, [b"PONG,1"])

    def test_write_to_other_characteristic_is_ignored(self):
        self.srv._on_write(self.fake.chars[STATUS_CHAR_UUID], bytearray(b"PING,1"))
        self.assertEqual(self.fake.notified, [])

    def test_rate_limit_answers_busy(self):
        now = [0.0]
        self.srv.limiter = RateLimiter(max_events=2, window=1.0, clock=lambda: now[0])
        for i in range(3):
            self.srv._on_write(self.fake.chars[COMMAND_CHAR_UUID], bytearray(f"PING,{i}".encode()))
        self.assertEqual(self.fake.notified, [b"PONG,0", b"PONG,1", b"ERR,2,BUSY"])

    def test_read_status(self):
        value = self.srv._on_read(self.fake.chars[STATUS_CHAR_UUID])
        self.assertTrue(bytes(value).startswith(b"OK,"))


if __name__ == "__main__":
    unittest.main()
