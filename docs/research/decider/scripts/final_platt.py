import json, math
PL = json.load(open("../results/exp6_platt_dev.json"))
def logit(p): p = min(max(p, 1e-4), 1 - 1e-4); return math.log(p / (1 - p))
def platt(name, p): a, b = PL[name]; return 1 / (1 + math.exp(-(a * logit(p) + b)))
