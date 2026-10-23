"""Build the frozen labelled dataset (author-made labels). Run once; do not edit after tuning starts.

Sources:
- data/source/egghead_*.jsonl: the 66 snippets from the Egg-Head repo (labels by the repo author).
- Generated incident-call lines from templates over the Egg-Head scenario world (data/source/world.json).
- Hand-written AMI-style design-meeting lines (written for this set, in the style of AMI
  scenario meetings; not copied from the AMI corpus).
Split: 50/50 dev/held-out, stratified by kind, seed 20261021.
"""
import json, random, os
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
W = json.load(open(os.path.join(ROOT, "data/source/world.json")))
rng = random.Random(20261021)
AGENT = "Egg Head"
PEOPLE = ["Priya", "Sam", "Lee", "Jordan", "Mei"]

OPENER = [("Priya", "Okay, checkout is failing for about a third of users. What are we seeing?"),
          ("Jordan", "Orders API is throwing a lot of 500s."),
          ("Mei", "I'm on the dashboards now, give me a sec."),
          ("Sam", "Payments looks quiet from my side."),
          ("Priya", "Let's go service by service."),
          ("Lee", "I've got the queue metrics open.")]

def ctx(n):
    return [{"speaker": s, "text": t} for s, t in OPENER[:n]]

STATUS = {r: {c: v["status"] for c, v in cs.items()} for r, cs in W["checks"].items()}
NAMES = {"orders-db": ["orders-db", "the orders database"], "payments-db": ["payments-db", "the payments database"],
         "orders-api": ["orders-api", "the orders API"], "payments-api": ["payments-api", "the payments API"],
         "checkout-queue": ["the checkout queue", "checkout-queue"], "auth-service": ["auth", "the auth service"]}
# (check, asserted) -> phrasings; {r} = resource name
PHR = {
 ("db_health", "healthy"): ["{r} is fine, CPU's normal.", "{r} looks healthy to me.", "Nothing wrong with {r}, connections are normal."],
 ("db_health", "degraded"): ["{r} CPU is pegged.", "{r} is struggling, connections are maxed.", "{r} is really slow right now."],
 ("service_error_rate", "healthy"): ["Error rate on {r} is flat.", "{r} isn't throwing errors, 5xx is basically zero.", "{r} errors are back to normal."],
 ("service_error_rate", "degraded"): ["{r} is throwing a lot of 500s.", "5xx on {r} is way up.", "{r} is erroring badly."],
 ("service_error_rate", "down"): ["{r} is completely down, nothing is getting through.", "{r} is hard down."],
 ("latency_p99", "healthy"): ["Latency on {r} is fine.", "{r} p99 is normal, a few hundred ms."],
 ("latency_p99", "degraded"): ["p99 on {r} is way up, like four seconds.", "{r} is super slow, latency spiked."],
 ("recent_deploys", "changed"): ["{r} had a release about forty minutes ago.", "We shipped a new version of {r} today."],
 ("recent_deploys", "unchanged"): ["We didn't deploy {r} today.", "Nothing has gone out to {r} this week."],
 ("queue_depth", "healthy"): ["{r} is basically empty.", "Queue depth on {r} is normal, around fifty."],
 ("queue_depth", "degraded"): ["{r} is backing up, huge backlog.", "There are thousands of messages stuck in {r}."],
 ("alarm_state", "healthy"): ["No alarms are firing on {r}.", "{r} alarms are all green."],
 ("alarm_state", "degraded"): ["There's an alarm firing on {r}.", "{r} has an alarm in ALARM."],
}
def truth(check, asserted, res):
    st = STATUS.get(res, {}).get(check)
    if st is None: return None
    if asserted in ("healthy", "unchanged"): return st in ("healthy", "unchanged")
    if asserted == "down": return st == "down"
    return st in ("degraded", "down", "changed")

items = []
def add(kind, turns, latest, labels, pause=0.8, ledger=None, source="gen", note=""):
    items.append({"kind": kind, "source": source, "note": note, "context": turns,
                  "latest": latest, "pause_s": pause, "ledger": ledger or [], "labels": labels})

def L(**k):
    base = {"utt_type": None, "is_claim": False, "addressed_agent": False, "resource": None, "check": None,
            "asserted": None, "claim_true": None, "turn_finished": True, "would_interrupt": False,
            "self_repaired": None, "should_speak": None}
    base.update(k); return base

