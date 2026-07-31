// Local protocol fixture for the published ChatGPT Collection Profile. It
// verifies the environment-based CDP compatibility seam, not a legacy
// Playwright page API or an invented START binding.
import readline from "node:readline"

readline.createInterface({ input: process.stdin }).on("line", line => {
  const start = JSON.parse(line)
  if ("bindings" in start || "browser" in start) {
    process.exitCode = 41
    return
  }
  if (!process.env.PDPP_CHATGPT_REMOTE_CDP_URL?.startsWith("http://127.0.0.1:")) {
    process.exitCode = 42
    return
  }
  process.stdout.write(
    `${JSON.stringify({ type: "INTERACTION", request_id: "chatgpt-login", kind: "browser", message: "Sign in to ChatGPT in the opened browser" })}\n`
  )
  process.stdout.write(
    `${JSON.stringify({ type: "PROGRESS", stream: "conversations", message: "Collecting ChatGPT conversations" })}\n`
  )
  process.stdout.write(
    `${JSON.stringify({ type: "RECORD", stream: "conversations", key: "fixture-conversation", data: { id: "fixture-conversation" }, emitted_at: "2026-07-31T00:00:00Z" })}\n`
  )
  process.stdout.write(
    `${JSON.stringify({ type: "DONE", status: "succeeded", records_emitted: 1 })}\n`
  )
})
