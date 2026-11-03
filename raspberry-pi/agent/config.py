"""환경 변수 기반 설정 로딩 및 검증."""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

LOCAL_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})
PLACEHOLDER_TOKENS = frozenset({"changeme", "change-me", "your-device-token", "<device-token>", "token"})
VALID_LOG_LEVELS = frozenset({"DEBUG", "INFO", "WARNING", "ERROR"})


class ConfigError(ValueError):
    """설정 값이 없거나 올바르지 않을 때 발생한다."""


@dataclass(frozen=True, slots=True)
class AgentConfig:
    api_base_url: str
    ws_url: str
    device_id: str
    device_token: str = field(repr=False)
    serial_port: str = "/dev/ttyACM0"
    serial_baudrate: int = 115200
    serial_reconnect_seconds: float = 5.0
    heartbeat_seconds: float = 10.0
    seat_sync_seconds: float = 60.0
    seat_stale_seconds: float = 120.0
    request_timeout_seconds: float = 5.0
    log_dir: Path | None = None
    log_level: str = "INFO"
    servo_enabled: bool = False
    # 이 장치가 담당하는 열람실 (라즈베리파이 = A)
    device_room: str = "A"
    # 열람실 LCD (I2C 16x2). grove-rgb = Seeed Grove LCD RGB Backlight v4, pcf8574 = 일반 I2C 백팩
    lcd_enabled: bool = False
    lcd_type: str = "grove-rgb"
    lcd_i2c_bus: int = 1
    lcd_i2c_address: int = 0x3E
    lcd_rgb_address: int = 0x62
    lcd_color_normal: tuple[int, int, int] = (0, 255, 0)     # 평상시 녹색
    lcd_color_offline: tuple[int, int, int] = (255, 0, 0)    # Offline 빨간색
    lcd_welcome_seconds: float = 2.0       # Welcome 표시 유지 시간
    lcd_erase_step_seconds: float = 0.15   # 마지막 글자부터 한 글자씩 지우는 간격
    # 관리자 화면에서 원격 종료 허용 (기본 꺼짐)
    allow_remote_shutdown: bool = False
    # 경기대 중앙/금화도서관 공석 중계
    central_library_relay: bool = False
    central_library_interval_seconds: float = 60.0

    def redacted(self) -> dict[str, Any]:
        """로그 출력용: 비밀 값을 가린 설정 사본."""
        return {
            "api_base_url": self.api_base_url,
            "ws_url": self.ws_url,
            "device_id": self.device_id,
            "device_token": "***",
            "serial_port": self.serial_port,
            "serial_baudrate": self.serial_baudrate,
            "log_dir": str(self.log_dir) if self.log_dir else None,
            "log_level": self.log_level,
            "servo_enabled": self.servo_enabled,
            "device_room": self.device_room,
            "lcd_enabled": self.lcd_enabled,
            "lcd_i2c_bus": self.lcd_i2c_bus,
            "lcd_type": self.lcd_type,
            "lcd_i2c_address": hex(self.lcd_i2c_address),
            "lcd_rgb_address": hex(self.lcd_rgb_address),
            "allow_remote_shutdown": self.allow_remote_shutdown,
            "central_library_relay": self.central_library_relay,
            "central_library_interval_seconds": self.central_library_interval_seconds,
        }


def _get_str(env: Mapping[str, str], key: str, default: str | None = None) -> str:
    value = env.get(key)
    if value is None or value.strip() == "":
        if default is None:
            raise ConfigError(f"필수 환경 변수 {key} 가 설정되지 않았습니다.")
        return default
    return value.strip()


def _get_bool(env: Mapping[str, str], key: str, default: bool) -> bool:
    value = env.get(key)
    if value is None or value.strip() == "":
        return default
    normalized = value.strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    raise ConfigError(f"{key} 값은 true/false 여야 합니다: {value!r}")


