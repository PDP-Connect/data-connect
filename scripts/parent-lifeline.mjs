// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Exit when the desktop app that started this sidecar dies.
//
// The app gives each sidecar a stdin pipe that it never writes to and keeps
// the write end open for its own lifetime. The kernel closes that end when the
// app dies however it dies (SIGKILL, crash, Task Manager), so stdin reaching
// EOF means the parent is gone. This works on every OS; the kernel-level
// backstops (PR_SET_PDEATHSIG on Linux, a Job Object on Windows) cover the
// cases where this process is not running.
//
// Loaded with `node --import` by the staged launchers. Armed only when the
// supervisor sets PDPP_PARENT_LIFELINE=stdin, so servers started any other
// way (Docker, a terminal) are untouched.

const FLAG = "PDPP_PARENT_LIFELINE"
const HARD_EXIT_AFTER_MS = 5_000

if (process.env[FLAG] === "stdin") {
  // Do not leak the flag to processes this server starts.
  delete process.env[FLAG]

  let leaving = false
  const parentGone = () => {
    if (leaving) return
    leaving = true
    console.error("[parent-lifeline] parent closed stdin; shutting down")
    // Use the server's own SIGTERM handling for a clean shutdown, and exit
    // anyway if it does not finish.
    setTimeout(() => process.exit(1), HARD_EXIT_AFTER_MS).unref()
    process.kill(process.pid, "SIGTERM")
  }

  // A read error destroys the stream and emits close; do not crash on it.
  process.stdin.on("error", () => {})
  process.stdin.once("end", parentGone)
  process.stdin.once("close", parentGone)
  process.stdin.resume()
  // Watching stdin must not keep an otherwise finished server alive.
  process.stdin.unref?.()
}