# 1. claims about system state (explicit resource)
for (check, asserted), phs in PHR.items():
    for res in W["checks"]:
        if check not in W["checks"][res]: continue
        for ph in phs:
            if rng.random() < 0.45: continue
            name = rng.choice(NAMES[res]); text = ph.format(r=name)
            text = text[0].upper() + text[1:]
            add("claim", ctx(rng.randint(1, 5)), {"speaker": rng.choice(PEOPLE), "text": text},
                L(utt_type="claim", is_claim=True, resource=res, check=check, asserted=asserted,
                  claim_true=truth(check, asserted, res)), pause=round(rng.uniform(0.3, 1.5), 1))
# 2. claims that need context to resolve the resource (pronoun)
for res, check, asserted, lead, ph in [
    ("orders-db", "db_health", "healthy", "Let's look at the orders database first.", "It's fine, CPU is normal."),
    ("payments-db", "db_health", "healthy", "What about the payments database?", "Its CPU is around twenty percent, it's healthy."),
    ("checkout-queue", "queue_depth", "degraded", "Can someone look at the checkout queue?", "It's got twelve thousand messages sitting there."),
    ("orders-api", "recent_deploys", "unchanged", "Did orders-api change today?", "No, nothing went out to it."),
    ("payments-api", "service_error_rate", "healthy", "How's the payments API doing?", "Errors are flat, it's fine."),
    ("auth-service", "service_error_rate", "down", "Is auth okay?", "No, it's totally down."),
    ("orders-api", "latency_p99", "degraded", "Look at orders-api latency.", "Yeah it's way up, four seconds at p99."),
    ("orders-db", "db_health", "degraded", "Mei, you have the orders database open?", "Yeah, it's pegged at ninety-eight percent."),
]:
    add("claim_context", ctx(2) + [{"speaker": "Priya", "text": lead}], {"speaker": rng.choice(PEOPLE[1:]), "text": ph},
        L(utt_type="claim", is_claim=True, resource=res, check=check, asserted=asserted, claim_true=truth(check, asserted, res)))
# 3. claims with an ambiguous resource
for text, check, asserted in [("The database looks healthy.", "db_health", "healthy"), ("The API is fine.", "service_error_rate", "healthy"),
                              ("Everything's green on the dashboard.", "alarm_state", "healthy"), ("Customers are seeing errors at checkout.", "service_error_rate", "degraded"),
                              ("The DB is slow.", "db_health", "degraded"), ("No deploys went out today.", "recent_deploys", "unchanged")]:
    add("claim_ambiguous", ctx(2), {"speaker": rng.choice(PEOPLE), "text": text},
        L(utt_type="claim", is_claim=True, resource="unknown", check=check, asserted=asserted))
# 4. requests addressed to the agent
REQ = [("Egg Head, what's the error rate on orders-api?", "orders-api", "service_error_rate"),
       ("Hey Egg Head, can you check the orders database?", "orders-db", "db_health"),
       ("Egg Head, did anything deploy to payments-api this week?", "payments-api", "recent_deploys"),
       ("Egg Head, how deep is the checkout queue?", "checkout-queue", "queue_depth"),
       ("Egg Head, which alarms are firing?", "unknown", "alarm_state"),
       ("Can you pull p99 for orders-api, Egg Head?", "orders-api", "latency_p99"),
       ("Egg Head, is auth healthy?", "auth-service", "service_error_rate"),
       ("Egg Head, summarise what we know so far.", None, None),
       ("Egg Head, give us a quick recap.", None, None),
       ("Egg Head, what did Sam say about the database?", None, None),
       ("Bot, what's the CPU on payments-db?", "payments-db", "db_health"),
       ("Hey assistant, any alarms on orders-api?", "orders-api", "alarm_state"),
       ("Egg Head, start the incident timeline please.", None, None),
       ("Egg Head, can you post the status in the channel?", None, None),
       ("Egg Head, what's the latest deploy on orders-api?", "orders-api", "recent_deploys"),
       ("Egg Head, keep quiet unless it's urgent.", None, None),
       ("Egg Head, are you there?", None, None),
       ("Egg Head, how long has the orders-db alarm been on?", "orders-db", "alarm_state"),
       ("Egg Head, is the payments API slow?", "payments-api", "latency_p99"),
       ("Egg Head, can you double check what Lee just said?", None, None),
       ("Quick one for the bot: is checkout-queue still backed up?", "checkout-queue", "queue_depth"),
       ("Egg Head, what should we look at next?", None, None),
       ("Egg Head, mute yourself for a bit.", None, None),
       ("Egg Head, read out the error rates for both APIs.", None, None),
       ("Egg Head, did payments-db have any alarms today?", "payments-db", "db_health")]
