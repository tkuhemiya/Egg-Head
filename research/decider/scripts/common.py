"""State renderers and question banks shared by the experiments."""
import json, os, re
from lib import ROOT
W = json.load(open(os.path.join(ROOT, "data/source/world.json")))
RES = W["resources"]
CHECKS = {"db_health": "Database health: CPU, connections and alarm state for a database",
          "service_error_rate": "Error rate (5xx) of a service or API, including whether it is up or down",
          "latency_p99": "Latency / response time (p99) of a service or API",
          "recent_deploys": "Recent deploys, releases or config changes to a service",
          "alarm_state": "Which CloudWatch alarms are currently firing",
          "queue_depth": "Backlog / number of waiting messages in a queue"}
HEAD = "Live group call. The AI assistant on the call is named Egg Head."

def turns(item, window):
    t = item["context"][-(window - 1):] if window > 1 else []
    return t + [item["latest"]]

def render(item, fmt="tagged", window=6, pause=False, ledger=False):
    ts = turns(item, window)
    if fmt == "raw":
        s = "\n".join(f"{x['speaker']}: {x['text']}" for x in ts)
    elif fmt == "tagged":
        lines = [HEAD, "Transcript (oldest first):"]
        for i, x in enumerate(ts):
            lines.append(("LATEST >>> " if i == len(ts) - 1 else "") + f"{x['speaker']}: {x['text']}")
        s = "\n".join(lines)
    elif fmt == "kv":
        prev = " | ".join(f"{x['speaker']}: {x['text']}" for x in ts[:-1]) or "(none)"
        s = (f"setting: live group call; AI assistant name: Egg Head\nprevious_turns: {prev}\n"
             f"latest_speaker: {ts[-1]['speaker']}\nlatest_utterance: {ts[-1]['text']}")
    if pause:
        s += f"\nSilence since the latest speaker stopped: {item['pause_s']:.1f} s"
    if ledger and item.get("ledger"):
        s += "\nFlagged claim (checked by Egg Head, not yet raised): " + "; ".join(
            f"{l['speaker']} said \"{l['claim']}\"; live check shows {l['evidence']}" for l in item["ledger"])
    return s

# --- question wording banks -------------------------------------------------
CLAIM_Q = {
 "repo": "Is the LATEST utterance a factual statement about how a system is behaving right now, or about a recent deploy or change? Guesses, questions, plans, actions, and statements about the past are not. Ignore earlier turns except to resolve references.",
 "short": "Does the latest speaker state a fact about the current state of a computer system or service?",
 "examples": "Does the latest utterance assert the current state of a system, service, metric or recent deploy? Yes: 'orders-db CPU is pegged', 'we didn't deploy today'. No: 'maybe it's the DB', 'I'll restart the pods', 'yesterday it was fine', 'can you check the queue?'.",
}
ADDR_Q = {
 "repo": "Is the LATEST utterance addressed to Egg Head, the AI assistant, rather than to the humans on the call?",
 "short": "Is the latest speaker talking to the AI assistant?",
 "examples": "Is the latest utterance a request or question for the AI assistant (Egg Head, 'the bot', 'the assistant')? A question to a named person or to the group is not.",
}
FIN_Q = {
 "repo": "Has the latest speaker finished their turn, so that someone else could start talking now?",
 "short": "Is the latest utterance a complete thought?",
 "examples": "Has the latest speaker finished? Unfinished: trailing words like 'and then', 'because if', 'the thing is that'. Finished: a complete sentence or question.",
}
INT_Q = {
 "repo": "Would speaking right now interrupt someone in the middle of a sentence or an argument?",
}
UTYPES = {"claim": "A statement of fact about the current state of a system, service, metric or recent deploy",
          "request_agent": "A request or question addressed to the AI assistant Egg Head",
          "question_humans": "A question or request for the other people on the call",
          "correction": "Says something said earlier was wrong, or questions whether it is right",
          "plan_action": "Says what someone will do or is doing",
          "guess": "A guess, hunch or possibility, not a statement of fact",
          "past": "About how things were in the past",
          "chitchat": "Small talk, thanks, agreement, logistics",
          "other": "Unfinished, an opinion, or none of these"}

ALIAS = {"orders-db": [r"orders[- ]?db", r"orders database"], "payments-db": [r"payments[- ]?db", r"payments database"],
         "orders-api": [r"orders[- ]?api", r"orders api"], "payments-api": [r"payments[- ]?api", r"payments api"],
         "checkout-queue": [r"checkout[- ]?queue", r"checkout queue"], "auth-service": [r"\bauth\b", r"auth service"]}
def alias_hits(text):
    s = text.lower()
    return [r for r, ps in ALIAS.items() if any(re.search(p, s) for p in ps)]

def gold_route(it):
    l = it["labels"]
    if l["is_claim"] and l["check"] and l["resource"] and l["resource"] != "unknown":
        return (l["check"], l["resource"])
    return None
