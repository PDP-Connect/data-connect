// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { deflateSync } from "node:zlib"
import { describe, expect, it } from "vitest"
import { BLUE, RED, colorNear, decodePng, regionChanged, regionColor } from "./verify-private-display-cdp.mjs"

function crc32(buffer) {
  let crc = ~0
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return ~crc >>> 0
}

function chunk(type, body) {
  const out = Buffer.alloc(12 + body.length)
  out.writeUInt32BE(body.length, 0)
  out.write(type, 4, "latin1")
  body.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length)
  return out
}

// Encodes a width x height image of one colour, filtering row y with filters[y % filters.length].
function solidPng(width, height, color, { channels = 4, filters = [0] } = {}) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = channels === 4 ? 6 : 2
  const stride = width * channels
  const pixel = [...color, 255].slice(0, channels)
  const rows = []
  for (let y = 0; y < height; y++) {
    const filter = filters[y % filters.length]
    const line = Buffer.alloc(stride + 1)
    line[0] = filter
    for (let i = 0; i < stride; i++) {
      const left = i >= channels ? pixel[i % channels] : 0
      const up = y > 0 ? pixel[i % channels] : 0
      const upLeft = y > 0 && i >= channels ? pixel[i % channels] : 0
      const value = pixel[i % channels]
      const predictors = [0, left, up, (left + up) >> 1, paeth(left, up, upLeft)]
      line[i + 1] = (value - predictors[filter]) & 0xff
    }
    rows.push(line)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ])
}

function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

describe("decodePng", () => {
  it("decodes every filter type for RGBA and RGB", () => {
    for (const channels of [4, 3]) {
      const image = decodePng(solidPng(5, 5, [10, 200, 30], { channels, filters: [0, 1, 2, 3, 4] }))
      expect(image.width).toBe(5)
      expect(image.height).toBe(5)
      expect(regionColor(image, { x0: 0, x1: 1, y0: 0, y1: 1 })).toEqual([10, 200, 30])
    }
  })

  it("rejects data that is not a supported PNG", () => {
    expect(() => decodePng(Buffer.from("not a png"))).toThrow()
  })
})

describe("regionChanged", () => {
  const red = decodePng(solidPng(20, 20, RED))
  const blue = decodePng(solidPng(20, 20, BLUE))
  const black = decodePng(solidPng(20, 20, [0, 0, 0]))

  it("reports a colour flip as changed", () => {
    expect(regionChanged(red, blue)).toBe(true)
    expect(colorNear(regionColor(blue), BLUE)).toBe(true)
  })

  it("reports the same or an identical frame as unchanged (negative control)", () => {
    expect(regionChanged(red, red)).toBe(false)
    expect(regionChanged(red, decodePng(solidPng(20, 20, RED)))).toBe(false)
  })

  it("does not accept a black frame as the expected colour", () => {
    expect(colorNear(regionColor(black), BLUE)).toBe(false)
  })

  it("refuses to compare frames of different sizes", () => {
    expect(() => regionChanged(red, decodePng(solidPng(10, 10, RED)))).toThrow()
  })
})