for text, res, check in REQ:
    add("request_agent", ctx(rng.randint(1, 4)), {"speaker": rng.choice(PEOPLE), "text": text},
        L(utt_type="request_agent", addressed_agent=True, resource=res, check=check))
# 5. questions to humans (incl. ones that name a person)
QH = ["Mei, can you check the orders database?", "Sam, what are you seeing on payments?", "Has anyone looked at the queue yet?",
      "Who owns the payments runbook?", "Jordan, did you deploy anything today?", "Lee, how deep is the checkout queue?",
      "Does anyone know when the alarm started?", "Priya, should we page the database team?", "Can someone share their screen?",
      "What's the error rate on orders-api, anyone?", "Sam, is auth in the checkout path?", "Who's on call for payments?",
      "Mei, how sure are you about that?", "Are we rolling back or not?", "Jordan, can you pull the deploy log?",
      "Anyone seeing errors on login?", "Lee, what was the queue depth an hour ago?", "Should we open a status page incident?",
      "Did someone restart the pods already?", "Priya, do you want me to take notes?"]
for t in QH:
    add("question_humans", ctx(rng.randint(1, 4)), {"speaker": rng.choice(PEOPLE), "text": t}, L(utt_type="question_humans"))
# 6. corrections / self-repairs (current state, so they are claims too)
COR = [("Wait, no, orders-db CPU is at ninety-eight, it's not fine.", "orders-db", "db_health", "degraded"),
       ("Actually I was wrong, orders-api did get a deploy, 2.14 went out.", "orders-api", "recent_deploys", "changed"),
       ("Sorry, that was staging. Prod checkout-queue has twelve thousand messages.", "checkout-queue", "queue_depth", "degraded"),
       ("Hold on, the orders-api 5xx graph just spiked again.", "orders-api", "service_error_rate", "degraded"),
       ("Correction, payments-api errors are fine, I misread the graph.", "payments-api", "service_error_rate", "healthy"),
       ("No wait, auth is up, I had the wrong tab.", "auth-service", "service_error_rate", "healthy"),
       ("Scratch that, payments-db is healthy, twenty percent CPU.", "payments-db", "db_health", "healthy"),
       ("I take it back, orders-api latency is still four seconds.", "orders-api", "latency_p99", "degraded")]
for t, res, check, a in COR:
    add("correction", ctx(3), {"speaker": rng.choice(PEOPLE), "text": t},
        L(utt_type="correction", is_claim=True, resource=res, check=check, asserted=a, claim_true=truth(check, a, res)))
for t in ["Hmm, are you sure about that?", "That doesn't match what I'm seeing.", "Wait, let me recheck that.", "I don't think that's right.",
          "Hold on, how sure are you?", "Sorry, I misread that."]:
    add("correction_noclaim", ctx(3), {"speaker": rng.choice(PEOPLE), "text": t}, L(utt_type="correction"))
# 7. plans / actions
for t in ["I'm restarting the orders-api pods now.", "Let me pull the logs from the pod.", "I'll get the rollback ready.",
          "I'm going to scale the API to twenty pods.", "Let's page the database on-call.", "I'll check the load balancer.",
          "Let's roll back orders-api to 2.13.", "I'm opening a status page incident.", "I'll write up the timeline.",
          "Let's wait for the build, then roll back.", "I'm failing over to the replica.", "Let me look at the slow query log.",
          "I'll ping the payments team.", "We should drain the queue after the rollback.", "I'm going to bump the connection pool."]:
    add("plan", ctx(rng.randint(1, 5)), {"speaker": rng.choice(PEOPLE), "text": t}, L(utt_type="plan_action"))
# 8. chit-chat / logistics
for t in ["Sorry, my dog is barking, one sec.", "Can someone mute? There's an echo.", "Thanks Mei.", "Good, noted.",
          "Anyone want coffee while we wait?", "Can you hear me okay?", "My internet is a bit choppy.", "Haha, classic Friday.",
          "Okay, cool.", "Give me a minute, I'm switching laptops."]:
    add("chitchat", ctx(rng.randint(1, 5)), {"speaker": rng.choice(PEOPLE), "text": t}, L(utt_type="chitchat"))
