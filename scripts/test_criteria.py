#!/usr/bin/env python3
"""B and D criteria must not carry a number the journal could enforce."""

from __future__ import annotations

import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CRITERIA = ROOT / "config" / "le_criteria.json"


class CriteriaTests(unittest.TestCase):
    def test_unpublished_items_have_no_threshold(self):
        doc = json.loads(CRITERIA.read_text())
        self.assertEqual(doc["schema_version"], 1)
        grades = {item["grade"] for item in doc["items"]}
        self.assertTrue({"A", "B", "D"} <= grades)
        for item in doc["items"]:
            if item["grade"] in {"B", "D"}:
                self.assertTrue(item["needs_confirmation"], item["id"])
                self.assertIsNone(item.get("numeric_threshold"), item["id"])
            if item["grade"] == "D":
                blob = json.dumps(item)
                self.assertNotIn("0.20", blob, item["id"])
                self.assertNotIn("0.2", blob, item["id"])
        ids = {item["id"] for item in doc["items"]}
        for required in (
            "levels_before_ema",
            "entry_gate_body_both",
            "ema_8_10m",
            "levels_pdh_pdl",
            "levels_pmh_pml",
            "vix_filter",
            "gap_down_play",
            "first_30_60",
            "timeframe_30m",
            "air_gap_tolerance",
            "volume_momentum_threshold",
            "scaling_fraction",
            "entry_candle_which",
            "inside_day",
            "gap_down_target",
        ):
            self.assertIn(required, ids)
        vix = next(item for item in doc["items"] if item["id"] == "vix_filter")
        self.assertEqual(vix["grade"], "A")
        self.assertEqual(vix["numeric_threshold"], 20)
        personal = doc["personal_rules_policy"]
        self.assertIn("do not copy", personal.lower())


if __name__ == "__main__":
    unittest.main()