def _get_number(env: Mapping[str, str], key: str, default: float, *, minimum: float, maximum: float) -> float:
    value = env.get(key)
    if value is None or value.strip() == "":
        return default
    try:
        number = float(value)
    except ValueError as exc:
        raise ConfigError(f"{key} 값은 숫자여야 합니다: {value!r}") from exc
    if not minimum <= number <= maximum:
        raise ConfigError(f"{key} 값은 {minimum}~{maximum} 범위여야 합니다: {number}")
    return number


def _get_i2c_address(env: Mapping[str, str], key: str, default: int) -> int:
    """'0x3E' 또는 '62' 형식. 7비트 일반 주소 범위(0x03~0x77)만 허용."""
    value = env.get(key)
    if value is None or value.strip() == "":
        return default
    try:
        address = int(value.strip(), 0)
    except ValueError as exc:
        raise ConfigError(f"{key} 값은 0x3E 같은 I2C 주소여야 합니다: {value!r}") from exc
    if not 0x03 <= address <= 0x77:
        raise ConfigError(f"{key} 값이 I2C 주소 범위(0x03~0x77)를 벗어났습니다: {value!r}")
    return address


def _get_rgb(env: Mapping[str, str], key: str, default: tuple[int, int, int]) -> tuple[int, int, int]:
    """'0,255,0' 형식 백라이트 색상."""
    value = env.get(key)
    if value is None or value.strip() == "":
        return default
    parts = [p.strip() for p in value.split(",")]
    try:
        rgb = tuple(int(p) for p in parts)
    except ValueError as exc:
        raise ConfigError(f"{key} 는 R,G,B 형식(예: 0,255,0)이어야 합니다: {value!r}") from exc
    if len(rgb) != 3 or not all(0 <= v <= 255 for v in rgb):
        raise ConfigError(f"{key} 는 0~255 값 3개(R,G,B)여야 합니다: {value!r}")
    return rgb  # type: ignore[return-value]


def validate_http_url(url: str, key: str) -> str:
    parsed = urlparse(url)
    if parsed.scheme == "https" and parsed.netloc:
        return url.rstrip("/")
    if parsed.scheme == "http" and parsed.hostname in LOCAL_HOSTS:
        return url.rstrip("/")
    raise ConfigError(f"{key} 는 https:// 주소여야 합니다 (로컬 개발용 http://localhost 만 예외): {url!r}")


def derive_ws_url(api_base_url: str) -> str:
    parsed = urlparse(api_base_url)
    scheme = "wss" if parsed.scheme == "https" else "ws"
    path = parsed.path.rstrip("/")
    return f"{scheme}://{parsed.netloc}{path}/api/ws?role=device"


def load_dotenv_file(path: Path) -> None:
    """python-dotenv 가 설치되어 있으면 .env 파일을 읽는다 (이미 설정된 값은 덮어쓰지 않음)."""
    try:
        from dotenv import load_dotenv
    except ImportError:
        return
    if path.is_file():
        load_dotenv(path, override=False)


