"""Unit tests for parsing helpers used by the operator tools."""
from __future__ import annotations

import unittest

from tools.operator.esp32_link import parse_key_value_lines, parse_value


class ParseValueTests(unittest.TestCase):
    def test_numeric_decoding(self) -> None:
        self.assertEqual(parse_value("42"), 42)
        self.assertEqual(parse_value("0x10"), 16)
        self.assertAlmostEqual(parse_value("3.14"), 3.14)

    def test_boolean_decoding(self) -> None:
        self.assertTrue(parse_value("true"))
        self.assertFalse(parse_value("FALSE"))

    def test_fallback_string(self) -> None:
        self.assertEqual(parse_value("N/A"), "N/A")


class ParseKeyValueLinesTests(unittest.TestCase):
    def test_parses_multiple_lines(self) -> None:
        lines = ["state=IDLE err=0x0000", "vbatt_mV=11950, mps=1"]
        parsed = parse_key_value_lines(lines)
        self.assertEqual(parsed["state"], "IDLE")
        self.assertEqual(parsed["err"], 0x0000)
        self.assertEqual(parsed["vbatt_mV"], 11950)
        self.assertEqual(parsed["mps"], 1)

    def test_skips_missing_pairs(self) -> None:
        parsed = parse_key_value_lines(["hello world", "foo=bar"])
        self.assertEqual(parsed, {"foo": "bar"})


if __name__ == "__main__":  # pragma: no cover - manual execution
    unittest.main()
