// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * In-page checks of the shared look. Runs in the browser through
 * `page.evaluate(auditLook)`, so it must not close over anything.
 * It reports candidates for a person to judge; it does not pass or fail.
 */
export function auditLook() {
  const limit = 12
  const canvas = document.createElement("canvas")
  canvas.width = canvas.height = 1
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!
  // The canvas parses every CSS colour form (oklch included) into sRGB.
  const rgba = (color: string): [number, number, number, number] => {
    ctx.clearRect(0, 0, 1, 1)
    ctx.fillStyle = "rgba(0,0,0,0)"
    ctx.fillStyle = color
    ctx.fillRect(0, 0, 1, 1)
    const d = ctx.getImageData(0, 0, 1, 1).data
    return [d[0], d[1], d[2], d[3] / 255]
  }
  const over = (top: number[], bottom: number[]) => {
    const a = top[3]
    return [0, 1, 2].map(i => top[i] * a + bottom[i] * (1 - a))
  }
  const luminance = (c: number[]) => {
    const [r, g, b] = c.map(v => {
      const s = v / 255
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
    })
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  const ratio = (a: number[], b: number[]) => {
    const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m)
    return (x + 0.05) / (y + 0.05)
  }
  const backdrop = (el: Element) => {
    const layers: number[][] = []
    for (let node: Element | null = el; node; node = node.parentElement) {
      const c = rgba(getComputedStyle(node).backgroundColor)
      if (c[3] > 0) layers.push(c)
      if (c[3] >= 1) break
    }
    let base = [255, 255, 255]
    for (const layer of layers.reverse()) base = over(layer, base)
    return base
  }
  const visible = (el: Element) => {
    const r = el.getBoundingClientRect()
    const s = getComputedStyle(el)
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && Number(s.opacity) > 0.05
  }
  const describe = (el: Element) => {
    const cls = typeof el.className === "string" ? el.className.split(/\s+/).filter(Boolean).slice(0, 3).join(".") : ""
    const text = (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 50)
    return `${el.tagName.toLowerCase()}${cls ? `.${cls}` : ""} "${text}"`
  }
  const ownText = (el: Element) =>
    [...el.childNodes].some(n => n.nodeType === Node.TEXT_NODE && (n.textContent ?? "").trim())

  const lowContrast: string[] = []
  const capitals: string[] = []
  const monospace: string[] = []
  const square: string[] = []
  const clipped: string[] = []
  const offscreen: string[] = []
  const all = [...document.body.querySelectorAll("*")]
  for (const el of all) {
    if (!visible(el)) continue
    const s = getComputedStyle(el)
    if (ownText(el)) {
      const fg = rgba(s.color)
      const bg = backdrop(el)
      const size = parseFloat(s.fontSize)
      const large = size >= 24 || (size >= 18.66 && Number(s.fontWeight) >= 700)
      const r = ratio(over(fg, bg), bg)
      if (r < (large ? 3 : 4.5) && !el.closest("[aria-hidden='true'],[disabled],[aria-disabled='true']"))
        lowContrast.push(`${r.toFixed(2)} ${size}px ${describe(el)}`)
      const text = (el.textContent ?? "").trim()
      if (s.textTransform === "uppercase" || s.fontVariantCaps.includes("small-caps") || /^[A-Z][A-Z ·•/&-]{5,}$/.test(text))
        capitals.push(describe(el))
      if (/mono/i.test(s.fontFamily) && !el.closest("code,pre,kbd,samp,details,.rr-kbd"))
        monospace.push(describe(el))
      if (/hidden|clip/.test(s.overflowX) && el.scrollWidth > el.clientWidth + 2 && s.textOverflow !== "ellipsis")
        clipped.push(describe(el))
    }
    const r = el.getBoundingClientRect()
    const bordered = ["Top", "Right", "Bottom", "Left"].every(
      side => parseFloat(s.getPropertyValue(`border-${side.toLowerCase()}-width`)) >= 1 &&
        rgba(s.getPropertyValue(`border-${side.toLowerCase()}-color`))[3] > 0.05
    )
    if (bordered && r.width >= 24 && r.height >= 20 && !["TABLE", "TD", "TH", "TR", "HR", "IMG", "svg"].includes(el.tagName)) {
      const corners = [s.borderTopLeftRadius, s.borderTopRightRadius, s.borderBottomLeftRadius, s.borderBottomRightRadius]
      if (corners.some(c => parseFloat(c) === 0)) square.push(`${corners.join(" ")} ${describe(el)}`)
    }
    if (r.right > window.innerWidth + 1 && r.width > 0) {
      let scroller = false
      for (let p = el.parentElement; p; p = p.parentElement)
        if (/auto|scroll/.test(getComputedStyle(p).overflowX)) { scroller = true; break }
      if (!scroller) offscreen.push(`${Math.round(r.right)}px ${describe(el)}`)
    }
  }
  const top = (list: string[]) => ({ count: list.length, sample: [...new Set(list)].slice(0, limit) })
  return {
    url: location.pathname + location.search,
    theme: document.documentElement.getAttribute("data-theme"),
    width: window.innerWidth,
    sidewaysScroll: document.documentElement.scrollWidth - window.innerWidth,
    lowContrast: top(lowContrast),
    capitals: top(capitals),
    monospace: top(monospace),
    squareBorderedBoxes: top(square),
    clippedText: top(clipped),
    pastRightEdge: top(offscreen),
  }
}