# 9. guesses / hedges and past state
for t in ["Maybe it's the database? Just a hunch.", "Could be auth acting up again.", "My gut says it's the new release.",
          "It might be the queue, I haven't looked.", "I wonder if payments is involved.", "Probably a bad config push, but who knows."]:
    add("guess", ctx(rng.randint(1, 4)), {"speaker": rng.choice(PEOPLE), "text": t}, L(utt_type="guess"))
for t in ["Yesterday the queue was totally fine.", "Last week orders-db had the same CPU spike.", "This happened in March too.",
          "Before the migration payments was always slow."]:
    add("past", ctx(rng.randint(1, 4)), {"speaker": rng.choice(PEOPLE), "text": t}, L(utt_type="past"))
# 10. unfinished turns (end-of-turn experiment); pause short
for t in ["So I think the problem is", "If we roll back orders-api then", "No, listen, it's not the queue, because if the queue were",
          "The thing about the database is that", "So my plan is we scale the API and then, uh,", "But you said an hour ago that",
          "I'm looking at the graph and it's", "Okay so the error rate on orders is", "We could also try", "Let me just say that the"]:
    add("unfinished", ctx(rng.randint(2, 5)), {"speaker": rng.choice(PEOPLE), "text": t},
        L(utt_type="plan_action" if t.startswith(("So my plan", "We could", "If we")) else "other", turn_finished=False, would_interrupt=True),
        pause=round(rng.uniform(0.1, 0.6), 1))
# 11. AMI-style design meeting (multi-party, no system state)
AMI_CTX = [("Project Manager", "Okay, so today is the conceptual design meeting for the remote control."),
           ("Industrial Designer", "I looked at the case materials, plastic or rubber."),
           ("Marketing", "Our research says people want it to look fancy."),
           ("User Interface", "And fewer buttons, people lose the remote all the time.")]
AMI = [("Marketing", "Young people really care about the look and feel.", "claim_opinion", False, True),
       ("Project Manager", "Can the assistant note that we chose the rubber case?", "request_agent", True, True),
       ("User Interface", "What do you think about a scroll wheel?", "question_humans", False, True),
       ("Industrial Designer", "I'll send the cost spreadsheet after the meeting.", "plan_action", False, True),
       ("Project Manager", "Egg Head, what did we decide last meeting?", "request_agent", True, True),
       ("Marketing", "Twelve euro fifty is the target price, right?", "question_humans", False, True),
       ("User Interface", "Yeah, I agree.", "chitchat", False, True),
       ("Industrial Designer", "The battery could be solar, but then", "other", False, False),
       ("Project Manager", "Let's move on to the next item on the agenda.", "plan_action", False, True),
       ("Marketing", "Sorry, I was wrong, it's twenty-five euro, not twelve fifty.", "correction", False, True),
       ("User Interface", "Egg Head, how much time do we have left?", "request_agent", True, True),
       ("Industrial Designer", "Speech recognition is too expensive for this price.", "claim_opinion", False, True),
       ("Project Manager", "Does everyone agree on the yellow colour?", "question_humans", False, True),
       ("Marketing", "Hmm.", "chitchat", False, False),
       ("User Interface", "So the menu would be on the", "other", False, False),
       ("Project Manager", "Assistant, please write down the action items.", "request_agent", True, True),
       ("Industrial Designer", "I think kinetic power is the cheapest option.", "claim_opinion", False, True),
       ("Marketing", "Is it okay if I share my screen?", "question_humans", False, True),
       ("User Interface", "I'll mock up the button layout tonight.", "plan_action", False, True),
       ("Project Manager", "Egg Head, read back the decisions so far.", "request_agent", True, True),
       ("Industrial Designer", "Wait, the chip cost is higher than I said.", "correction", False, True),
       ("Marketing", "Ha, that's funny.", "chitchat", False, True),
       ("User Interface", "Who's presenting the prototype?", "question_humans", False, True),
       ("Project Manager", "Right, so the main points are, uh", "other", False, False),
       ("Marketing", "Egg Head, did anyone mention the target group?", "request_agent", True, True),
       ("Industrial Designer", "Rubber is more expensive than plastic.", "claim_opinion", False, True),
       ("User Interface", "We should test it with older users.", "plan_action", False, True),
       ("Project Manager", "Could you check the budget, Marketing?", "question_humans", False, True),
       ("Marketing", "Sure.", "chitchat", False, True),
       ("Industrial Designer", "Can the meeting assistant tell us the cost limit?", "request_agent", True, True),
       ("User Interface", "The LCD screen would let us drop", "other", False, False),
       ("Project Manager", "Okay, five minutes left.", "chitchat", False, True),
       ("Marketing", "Fashion trends say fruit and vegetable shapes are in.", "claim_opinion", False, True),
       ("Industrial Designer", "Do we need a docking station?", "question_humans", False, True),
       ("User Interface", "Egg Head, stop taking notes for a minute.", "request_agent", True, True),
       ("Project Manager", "I'll send the minutes by email.", "plan_action", False, True),
       ("Marketing", "Actually no, I meant the younger group, not the older one.", "correction", False, True),
       ("Industrial Designer", "And if we use the double curved case then the", "other", False, False),
       ("User Interface", "Priya, sorry, Project Manager, can I add one thing?", "question_humans", False, True),
       ("Project Manager", "Assistant, are we over time?", "request_agent", True, True),
       ("Marketing", "Most people only use about ten percent of the buttons.", "claim_opinion", False, True),
       ("Industrial Designer", "Okay.", "chitchat", False, True),
       ("User Interface", "Should the logo be on the front?", "question_humans", False, True),
       ("Project Manager", "Let's vote on it now.", "plan_action", False, True),
       ("Marketing", "Egg Head, what was the price we agreed?", "request_agent", True, True),
       ("Industrial Designer", "The titanium option is out of budget.", "claim_opinion", False, True),
       ("User Interface", "So basically what I'm trying to", "other", False, False),
       ("Project Manager", "Does anyone have anything else?", "question_humans", False, True),
       ("Marketing", "I'll look up competitor prices.", "plan_action", False, True),
       ("User Interface", "Egg Head, can you remind us what the user research said?", "request_agent", True, True)]
