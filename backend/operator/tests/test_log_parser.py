from __future__ import annotations

import unittest

from backend.operator.log_parser import structure_log_line, structure_logs


class LogParserTests(unittest.TestCase):
    def test_prefixed_key_value_pairs(self) -> None:
        timestamp = 1_690_000_000.0
        line = "[TLM] elev_mm=120 vbatt_mV=7400"
        entries = structure_log_line(timestamp, line)
        self.assertEqual(len(entries), 2)
        first = entries[0]
        self.assertEqual(first["source"], "esp32")
        self.assertEqual(first["device"], "telemetry")
        self.assertEqual(first["parameter"], "elev_mm")
        self.assertEqual(first["value"], 120)
        self.assertEqual(first["raw"], line)
        self.assertIn("T", first["time_iso"])

    def test_message_without_prefix(self) -> None:
        timestamp = 1_690_000_100.0
        line = "status_error=UNO_MISSING state_id=0"
        entries = structure_log_line(timestamp, line)
        self.assertEqual(len(entries), 2)
        keys = {entry["parameter"] for entry in entries}
        self.assertIn("status_error", keys)
        self.assertIn("state_id", keys)
        for entry in entries:
            self.assertEqual(entry["source"], "esp32")
            self.assertEqual(entry["device"], "system")

    def test_uno_prefix_classified_as_arduino(self) -> None:
        timestamp = 1_690_000_150.0
        line = "[UNO] temp=30"
        entries = structure_log_line(timestamp, line)
        self.assertEqual(len(entries), 1)
        entry = entries[0]
        self.assertEqual(entry["source"], "arduino")
        self.assertEqual(entry["device"], "system")
        self.assertEqual(entry["parameter"], "temp")

    def test_colon_payload(self) -> None:
        timestamp = 1_690_000_200.0
        line = "[ESP32] SHELF_MAP: -,G,B; R,Y,K; -,-,-"
        entries = structure_log_line(timestamp, line)
        self.assertEqual(len(entries), 1)
        entry = entries[0]
        self.assertEqual(entry["parameter"], "SHELF_MAP")
        self.assertEqual(entry["source"], "esp32")
        self.assertEqual(entry["device"], "system")
        self.assertEqual(entry["value"], "-,G,B; R,Y,K; -,-,-")

    def test_structure_logs_preserves_order(self) -> None:
        timestamp = 1_690_000_300.0
        lines = [
            (timestamp + 1, "[CLI] available=2"),
            (timestamp + 2, "[CLI] RX: status"),
        ]
        entries = structure_logs(lines)
        self.assertGreaterEqual(len(entries), 2)
        self.assertEqual(entries[0]["parameter"], "available")
        self.assertNotIn("id", entries[0])


if __name__ == "__main__":  # pragma: no cover - manual execution
    unittest.main()
