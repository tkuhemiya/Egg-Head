#!/usr/bin/env bash
# Model-check spec/Bridge.tla one property at a time; print PASS or the shortest counterexample.
# Usage: spec/check.sh [property ...]   (needs java; downloads tla2tools.jar once, or set TLA2TOOLS)
set -uo pipefail
cd "$(dirname "$0")"
JAR="${TLA2TOOLS:-$HOME/.cache/egghead/tla2tools.jar}"
if [ ! -f "$JAR" ]; then
  mkdir -p "$(dirname "$JAR")"
  curl -fsSL -o "$JAR" https://github.com/tlaplus/tlaplus/releases/download/v1.8.0/tla2tools.jar || { echo "could not download tla2tools.jar" >&2; exit 2; }
fi
SPEC="${SPEC:-Bridge}"
INVARIANTS="TypeOK NeverFirmOnUnconfirmed NeverSaysCorrected NeverSaysRightClaimIsWrong TentativeIsChecked ParkingIsScoped OneLinePerGap"
PROPERTIES="AckIsAnswered ConfirmedIsResolved"
WANT="${*:-$INVARIANTS $PROPERTIES}"
META="$(mktemp -d)"
trap 'rm -rf "$META"' EXIT
failed=0
for p in $WANT; do
  kind=INVARIANT
  case " $PROPERTIES " in *" $p "*) kind=PROPERTY ;; esac
  cfg="$META/$p.cfg"
  {
    echo "SPECIFICATION Spec"
    echo "CONSTANTS Claims = {c1, c2}  MaxTurns = ${MAX_TURNS:-3}"
    echo "$kind $p"
    echo "CHECK_DEADLOCK FALSE"
  } > "$cfg"
  out="$(java -XX:+UseParallelGC -cp "$JAR" tlc2.TLC -noGenerateSpecTE -workers auto -config "$cfg" -metadir "$META/m-$p" "$SPEC" 2>&1 | grep -v '^Picked up')"
  if grep -q "No error has been found" <<<"$out"; then
    echo "PASS  $p  ($(grep -o '[0-9,]* distinct states found' <<<"$out" | head -1))"
  else
    failed=1
    echo "FAIL  $p"
    grep -E '^State [0-9]+:|Back to state|violated' <<<"$out" | sed 's/ line [0-9].*//; s/^/      /'
  fi
done
exit $failed
