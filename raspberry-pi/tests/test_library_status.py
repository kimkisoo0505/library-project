import logging
import ssl
import unittest
from typing import Any

from agent.library_status import INTERMEDIATE_CERT, LibraryStatusRelay, slim_rooms

logging.getLogger("agent").setLevel(logging.CRITICAL)

ROOM = {"code": 8, "name": "3F 제1열람실", "cnt": 50, "available": 12, "inUse": 38, "fix": 0,
        "unavailable": 0, "disabled": 0, "startTm": "0600", "endTm": "2400", "extra": "drop-me"}


class FakeResponse:
    def __init__(self, status: int, body: Any) -> None:
        self.status_code = status
        self._body = body

    def json(self) -> Any:
        return self._body


class FakeClient:
    def __init__(self, routes: dict[str, Any]) -> None:
        self.routes = routes
        self.calls: list[str] = []

    async def get(self, path: str) -> FakeResponse:
        self.calls.append(path)
        result = self.routes[path]
        if isinstance(result, Exception):
            raise result
        return result


class FakeCloud:
    def __init__(self, fail: bool = False) -> None:
        self.payloads: list[dict] = []
        self.fail = fail

    async def post_central_library(self, payload: dict) -> dict:
        if self.fail:
            raise RuntimeError("offline")
        self.payloads.append(payload)
        return {"accepted": True}


class SslContextTests(unittest.TestCase):
    def test_intermediate_cert_bundled(self) -> None:
        text = INTERMEDIATE_CERT.read_text(encoding="ascii")
        self.assertIn("BEGIN CERTIFICATE", text)

    def test_context_keeps_verification_on(self) -> None:
        try:
            from agent.library_status import build_ssl_context
            context = build_ssl_context()
        except ModuleNotFoundError:
            self.skipTest("certifi 미설치 (httpx 설치 시 함께 설치됨)")
        self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)
        self.assertTrue(context.check_hostname)


class RelayTests(unittest.IsolatedAsyncioTestCase):
    def ok_routes(self) -> dict[str, Any]:
        return {
            "/libraries/lib-status/1": FakeResponse(200, {"code": 1, "data": [ROOM]}),
            "/libraries/lib-status/2": FakeResponse(200, {"code": 1, "data": [ROOM, ROOM]}),
        }

    def test_slim_rooms(self) -> None:
        rooms = slim_rooms([ROOM, "junk", None])
        self.assertEqual(len(rooms), 1)
        self.assertNotIn("extra", rooms[0])
        self.assertEqual(rooms[0]["available"], 12)
        with self.assertRaises(ValueError):
            slim_rooms({"not": "a list"})
        self.assertEqual(len(slim_rooms([ROOM] * 80)), 50)

    async def test_both_campuses_uploaded(self) -> None:
        cloud = FakeCloud()
        client = FakeClient(self.ok_routes())
        ok = await LibraryStatusRelay(cloud).run_once(client)
        self.assertTrue(ok)
        payload = cloud.payloads[0]
        self.assertEqual([c["id"] for c in payload["campuses"]], [1, 2])
        self.assertEqual(len(payload["campuses"][1]["data"]), 2)
        self.assertEqual(payload["errors"], [])

    async def test_partial_failure_reports_error(self) -> None:
        routes = self.ok_routes()
        routes["/libraries/lib-status/2"] = OSError("CERTIFICATE_VERIFY_FAILED")
        cloud = FakeCloud()
        ok = await LibraryStatusRelay(cloud).run_once(FakeClient(routes))
        self.assertFalse(ok)
        self.assertEqual([c["id"] for c in cloud.payloads[0]["campuses"]], [1])
        self.assertIn("금화도서관", cloud.payloads[0]["errors"][0])

    async def test_api_error_codes(self) -> None:
        routes = {
            "/libraries/lib-status/1": FakeResponse(503, None),
            "/libraries/lib-status/2": FakeResponse(200, {"code": -1}),
        }
        cloud = FakeCloud()
        await LibraryStatusRelay(cloud).run_once(FakeClient(routes))
        errors = cloud.payloads[0]["errors"]
        self.assertTrue(any("http_503" in e for e in errors) and any("api_error" in e for e in errors))

    async def test_offline_skips_school_server(self) -> None:
        client = FakeClient(self.ok_routes())
        cloud = FakeCloud()
        ok = await LibraryStatusRelay(cloud, is_online=lambda: False).run_once(client)
        self.assertFalse(ok)
        self.assertEqual(client.calls, [], "오프라인이면 학교 서버도 호출하지 않음")
        self.assertEqual(cloud.payloads, [])

    async def test_upload_failure_does_not_raise(self) -> None:
        ok = await LibraryStatusRelay(FakeCloud(fail=True)).run_once(FakeClient(self.ok_routes()))
        self.assertFalse(ok)

    def test_interval_minimum_30_seconds(self) -> None:
        self.assertEqual(LibraryStatusRelay(FakeCloud(), interval_seconds=5)._interval, 30.0)


if __name__ == "__main__":
    unittest.main()