def load_config(env: Mapping[str, str] | None = None) -> AgentConfig:
    source: Mapping[str, str] = os.environ if env is None else env

    api_base_url = validate_http_url(_get_str(source, "LIBRARY_API_BASE_URL"), "LIBRARY_API_BASE_URL")

    ws_raw = source.get("LIBRARY_WS_URL", "").strip()
    if ws_raw:
        parsed = urlparse(ws_raw)
        if not (parsed.scheme == "wss" or (parsed.scheme == "ws" and parsed.hostname in LOCAL_HOSTS)):
            raise ConfigError("LIBRARY_WS_URL 은 wss:// 주소여야 합니다 (로컬 개발용 ws://localhost 만 예외).")
        ws_url = ws_raw
    else:
        ws_url = derive_ws_url(api_base_url)

    device_token = _get_str(source, "LIBRARY_DEVICE_TOKEN")
    if device_token.lower() in PLACEHOLDER_TOKENS or len(device_token) < 16:
        raise ConfigError("LIBRARY_DEVICE_TOKEN 이 예시 값이거나 너무 짧습니다 (16자 이상).")

    log_level = _get_str(source, "LOG_LEVEL", "INFO").upper()
    if log_level not in VALID_LOG_LEVELS:
        raise ConfigError(f"LOG_LEVEL 값이 올바르지 않습니다: {log_level}")

    log_dir_raw = source.get("LOG_DIR", "").strip()

    servo_enabled = _get_bool(source, "SERVO_ENABLED", False)
    if servo_enabled:
        # 안전 규칙: 현재 단계에서는 서보 구동 기능을 제공하지 않는다.
        raise ConfigError("SERVO_ENABLED=true 는 현재 단계에서 지원하지 않습니다. 서보 제어는 안전 검토 후 별도 단계에서 추가합니다.")

    lcd_type = _get_str(source, "LCD_TYPE", "grove-rgb").lower()
    if lcd_type not in ("grove-rgb", "pcf8574"):
        raise ConfigError(f"LCD_TYPE 은 grove-rgb 또는 pcf8574 여야 합니다: {lcd_type!r}")

    device_room = _get_str(source, "DEVICE_ROOM", "A").upper()
    if len(device_room) != 1 or not ("A" <= device_room <= "Z"):
        raise ConfigError(f"DEVICE_ROOM 은 열람실 코드 한 글자(A~Z)여야 합니다: {device_room!r}")

    return AgentConfig(
        api_base_url=api_base_url,
        ws_url=ws_url,
        device_id=_get_str(source, "LIBRARY_DEVICE_ID", "library-server"),
        device_token=device_token,
        serial_port=_get_str(source, "SERIAL_PORT", "/dev/ttyACM0"),
        serial_baudrate=int(_get_number(source, "SERIAL_BAUDRATE", 115200, minimum=1200, maximum=1_000_000)),
        serial_reconnect_seconds=_get_number(source, "SERIAL_RECONNECT_SECONDS", 5.0, minimum=0.5, maximum=300),
        heartbeat_seconds=_get_number(source, "HEARTBEAT_SECONDS", 10.0, minimum=1, maximum=3600),
        seat_sync_seconds=_get_number(source, "SEAT_SYNC_SECONDS", 60.0, minimum=5, maximum=3600),
        seat_stale_seconds=_get_number(source, "SEAT_STALE_SECONDS", 120.0, minimum=10, maximum=86400),
        request_timeout_seconds=_get_number(source, "REQUEST_TIMEOUT_SECONDS", 5.0, minimum=0.5, maximum=60),
        log_dir=Path(log_dir_raw) if log_dir_raw else None,
        log_level=log_level,
        servo_enabled=servo_enabled,
        device_room=device_room,
        lcd_enabled=_get_bool(source, "LCD_ENABLED", False),
        lcd_i2c_bus=int(_get_number(source, "LCD_I2C_BUS", 1, minimum=0, maximum=20)),
        lcd_type=lcd_type,
        lcd_i2c_address=_get_i2c_address(source, "LCD_I2C_ADDRESS", 0x3E),
        lcd_rgb_address=_get_i2c_address(source, "LCD_RGB_ADDRESS", 0x62),
        lcd_color_normal=_get_rgb(source, "LCD_COLOR_NORMAL", (0, 255, 0)),
        lcd_color_offline=_get_rgb(source, "LCD_COLOR_OFFLINE", (255, 0, 0)),
        lcd_welcome_seconds=_get_number(source, "LCD_WELCOME_SECONDS", 2.0, minimum=0.5, maximum=60),
        lcd_erase_step_seconds=_get_number(source, "LCD_ERASE_STEP_SECONDS", 0.15, minimum=0.02, maximum=2),
        allow_remote_shutdown=_get_bool(source, "ALLOW_REMOTE_SHUTDOWN", False),
        central_library_relay=_get_bool(source, "CENTRAL_LIBRARY_RELAY", False),
        # 학교 서버 부담을 고려해 30초 미만으로는 설정할 수 없다
        central_library_interval_seconds=_get_number(
            source, "CENTRAL_LIBRARY_INTERVAL_SECONDS", 60.0, minimum=30, maximum=3600
        ),
    )