for i, (spk, t, ty, addr, fin) in enumerate(AMI):
    n = rng.randint(1, 4)
    add("ami_style", [{"speaker": s, "text": x} for s, x in AMI_CTX[:n]], {"speaker": spk, "text": t},
        L(utt_type=ty, addressed_agent=addr, turn_finished=fin, would_interrupt=not fin),
        pause=round(rng.uniform(0.1, 0.5), 1) if not fin else round(rng.uniform(0.4, 2.0), 1), source="ami_style")
# 12. Egg-Head repo snippets (repo labels mapped)
for f in ["egghead_spike.jsonl", "egghead_heldout.jsonl"]:
    for l in open(os.path.join(ROOT, "data/source", f)):
        d = json.loads(l); lab = d["labels"]; tr = d["transcript"]
        chk = lab["which_check"] if lab["which_check"] not in (None, "none") else None
        res = lab["which_resource"] if lab["which_resource"] not in (None,) else None
        if res == "unknown" and not chk: res = None
        cat = d["category"]
        ty = {"true_claim": "claim", "false_claim": "claim", "self_correction": "correction", "guess": "guess", "question": "question_humans",
              "action": "plan_action", "chit_chat": "chitchat", "past_state": "past", "answered_question": "claim", "mid_argument": "other",
              "unclear_resource": "claim", "resolved_by_context": "claim", "hedged_claim": "claim", "unanswered_question": "plan_action"}.get(cat)
        add("repo_" + ("gate" if d["id"][0] in "sh" else "route"), tr[:-1], tr[-1],
            L(utt_type=ty, is_claim=bool(lab["is_claim"]), resource=res, check=chk, asserted=lab.get("asserted_state"),
              would_interrupt=(lab.get("floor_free") is False), turn_finished=cat != "mid_argument",
              self_repaired=lab.get("self_repaired"), should_speak=lab.get("should_speak")),
            pause=d["silence_s"], ledger=d["ledger"], source="egghead_repo:" + d["id"], note=cat)

# split 50/50 stratified by kind
by = {}
for it in items: by.setdefault(it["kind"], []).append(it)
for k, lst in sorted(by.items()):
    rng.shuffle(lst)
    for j, it in enumerate(lst): it["split"] = "dev" if j % 2 == 0 else "heldout"
for n, it in enumerate(items): it["id"] = f"x{n:03d}"
with open(os.path.join(ROOT, "data/dataset.jsonl"), "w") as f:
    for it in items: f.write(json.dumps(it) + "\n")
from collections import Counter
print(len(items), Counter(i["kind"] for i in items), Counter(i["split"] for i in items))
