#!/usr/bin/env bash
# AWS usage and estimated spend for Egg Head, from CloudWatch metrics (free to read; Cost
# Explorer is $0.01 per request and lags a day). Bedrock tokens per model, Polly characters.
# Transcribe streaming publishes no CloudWatch metrics: the audio scripts log their own seconds
# to spike/out/transcribe-seconds.log, which is summed here.
#
#   scripts/aws-usage.sh                    # since 00:00 UTC today
#   scripts/aws-usage.sh 2026-10-22T08:00Z  # since a time
#   watch -n 60 scripts/aws-usage.sh        # keep it on screen
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
SINCE="${1:-$(date -u +%Y-%m-%dT00:00:00Z)}"
NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
BUDGET_BEDROCK="${EGGHEAD_BUDGET_BEDROCK:-0.10}"
BUDGET_AUDIO="${EGGHEAD_BUDGET_AUDIO:-0.10}"

# USD per 1M tokens (input output). Bedrock on-demand, us-east-1; check the pricing page.
price() {
  case "$1" in
    nvidia.nemotron-nano-3-30b) echo "0.06 0.24" ;;
    nvidia.nemotron-nano-9b-v2) echo "0.06 0.23" ;;
    amazon.nova-micro-v1:0 | us.amazon.nova-micro-v1:0) echo "0.035 0.14" ;;
    amazon.nova-lite-v1:0 | us.amazon.nova-lite-v1:0) echo "0.06 0.24" ;;
    *) echo "" ;;
  esac
}

sum() { # namespace metric dimension-name dimension-value
  local start end period
  start=$(date -u -j -f %Y-%m-%dT%H:%M:%SZ "$SINCE" +%s 2>/dev/null || date -u -d "$SINCE" +%s)
  end=$(date -u +%s)
  period=$(( ( (end - start) / 60 + 1 ) * 60 ))
  aws cloudwatch get-metric-statistics --region "$REGION" --namespace "$1" --metric-name "$2" \
    --dimensions "Name=$3,Value=$4" --start-time "$SINCE" --end-time "$NOW" \
    --period "$period" --statistics Sum --query 'sum(Datapoints[].Sum)' --output text 2>/dev/null |
    awk '{ print ($1 == "None" || $1 == "") ? 0 : $1 }'
}

echo "AWS usage since $SINCE (region $REGION)"
echo
printf "%-32s %8s %10s %10s %10s\n" "Bedrock model" "calls" "in tok" "out tok" "est USD"
bedrock_total=0
models=$(aws cloudwatch list-metrics --region "$REGION" --namespace AWS/Bedrock --metric-name Invocations \
  --query 'Metrics[].Dimensions[?Name==`ModelId`].Value' --output text | tr '\t' '\n' | sort -u)
for m in $models; do
  calls=$(sum AWS/Bedrock Invocations ModelId "$m")
  [ "${calls%.*}" = "0" ] && continue
  tin=$(sum AWS/Bedrock InputTokenCount ModelId "$m")
  tout=$(sum AWS/Bedrock OutputTokenCount ModelId "$m")
  read -r pin pout <<<"$(price "$m") "
  if [ -n "$pin" ]; then
    usd=$(awk -v a="$tin" -v b="$tout" -v p="$pin" -v q="$pout" 'BEGIN { printf "%.5f", a * p / 1e6 + b * q / 1e6 }')
    bedrock_total=$(awk -v t="$bedrock_total" -v u="$usd" 'BEGIN { printf "%.5f", t + u }')
  else
    usd="(no price)"
  fi
  printf "%-32s %8.0f %10.0f %10.0f %10s\n" "$m" "$calls" "$tin" "$tout" "$usd"
done

chars=0
for op in SynthesizeSpeech StartSpeechSynthesisTask; do
  c=$(sum AWS/Polly RequestCharacters Operation "$op")
  chars=$(awk -v a="$chars" -v b="$c" 'BEGIN { print a + b }')
done
polly_usd=$(awk -v c="$chars" 'BEGIN { printf "%.5f", c * 16 / 1e6 }') # neural, before free tier

log="$(dirname "$0")/../spike/out/transcribe-seconds.log"
secs=$( [ -f "$log" ] && awk -v s="$SINCE" '$1 >= s { t += $2 } END { print t + 0 }' "$log" || echo 0)
transcribe_usd=$(awk -v s="$secs" 'BEGIN { printf "%.5f", s / 60 * 0.024 }') # tier 1, before free tier

echo
printf "%-32s %8.0f chars %25s\n" "Polly (neural, \$16/1M)" "$chars" "$polly_usd"
printf "%-32s %8.0f s %29s\n" "Transcribe streaming (\$0.024/min)" "$secs" "$transcribe_usd"
audio_total=$(awk -v a="$polly_usd" -v b="$transcribe_usd" 'BEGIN { printf "%.5f", a + b }')
echo
echo "Bedrock: \$$bedrock_total of \$$BUDGET_BEDROCK budget"
echo "Audio:   \$$audio_total of \$$BUDGET_AUDIO budget (worst case: ignores the free tier)"
awk -v b="$bedrock_total" -v B="$BUDGET_BEDROCK" -v a="$audio_total" -v A="$BUDGET_AUDIO" \
  'BEGIN { if (b > B || a > A) { print "OVER BUDGET"; exit 2 } }'
