// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { fileURLToPath } from "node:url"

const HERE = fileURLToPath(new URL(".", import.meta.url))
const PAGE_CONTENT_RE = /<PrivacyContent \/>/
const SECTION_MAP_RE = /visibleSections\.map\(\(section\) =>/
const SECTION_RENDER_RE = /<Section\s+id=\{section\.id\}\s+key=\{section\.id\}\s+title=\{section\.title\}\s*>/
const ABOUT_PRIVACY_LINK_RE = /<Text[\s\S]*?as=\{Link\}[\s\S]*?href="\/privacy"[\s\S]*?>\s*Privacy\s*<\/Text>/
const PRIVACY_HREF_RE = /href="\/privacy"/g
const QUOTED_TEXT_RE = /"([^"\n]{12,})"/g
// RAISE-RULES 4: none of these words on screen outside a folded Details ("access token" is allowed).
const BANNED_WORDS_RE =
  /\b(?:grants?|bearer|scopes?|runs?|streams?|connectors?|manifests?|projection|cursor|trace|verdict|coverage|fleet|subscriptions?|OAuth|PKCE|JWKS)\b|(?<!access )\btokens?\b/i

test("the privacy page renders each required section", async () => {
  const [page, content] = await Promise.all([
    readFile(`${HERE}page.tsx`, "utf8"),
    readFile(`${HERE}privacy-content.tsx`, "utf8"),
  ])

  assert.match(page, PAGE_CONTENT_RE)
  for (const title of [
    "Where it keeps them",
    "Who can read your records",
    "What DataConnect sends out on its own",
    "What removing access does",
    "What we do not know yet",
  ]) {
    assert.ok(content.includes(`title: "${title}"`), `${title} must be rendered as a section`)
  }
  assert.match(content, SECTION_MAP_RE)
  assert.ok(content.includes('title: "What DataConnect keeps"'), "the keeps section stays in the data; the overview already says it")
  assert.match(content, SECTION_RENDER_RE)
})

test("the privacy page says removing app access cannot delete prior reads", async () => {
  const content = await readFile(`${HERE}privacy-content.tsx`, "utf8")
  assert.ok(content.includes("Removing an app’s access does not delete what the app already read."))
})

test("Settings About links to the privacy page once", async () => {
  const about = await readFile(`${HERE}../settings/about-section.tsx`, "utf8")
  assert.match(about, ABOUT_PRIVACY_LINK_RE)
  assert.equal((about.match(PRIVACY_HREF_RE) ?? []).length, 1)
})

test("the privacy page names the outbound calls a reviewer found missing", async () => {
  const content = await readFile(`${HERE}privacy-content.tsx`, "utf8")
  // Each sentence below is backed by a VERIFIED line in build/set5/FACTS.md (deputy additions).
  for (const sentence of [
    "Each time the desktop app starts, it checks GitHub Container Registry",
    "the desktop app loads the logo from logo.dev",
    "only if you turn on “Share anonymous usage & reliability data”",
    "downloads a search model from Hugging Face",
    "the server may get the app’s description and logo from the app’s own web address",
    "Some of these services, such as Cloudflare, can read the data in those requests.",
  ]) {
    assert.ok(content.includes(sentence), sentence)
  }
})

test("the privacy page uses no banned words on screen", async () => {
  const content = await readFile(`${HERE}privacy-content.tsx`, "utf8")
  const shown = [...content.matchAll(QUOTED_TEXT_RE)].map((match) => match[1] ?? "")
  assert.ok(shown.length > 20, "the page text was found")
  for (const text of shown) {
    assert.doesNotMatch(text, BANNED_WORDS_RE, text)
  }
})

// Round 9 (F1): a three-line overview opens the page, and the long vendor list folds under a visible heading.
test("the page opens with a three-line overview built from sentences the page already has", async () => {
  const content = await readFile(`${HERE}privacy-content.tsx`, "utf8")
  assert.match(content, /const overview = \[/)
  const lines = /const overview = \[([\s\S]*?)\] as const/.exec(content)?.[1] ?? ""
  assert.equal((lines.match(/^\s*"/gm) ?? []).length, 3)
  for (const line of lines.match(/"([^"\n]{12,})"/g) ?? []) {
    const text = line.slice(1, -1)
    assert.ok(content.split(text).length - 1 >= 2, `the overview line also stands in a section: ${text}`)
  }
  assert.match(content, /<PrivacyOverview \/>/)
})

test("the list of what is sent out folds under its visible heading", async () => {
  const content = await readFile(`${HERE}privacy-content.tsx`, "utf8")
  assert.match(content, /fold: true/)
  assert.match(content, /<details[^>]*>\s*<summary[^>]*>\{section\.title\}<\/summary>/)
})

// Round 10 (F45): the overview's sentences stand once on the page, not again in a section.
test("no sentence of the privacy page is said twice", async () => {
  const { renderToStaticMarkup } = await import("react-dom/server")
  const React = await import("react")
  ;(globalThis as { React?: unknown }).React = React
  const { PrivacyContent } = await import("./privacy-content.tsx")
  const html = renderToStaticMarkup(React.createElement(PrivacyContent))
  const sentences = [...html.matchAll(/<p[^>]*>([^<]{30,})<\/p>/g)].map((match) => match[1])
  assert.ok(sentences.length > 5)
  assert.deepEqual(sentences.filter((value, index) => sentences.indexOf(value) !== index), [])
  assert.match(html, /data-testid="privacy-overview"/)
})
