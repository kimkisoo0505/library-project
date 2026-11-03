import logging
import unittest
from typing import Any

from agent.device_status import DeviceStatusReporter, parse_network, split_terse

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
        )

    async def test_payload(self) -> None:
        cloud = FakeCloud()
        self.assertTrue(await self.reporter(cloud).report_once())
        p = cloud.payloads[0]
        self.assertEqual((p["room"], p["network"]["ssid"], p["lcd"], p["serial"], p["central_library"]),
                         ("A", "SK_WiFiGIGAC88A_5G", True, False, True))
        sent_keys = set(p) | set(p["network"])
        self.assertFalse(sent_keys & {"ip", "ip_address", "address", "mac", "password"}, "IP/MAC/비밀번호는 보내지 않음")

    async def test_offline_skipped_and_upload_failure(self) -> None:
        self.assertIsNone(await self.reporter(FakeCloud(), online=False).report_once())
        self.assertFalse(await self.reporter(FakeCloud(fail=True)).report_once())


if __name__ == "__main__":
    unittest.main()
