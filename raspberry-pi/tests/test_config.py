import unittest
from pathlib import Path

from agent.config import ConfigError, derive_ws_url, load_config

VALID_TOKEN = "test-token-not-real-0123456789"


def base_env(**overrides: str) -> dict[str, str]:
    env = {
        "LIBRARY_API_BASE_URL": "https://api.example.invalid",
        "LIBRARY_DEVICE_TOKEN": VALID_TOKEN,
    }
    env.update(overrides)
    return env


class LoadConfigTests(unittest.TestCase):
    def test_minimal_valid_config_uses_defaults(self) -> None:
        config = load_config(base_env())
        self.assertEqual(config.api_base_url, "https://api.example.invalid")
        self.assertEqual(config.ws_url, "wss://api.example.invalid/api/ws?role=device")
        self.assertEqual(config.serial_port, "/dev/ttyACM0")
        self.assertEqual(config.serial_baudrate, 115200)
        self.assertFalse(config.servo_enabled)
        self.assertIsNone(config.log_dir)

    def test_missing_token_is_rejected(self) -> None:
        env = base_env()
        del env["LIBRARY_DEVICE_TOKEN"]
        with self.assertRaises(ConfigError):
            load_config(env)

    def test_placeholder_or_short_token_is_rejected(self) -> None:
        for token in ("changeme", "short"):
            with self.subTest(token=token), self.assertRaises(ConfigError):
                load_config(base_env(LIBRARY_DEVICE_TOKEN=token))

    def test_plain_http_only_allowed_for_localhost(self) -> None:
        with self.assertRaises(ConfigError):
            load_config(base_env(LIBRARY_API_BASE_URL="http://api.example.invalid"))
        config = load_config(base_env(LIBRARY_API_BASE_URL="http://127.0.0.1:8787"))
        self.assertEqual(config.ws_url, "ws://127.0.0.1:8787/api/ws?role=device")

    def test_insecure_ws_url_is_rejected(self) -> None:
        with self.assertRaises(ConfigError):
            load_config(base_env(LIBRARY_WS_URL="ws://api.example.invalid/api/ws"))

    def test_servo_enabled_is_refused(self) -> None:
        with self.assertRaises(ConfigError):
            load_config(base_env(SERVO_ENABLED="true"))
        self.assertFalse(load_config(base_env(SERVO_ENABLED="false")).servo_enabled)

    def test_invalid_numbers_are_rejected(self) -> None:
        with self.assertRaises(ConfigError):
            load_config(base_env(SERIAL_BAUDRATE="fast"))
        with self.assertRaises(ConfigError):
            load_config(base_env(HEARTBEAT_SECONDS="0"))

    def test_token_is_hidden_from_repr_and_redacted(self) -> None:
        config = load_config(base_env(LOG_DIR="logs"))
        self.assertNotIn(VALID_TOKEN, repr(config))
        self.assertEqual(config.redacted()["device_token"], "***")
        self.assertEqual(config.log_dir, Path("logs"))

    def test_room_lcd_and_relay_defaults(self) -> None:
        config = load_config(base_env())
        self.assertEqual(config.device_room, "A")
        self.assertFalse(config.lcd_enabled)
        self.assertEqual((config.lcd_i2c_bus, config.lcd_i2c_address), (1, 0x3E))
        self.assertEqual((config.lcd_type, config.lcd_rgb_address), ("grove-rgb", 0x62))
        self.assertEqual((config.lcd_color_normal, config.lcd_color_offline), ((0, 255, 0), (255, 0, 0)))
        self.assertEqual((config.lcd_welcome_seconds, config.lcd_erase_step_seconds), (2.0, 0.15))
        self.assertFalse(config.central_library_relay)
        self.assertEqual(config.central_library_interval_seconds, 60.0)

    def test_room_lcd_and_relay_overrides(self) -> None:
        config = load_config(base_env(DEVICE_ROOM="b", LCD_ENABLED="true", LCD_I2C_ADDRESS="0x27",
                                      CENTRAL_LIBRARY_RELAY="true", CENTRAL_LIBRARY_INTERVAL_SECONDS="90"))
        self.assertEqual(config.device_room, "B")
        self.assertTrue(config.lcd_enabled and config.central_library_relay)
        self.assertEqual(config.lcd_i2c_address, 0x27)
        self.assertEqual(config.central_library_interval_seconds, 90.0)

    def test_invalid_room_address_interval_rejected(self) -> None:
        config = load_config(base_env(LCD_TYPE="PCF8574", LCD_COLOR_NORMAL="10, 20 ,30"))
        self.assertEqual((config.lcd_type, config.lcd_color_normal), ("pcf8574", (10, 20, 30)))
        for env in ({"DEVICE_ROOM": "AB"}, {"DEVICE_ROOM": "1"}, {"LCD_I2C_ADDRESS": "0x99"},
                    {"LCD_I2C_ADDRESS": "lcd"}, {"CENTRAL_LIBRARY_INTERVAL_SECONDS": "10"},
                    {"LCD_TYPE": "oled"}, {"LCD_COLOR_NORMAL": "0,255"}, {"LCD_COLOR_OFFLINE": "300,0,0"},
                    {"LCD_COLOR_NORMAL": "green"}):
            with self.subTest(env=env), self.assertRaises(ConfigError):
                load_config(base_env(**env))

    def test_derive_ws_url_keeps_path_prefix(self) -> None:
        self.assertEqual(derive_ws_url("https://example.invalid/base"), "wss://example.invalid/base/api/ws?role=device")


if __name__ == "__main__":
    unittest.main()
