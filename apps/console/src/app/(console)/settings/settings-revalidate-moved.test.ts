import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

test("password and session actions refresh the moved sign-in page, not only /settings", () => {
  for (const file of ["./owner-password-actions.ts", "./owner-sessions-actions.ts"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8")
    const calls = source.match(/revalidatePath\([^)]*\)/g) ?? []
    assert.ok(calls.length > 0, `${file} has no revalidatePath call`)
    for (const call of calls) assert.match(call, /revalidatePath\("\/settings", "layout"\)/, `${file}: ${call}`)
  }
})
