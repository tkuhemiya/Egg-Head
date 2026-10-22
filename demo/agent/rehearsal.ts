/**
 * pi extension for rehearsals without Bedrock: a "rehearsal/scripted" model that does what
 * the real model is asked to do (run an `aws` command or two, then `egghead report|answer`),
 * picked by rules from the task text. pi itself, its terminal UI, the bash tool, the stand-in
 * AWS CLI and the report path are all real; only the model's choices are scripted.
 *
 *   npm run demo -- --rehearsal          # also scripts Decider and stands in for the voices
 */
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai"
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import { readFileSync } from "node:fs"

const world = JSON.parse(readFileSync(new URL("../../data/world.json", import.meta.url), "utf8")) as {
  checks: Record<string, Record<string, { status: string; evidence: string }>>
}

const COMMANDS: Record<string, (r: string) => string> = {
  db_health: (r) =>
    `aws cloudwatch get-metric-statistics --namespace AWS/RDS --metric-name CPUUtilization --dimensions Name=DBInstanceIdentifier,Value=${r} --start-time now-15m --period 300 --statistics Average --query 'Datapoints[].[Timestamp,Average]' --output text && aws cloudwatch describe-alarms --state-value ALARM --query 'MetricAlarms[].[AlarmName,StateValue]' --output text`,
  service_error_rate: (r) =>
    `aws cloudwatch get-metric-statistics --namespace AWS/ApplicationELB --metric-name HTTPCode_Target_5XX_Count --dimensions Name=LoadBalancer,Value=${r} --start-time now-15m --period 300 --statistics Sum --output text`,
  latency_p99: (r) =>
    `aws cloudwatch get-metric-statistics --namespace AWS/ApplicationELB --metric-name TargetResponseTime --dimensions Name=LoadBalancer,Value=${r} --start-time now-15m --period 300 --extended-statistics p99 --output text`,
  recent_deploys: (r) =>
    `aws ecs describe-services --cluster prod --services ${r} --query 'services[0].events[].message' --output text`,
  queue_depth: (r) =>
    `aws sqs get-queue-attributes --queue-url $(aws sqs get-queue-url --queue-name ${r} --query QueueUrl --output text) --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible`,
  alarm_state: () => `aws cloudwatch describe-alarms --state-value ALARM --query 'MetricAlarms[].[AlarmName,StateReason]' --output text`
}

const RESOURCES: Array<[string, RegExp]> = [
  ["orders-db", /orders[- ]?(db|database)/i],
  ["payments-db", /payments[- ]?(db|database)/i],
  ["checkout-queue", /queue/i],
  ["orders-api", /orders/i],
  ["payments-api", /payments?/i],
  ["auth-service", /auth/i]
]
const CHECK_WORDS: Array<[string, RegExp]> = [
  ["recent_deploys", /deploy|push|release|v\d|went out|ship/i],
  ["queue_depth", /queue|backed up|backlog/i],
  ["latency_p99", /slow|latency|p99/i],
  ["db_health", /cpu|database|\bdb\b/i],
  ["service_error_rate", /error|500|5xx|fail|throw/i]
]

const plan = (task: string) => {
  const id = /Task (\d+)/.exec(task)?.[1] ?? "0"
  const quoted = /"([^"]+)"/.exec(task)?.[1] ?? task
  const resource = RESOURCES.find(([, p]) => p.test(quoted))?.[0] ?? "orders-api"
  const checks = world.checks[resource] ?? {}
  const check = CHECK_WORDS.find(([c, p]) => p.test(quoted) && checks[c])?.[0] ?? Object.keys(checks)[0] ?? "alarm_state"
  const hit = checks[check] ?? { status: "healthy", evidence: "no alarms in ALARM" }
  const command = COMMANDS[check]!(resource)
  const fact = `${resource.replace(/-/g, " ")}: ${hit.evidence}`.replace(/"/g, "'")
  const finish = /\bverify\b/i.test(task)
    ? `egghead report ${id} --status ${hit.status} --fact "${fact}"`
    : `egghead answer ${id} "${fact}."`
  return { resource, command, finish }
}

let call = 0
const id = () => `call_${Date.now()}_${call++}`
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export default function(pi: ExtensionAPI) {
  pi.registerProvider("rehearsal", {
    name: "Rehearsal (scripted)",
    baseUrl: "http://localhost:0",
    apiKey: "rehearsal",
    api: "rehearsal-scripted",
    models: [{
      id: "scripted",
      name: "scripted rehearsal model",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 4096
    }],
    streamSimple: (model, context) => {
      const stream = createAssistantMessageEventStream()
      void (async () => {
        const messages = context.messages
        const lastUser = messages.map((m) => m.role).lastIndexOf("user")
        const task = messages[lastUser]
        const text = typeof task?.content === "string" ? task.content : (task?.content ?? []).map((b: any) => b.text ?? "").join("")
        const step = messages.slice(lastUser + 1).filter((m) => m.role === "toolResult").length
        const p = plan(text)
        const content: Array<any> = step === 0
          ? [{ type: "text", text: `Checking ${p.resource} with the AWS CLI.` }, { type: "toolCall", id: id(), name: "bash", arguments: { command: p.command } }]
          : step === 1
          ? [{ type: "toolCall", id: id(), name: "bash", arguments: { command: p.finish } }]
          : [{ type: "text", text: "Reported to Egg Head." }]
        const message: any = {
          role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage,
          stopReason: content.some((b) => b.type === "toolCall") ? "toolUse" : "stop", timestamp: Date.now()
        }
        await sleep(700 + Math.random() * 600) // a cheap model's time to first token
        stream.push({ type: "start", partial: { ...message } })
        content.forEach((block, i) => {
          message.content = [...message.content, block]
          if (block.type === "text") {
            stream.push({ type: "text_start", contentIndex: i, partial: { ...message } })
            stream.push({ type: "text_delta", contentIndex: i, delta: block.text, partial: { ...message } })
            stream.push({ type: "text_end", contentIndex: i, content: block.text, partial: { ...message } })
          } else {
            stream.push({ type: "toolcall_start", contentIndex: i, partial: { ...message } })
            stream.push({ type: "toolcall_delta", contentIndex: i, delta: JSON.stringify(block.arguments), partial: { ...message } })
            stream.push({ type: "toolcall_end", contentIndex: i, toolCall: block, partial: { ...message } })
          }
        })
        stream.push({ type: "done", reason: message.stopReason, message })
        stream.end(message)
      })()
      return stream
    }
  })
}
