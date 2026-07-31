import { spawn } from "node:child_process"
const mode = process.argv[2]
const record = {
  type: "RECORD",
  stream: "items",
  key: "item-1",
  data: { id: "item-1", source_updated_at: "2026-07-30T00:00:00Z" },
  emitted_at: "2026-07-30T00:00:00Z",
}
const done = { type: "DONE", status: "succeeded", records_emitted: 1 }

const chunks = []
for await (const chunk of process.stdin) chunks.push(chunk)
const start = Buffer.concat(chunks).toString("utf8")
if (!start.includes('"type":"START"')) process.exit(71)

const emit = message => process.stdout.write(`${JSON.stringify(message)}\n`)
switch (mode) {
  case "success":
    process.stderr.write("fixture diagnostic\n")
    emit(record)
    emit({ type: "STATE", stream: "items", cursor: { cursor: "next" } })
    emit(done)
    break
  case "malformed":
    process.stdout.write("{not json\n")
    break
  case "duplicate-done":
    emit({ type: "DONE", status: "succeeded", records_emitted: 0 })
    emit({ type: "DONE", status: "succeeded", records_emitted: 0 })
    break
  case "missing-done":
    emit(record)
    break
  case "counter-mismatch":
    emit(record)
    emit({ type: "DONE", status: "succeeded", records_emitted: 2 })
    break
  case "undeclared-stream":
    emit({ ...record, stream: "other", data: { id: "item-1" } })
    break
  case "extra-field":
    emit({ ...record, data: { ...record.data, secret: "no" } })
    break
  case "wrong-resource":
    emit({ ...record, key: "item-2", data: { ...record.data, id: "item-2" } })
    break
  case "compound-key":
    emit({ ...record, key: ["user-1", "item-1"], data: { id: "item-1" } })
    emit(done)
    break
  case "events":
    emit({
      type: "PROGRESS",
      stream: "items",
      message: "working",
      count: 1,
      total: 1,
    })
    emit({
      type: "SKIP_RESULT",
      stream: "items",
      reason: "rate_limited",
      message: "retry later",
    })
    emit(record)
    emit(done)
    break
  case "interaction":
    emit({
      type: "INTERACTION",
      request_id: "login",
      kind: "credentials",
      message: "Log in",
    })
    break
  case "interaction-success":
    emit({
      type: "INTERACTION",
      request_id: "browser-login",
      kind: "browser",
      message: "Sign in in the opened browser",
    })
    emit(record)
    emit(done)
    break
  case "oversized-stdout":
    process.stdout.write(`${"x".repeat(128)}\n`)
    break
  case "invalid-utf8-stdout":
    process.stdout.write(Buffer.from([0xff, 0x0a]))
    break
  case "oversized-stderr":
    process.stderr.write(`${"e".repeat(128)}\n`)
    emit(record)
    emit(done)
    break
  case "two-records":
    emit(record)
    emit({ ...record, key: "item-1", data: { ...record.data } })
    emit({ type: "DONE", status: "succeeded", records_emitted: 2 })
    break
  case "failed-done":
    emit({ type: "DONE", status: "failed", records_emitted: 0 })
    process.exitCode = 2
    break
  case "cancelled-done":
    emit({ type: "DONE", status: "cancelled", records_emitted: 0 })
    process.exitCode = 2
    break
  case "nonzero-success":
    emit(record)
    emit(done)
    process.exitCode = 2
    break
  case "sleep":
    await new Promise(resolve => setTimeout(resolve, 5000))
    break
  case "grandchild-sleep": {
    const marker = process.argv[3]
    spawn(
      process.execPath,
      [
        "-e",
        `setTimeout(() => require('fs').writeFileSync(${JSON.stringify(marker)}, 'grandchild'), 200)`,
      ],
      { stdio: "ignore" }
    )
    await new Promise(resolve => setTimeout(resolve, 5000))
    break
  }
  default:
    process.exit(72)
}
