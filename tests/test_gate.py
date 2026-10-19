import unittest

from egghead import gate as G


def inp(**kw):
    base = dict(check="db_health", status="degraded", later_turns=["Okay, let's focus on the API."],
                silence_s=1.6, self_repaired_p=0.2, interrupt_p=0.2)
    return G.GateInput(**{**base, **kw})


class GateTests(unittest.TestCase):
    def test_speaks_on_contradicted_db_claim_in_a_gap(self):
        d = G.decide(inp())
        self.assertTrue(d.speak)
        self.assertEqual(G.LEVELS[d.cost_level], "high")

    def test_claim_must_persist_one_turn(self):
        self.assertEqual(G.decide(inp(later_turns=[])).blocked_by, "persisted")

    def test_keyword_repair_blocks(self):
        for text in ("Wait Sam, orders-db is at 98", "Hold on, it spiked", "Are you sure?",
                     "Sam, how sure are you?"):
            d = G.decide(inp(later_turns=[text]))
            self.assertEqual((d.blocked_by, d.repaired_by), ("not_repaired", "keyword"), text)

    def test_agreement_is_not_repair(self):
        self.assertTrue(G.decide(inp(later_turns=["Agreed, DB looks okay from here too."])).speak)

    def test_later_true_claim_repairs(self):
        d = G.decide(inp(later_claim_supports_check=True))
        self.assertEqual(d.repaired_by, "ledger")

    def test_never_talks_over_a_live_voice(self):
        d = G.decide(inp(silence_s=0.1, interrupt_p=0.0))
        self.assertEqual(d.blocked_by, "min_silence")

    def test_decider_gap_or_long_silence_opens_floor(self):
        self.assertEqual(G.decide(inp(silence_s=0.8, interrupt_p=0.9)).blocked_by, "floor_open")
        self.assertTrue(G.decide(inp(silence_s=3.0, interrupt_p=0.9)).speak)
        self.assertTrue(G.decide(inp(silence_s=0.8, interrupt_p=0.3)).speak)

    def test_parked_topic_is_not_worth_it(self):
        d = G.decide(inp(check="service_error_rate",
                         later_turns=["Auth isn't in the checkout path, let's park that."]))
        self.assertEqual((d.blocked_by, G.LEVELS[d.cost_level]), ("worth_it", "low"))

    def test_down_raises_cost_and_alarm_list_is_moderate(self):
        self.assertEqual(G.cost_level(inp(check="latency_p99", status="down")), 3)
        self.assertEqual(G.cost_level(inp(check="alarm_state")), 2)

    def test_cooldown(self):
        self.assertEqual(G.decide(inp(seconds_since_last_spoke=5)).blocked_by, "cooldown")


if __name__ == "__main__":
    unittest.main()
