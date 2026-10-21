import unittest

from egghead.bridge import Bridge
from egghead.checks import MockSource
from egghead.compare import compare, infer_asserted
from egghead.decider import ScriptedDecider
from egghead.router import route


def choice(name, p=0.9, options=7):
    return {"type": "choice", "choice": name, "probabilities": {name: p},
            "confidence": (options * p - 1) / (options - 1)}


def noul(p):
    return {"type": "noul", "noul": p}


def routed(check, resource, state, is_claim=0.85):
    return {"is_claim": noul(is_claim), "which_check": choice(check),
            "which_resource": choice(resource), "asserted_state": choice(state, options=6)}


def ignored():
    return routed("none", "unknown", "unclear", is_claim=0.1)


def policy(repaired=0.2, interrupt=0.2):
    return {"self_repaired": noul(repaired), "open_question": noul(0.1), "floor_free": noul(interrupt)}


class CompareTests(unittest.TestCase):
    def test_compare(self):
        self.assertEqual(compare("healthy", "degraded"), "contradicts")
        self.assertEqual(compare("unchanged", "changed"), "contradicts")
        self.assertEqual(compare("degraded", "degraded"), "supports")
        self.assertEqual(compare("unclear", "degraded"), "inconclusive")

    def test_infer_asserted_fallback(self):
        self.assertEqual(infer_asserted("We didn't deploy orders-api today."), "unchanged")
        self.assertEqual(infer_asserted("The DB is fine, it's the API."), "healthy")
        self.assertEqual(infer_asserted("Hmm, let me look."), "unclear")


class RouterTests(unittest.TestCase):
    def test_fire_escalate_ignore(self):
        self.assertEqual(route(routed("db_health", "orders-db", "healthy")).action, "check")
        mid = routed("db_health", "orders-db", "healthy")
        mid["which_resource"] = choice("orders-db", p=0.6)  # confidence ~0.53
        mid["which_resource"]["confidence"] = 0.6
        self.assertEqual(route(mid).action, "escalate")
        self.assertEqual(route(ignored()).action, "ignore")


class BridgeTests(unittest.TestCase):
    def run_call(self, script):
        bridge = Bridge(ScriptedDecider([a for _, _, _, a in script]), MockSource.load())
        return bridge, [bridge.hear(s, t, sil) for s, t, sil, _ in script]

    def test_catches_false_db_claim_and_speaks_in_gap(self):
        _, evs = self.run_call([
            ("Priya", "What are we seeing?", 0.5, ignored()),
            ("Sam", "The DB is fine, it's the API.", 0.4, routed("db_health", "orders-db", "healthy")),
            ("Priya", "Okay, let's focus on the API then.", 1.6, {**ignored(), **policy()}),
        ])
        self.assertEqual(evs[1].verdict, "contradicts")
        self.assertEqual(evs[1].gate.blocked_by, "persisted")
        self.assertIsNone(evs[1].said)
        self.assertIn("orders-db", evs[2].said)
        self.assertIn("98%", evs[2].said)

    def test_stays_silent_when_the_call_corrects_itself(self):
        bridge, evs = self.run_call([
            ("Sam", "The DB is fine, it's the API.", 0.4, routed("db_health", "orders-db", "healthy")),
            ("Lee", "Wait Sam, orders-db CPU is at ninety-eight.", 0.8,
             {**routed("db_health", "orders-db", "degraded"), **policy(repaired=0.3)}),
        ])
        self.assertIsNone(evs[1].said)
        self.assertEqual(evs[1].gate.repaired_by, "ledger")  # Lee's own true claim wins
        self.assertEqual(bridge.ledger.open(), [])

    def test_keyword_repair_when_router_misses_the_correction(self):
        bridge, evs = self.run_call([
            ("Sam", "The DB is fine, it's the API.", 0.4, routed("db_health", "orders-db", "healthy")),
            ("Mei", "Hold on, are you sure about that?", 0.9, {**ignored(), **policy()}),
        ])
        self.assertIsNone(evs[1].said)
        self.assertEqual(evs[1].gate.repaired_by, "keyword")
        self.assertEqual(bridge.ledger.open(), [])

    def test_waits_for_a_gap_then_speaks_on_silence_tick(self):
        bridge, evs = self.run_call([
            ("Sam", "The DB is fine, it's the API.", 0.4, routed("db_health", "orders-db", "healthy")),
            ("Jordan", "No, the API is just a symptom, the", 0.1, {**ignored(), **policy(interrupt=0.8)}),
        ])
        self.assertIsNone(evs[1].said)
        self.assertEqual(evs[1].gate.blocked_by, "min_silence")
        tick = bridge.tick(2.0)
        self.assertIsNotNone(tick.said)

    def test_true_claims_never_enter_the_ledger(self):
        bridge, evs = self.run_call([
            ("Mei", "Queue depth is huge.", 1.0, routed("queue_depth", "checkout-queue", "degraded")),
        ])
        self.assertEqual(evs[0].verdict, "supports")
        self.assertEqual(bridge.ledger.open(), [])

    def test_unclear_state_falls_back_to_wording(self):
        bridge, evs = self.run_call([
            ("Jordan", "We didn't deploy orders-api today.", 0.4,
             routed("recent_deploys", "orders-api", "unclear")),
        ])
        self.assertEqual(evs[0].verdict, "contradicts")

    def test_escalation_hands_the_utterance_to_bedrock_support(self):
        mid = routed("db_health", "orders-db", "healthy")
        mid["which_check"]["confidence"] = 0.6
        picked = route(routed("db_health", "orders-db", "healthy"))
        bridge = Bridge(ScriptedDecider([mid]), MockSource.load(), escalator=lambda turns: picked)
        ev = bridge.hear("Sam", "The DB is fine.", 0.4)
        self.assertEqual((ev.verdict, bridge.escalations), ("contradicts", 1))

    def test_escalations_are_counted(self):
        mid = routed("db_health", "orders-db", "healthy")
        mid["which_check"]["confidence"] = 0.6
        bridge, evs = self.run_call([("Sam", "The DB is fine.", 0.4, mid)])
        self.assertEqual((evs[0].route.action, bridge.escalations), ("escalate", 1))


if __name__ == "__main__":
    unittest.main()
