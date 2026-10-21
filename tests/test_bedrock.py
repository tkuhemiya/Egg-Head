import unittest
from types import SimpleNamespace

from strands.interventions.actions import Deny, Proceed

from egghead.bedrock import BedrockSupport, RouteChoice, SpeakGuard, check_tool
from egghead.checks import MockSource
from egghead.ledger import LedgerItem


class FakeAgent:
    def __init__(self, reply=None, structured=None):
        self.reply, self.structured = reply, structured
        self.prompts = []

    def __call__(self, prompt, **kw):
        self.prompts.append(prompt)
        if self.structured is not None:
            return SimpleNamespace(structured_output=self.structured)
        return self.reply


ITEM = LedgerItem("Sam", "The DB is fine", "db_health", "orders-db", "degraded",
                  "CPU 98% for the last 6 min; alarm OrdersDB-CPU in ALARM")


class GuardTests(unittest.TestCase):
    def test_closed_gate_denies_and_open_gate_proceeds(self):
        self.assertEqual(SpeakGuard(lambda: "min_silence").before_model_call(None),
                         Deny(reason="min_silence"))
        self.assertIsInstance(SpeakGuard(lambda: None).before_model_call(None), Proceed)


class SupportTests(unittest.TestCase):
    def test_write_prompts_with_evidence_and_counts_calls(self):
        agent = FakeAgent("Quick flag, orders-db CPU is 98%.")
        s = BedrockSupport(MockSource.load(), agent_factory=lambda *a: agent)
        self.assertEqual(s.write(ITEM), "Quick flag, orders-db CPU is 98%.")
        self.assertIn("CPU 98%", agent.prompts[0])
        self.assertEqual(s.calls["write"], 1)

    def test_route_accepts_only_known_checks_and_resources(self):
        good = RouteChoice(checkable=True, check="db_health", resource="orders-db", asserted="healthy")
        s = BedrockSupport(MockSource.load(), agent_factory=lambda *a: FakeAgent(structured=good))
        r = s.route([("Sam", "The DB is fine")])
        self.assertEqual((r.action, r.check, r.resource, r.asserted),
                         ("check", "db_health", "orders-db", "healthy"))
        bad = RouteChoice(checkable=True, check="made_up", resource="orders-db")
        s = BedrockSupport(MockSource.load(), agent_factory=lambda *a: FakeAgent(structured=bad))
        self.assertEqual(s.route([("Sam", "x")]).action, "ignore")

    def test_check_tool_runs_the_source(self):
        t = check_tool(MockSource.load())
        out = t("db_health", "orders-db")
        self.assertIn("degraded", out)
        self.assertIn("does not apply", t("queue_depth", "orders-db"))


if __name__ == "__main__":
    unittest.main()
