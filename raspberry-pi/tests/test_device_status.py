import logging
import unittest
from datetime import datetime, timezone
from typing import Any

from agent.device_status import (
    BleStatusReader,
    DeviceStatusReporter,
    mask_address,
    parse_ble_connected,
    parse_network,
    split_terse,
)

logging.getLogger("agent").setLevel(logging.CRITICAL)

DEVICES_WIFI = "wlan0:wifi:connected\nlo:loopback:connected (externally)\np2p-dev-wlan0:wifi-p2p:disconnected\neth0:ethernet:unavailable\n"
WIFI_LIST = "no:Other_AP:40:2412 MHz\nyes:SK_WiFiGIGAC88A_5G:60:5805 MHz\n"


class ParseTests(unittest.TestCase):
    def test_split_terse_handles_escaped_colon(self) -> None:
        self.assertEqual(split_terse(r"yes:My\:Phone:70:2437 MHz"), ["yes", "My:Phone", "70", "2437 MHz"])

    def test_wifi(self) -> None:
        self.assertEqual(parse_network(DEVICES_WIFI, WIFI_LIST),
                         {"type": "wifi", "ssid": "SK_WiFiGIGAC88A_5G", "signal": 60, "band": "5GHz"})

    def test_hotspot_24ghz_with_colon_in_name(self) -> None:
        net = parse_network("wlan0:wifi:connected\n", r"yes:Kisoo\:iPhone:82:2437 MHz" + "\n")
        self.assertEqual((net["ssid"], net["signal"], net["band"]), ("Kisoo:iPhone", 82, "2.4GHz"))

    def test_ethernet_and_none(self) -> None:
        self.assertEqual(parse_network("eth0:ethernet:connected\nwlan0:wifi:disconnected\n", "")["type"], "ethernet")
        self.assertEqual(parse_network("wlan0:wifi:disconnected\n", "")["type"], "none")


class FakeCloud:
    def __init__(self, fail: bool = False) -> None:
        self.payloads: list[dict[str, Any]] = []
        self.fail = fail

    async def post_device_status(self, payload: dict[str, Any]) -> dict[str, Any]:
        if self.fail:
            raise RuntimeError("offline")
        self.payloads.append(payload)
        return {"accepted": True}


class ReporterTests(unittest.IsolatedAsyncioTestCase):
    def reporter(self, cloud: FakeCloud, online: bool = True) -> DeviceStatusReporter:
        return DeviceStatusReporter(
            cloud, room="A", is_online=lambda: online,
            components=lambda: {"lcd": True, "serial": False, "central_library": True},
            network_reader=lambda: {"type": "wifi", "ssid": "SK_WiFiGIGAC88A_5G", "signal": 60, "band": "5GHz"},
            ble_reader=lambda: {"server": True, "connected": [{"id": "60:D5", "since": "2026-11-07T10:00:00Z"}]},
        )

    async def test_payload(self) -> None:
        cloud = FakeCloud()
        self.assertTrue(await self.reporter(cloud).report_once())
        p = cloud.payloads[0]
        self.assertEqual((p["room"], p["network"]["ssid"], p["lcd"], p["serial"], p["central_library"]),
                         ("A", "SK_WiFiGIGAC88A_5G", True, False, True))
        self.assertEqual(p["ble"]["connected"][0]["id"], "60:D5")
        sent_keys = set(p) | set(p["network"]) | set(p["ble"]) | set(p["ble"]["connected"][0])
        self.assertFalse(sent_keys & {"ip", "ip_address", "address", "mac", "password"}, "IP/MAC/비밀번호는 보내지 않음")

    async def test_offline_skipped_and_upload_failure(self) -> None:
        self.assertIsNone(await self.reporter(FakeCloud(), online=False).report_once())
        self.assertFalse(await self.reporter(FakeCloud(fail=True)).report_once())


class BleStatusTests(unittest.TestCase):
    OUT = "Device 5D:C0:9A:CD:60:D5 Galaxy Note 7\nDevice aa:bb:cc:dd:ee:ff 홍길동의 Galaxy\ngarbage line\n"

    def test_parse_drops_names(self) -> None:
        self.assertEqual(parse_ble_connected(self.OUT), ["5D:C0:9A:CD:60:D5", "AA:BB:CC:DD:EE:FF"])
        self.assertEqual(mask_address("5D:C0:9A:CD:60:D5"), "60:D5")

    def test_reader_masks_and_tracks_since(self) -> None:
        outputs = {"systemctl": "active\n", "bluetoothctl": self.OUT}
        times = iter([datetime(2026, 11, 7, 10, 0, tzinfo=timezone.utc), datetime(2026, 11, 7, 10, 5, tzinfo=timezone.utc)])
        reader = BleStatusReader(run=lambda args: outputs[args[0]], clock=lambda: next(times))
        first = reader.read()
        self.assertEqual(first["server"], True)
        self.assertEqual([c["id"] for c in first["connected"]], ["60:D5", "EE:FF"])
        self.assertNotIn("Galaxy", str(first))
        self.assertNotIn("5D:C0", str(first))
        outputs["bluetoothctl"] = "Device 5D:C0:9A:CD:60:D5 Galaxy Note 7\n"
        second = reader.read()
        self.assertEqual(second["connected"], [{"id": "60:D5", "since": "2026-11-07T10:00:00Z"}],
                         "처음 확인한 시각을 유지")

    def test_reader_server_inactive_and_unavailable(self) -> None:
        reader = BleStatusReader(run=lambda args: "inactive\n" if args[0] == "systemctl" else "")
        self.assertEqual(reader.read(), {"server": False, "connected": []})
        self.assertIsNone(BleStatusReader(run=lambda args: None).read())


if __name__ == "__main__":
    unittest.main()
