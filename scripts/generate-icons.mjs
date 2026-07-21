#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
/**
 * Generate all app icons from the source SVG.
 * Usage: node scripts/generate-icons.mjs
 * Requires: npm install sharp png-to-ico (dev deps)
 */
import { readFileSync, mkdirSync, writeFileSync, existsSync } from "fs"
import { execSync } from "child_process"
import { join, dirname } from "path"
import { fileURLToPath } from "url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, "..")
const iconsDir = join(root, "src-tauri", "icons")
const svgPath = join(iconsDir, "icon.svg")
const publicDir = join(root, "public")

async function main() {
  const sharp = (await import("sharp")).default

  const svgBuffer = readFileSync(svgPath)

  // All sizes needed for Tauri desktop icons
  const desktopSizes = [
    { name: "32x32.png", size: 32 },
    { name: "64x64.png", size: 64 },
    { name: "128x128.png", size: 128 },
    { name: "128x128@2x.png", size: 256 },
    { name: "icon.png", size: 512 },
  ]

  // Windows Store sizes
  const windowsSizes = [
    { name: "Square30x30Logo.png", size: 30 },
    { name: "Square44x44Logo.png", size: 44 },
    { name: "Square71x71Logo.png", size: 71 },
    { name: "Square89x89Logo.png", size: 89 },
    { name: "Square107x107Logo.png", size: 107 },
    { name: "Square142x142Logo.png", size: 142 },
    { name: "Square150x150Logo.png", size: 150 },
    { name: "Square284x284Logo.png", size: 284 },
    { name: "Square310x310Logo.png", size: 310 },
    { name: "StoreLogo.png", size: 50 },
  ]

  // iOS sizes
  const iosSizes = [
    { name: "ios/AppIcon-20x20@1x.png", size: 20 },
    { name: "ios/AppIcon-20x20@2x.png", size: 40 },
    { name: "ios/AppIcon-20x20@3x.png", size: 60 },
    { name: "ios/AppIcon-29x29@1x.png", size: 29 },
    { name: "ios/AppIcon-29x29@2x.png", size: 58 },
    { name: "ios/AppIcon-29x29@3x.png", size: 87 },
    { name: "ios/AppIcon-40x40@1x.png", size: 40 },
    { name: "ios/AppIcon-40x40@2x.png", size: 80 },
    { name: "ios/AppIcon-40x40@3x.png", size: 120 },
    { name: "ios/AppIcon-60x60@2x.png", size: 120 },
    { name: "ios/AppIcon-60x60@3x.png", size: 180 },
    { name: "ios/AppIcon-76x76@1x.png", size: 76 },
    { name: "ios/AppIcon-76x76@2x.png", size: 152 },
    { name: "ios/AppIcon-83.5x83.5@2x.png", size: 167 },
    { name: "ios/AppIcon-512@2x.png", size: 1024 },
  ]

  // Android sizes
  const androidSizes = [
    { name: "android/mipmap-mdpi/ic_launcher.png", size: 48 },
    { name: "android/mipmap-mdpi/ic_launcher_foreground.png", size: 108 },
    { name: "android/mipmap-mdpi/ic_launcher_round.png", size: 48 },
    { name: "android/mipmap-hdpi/ic_launcher.png", size: 72 },
    { name: "android/mipmap-hdpi/ic_launcher_foreground.png", size: 162 },
    { name: "android/mipmap-hdpi/ic_launcher_round.png", size: 72 },
    { name: "android/mipmap-xhdpi/ic_launcher.png", size: 96 },
    { name: "android/mipmap-xhdpi/ic_launcher_foreground.png", size: 216 },
    { name: "android/mipmap-xhdpi/ic_launcher_round.png", size: 96 },
    { name: "android/mipmap-xxhdpi/ic_launcher.png", size: 144 },
    { name: "android/mipmap-xxhdpi/ic_launcher_foreground.png", size: 324 },
    { name: "android/mipmap-xxhdpi/ic_launcher_round.png", size: 144 },
    { name: "android/mipmap-xxxhdpi/ic_launcher.png", size: 192 },
    { name: "android/mipmap-xxxhdpi/ic_launcher_foreground.png", size: 432 },
    { name: "android/mipmap-xxxhdpi/ic_launcher_round.png", size: 192 },
  ]

  const allSizes = [
    ...desktopSizes,
    ...windowsSizes,
    ...iosSizes,
    ...androidSizes,
  ]

  // Generate all PNGs
  for (const { name, size } of allSizes) {
    const outPath = join(iconsDir, name)
    const dir = dirname(outPath)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

    await sharp(svgBuffer, { density: Math.ceil((size / 832) * 72 * 4) })
      .resize(size, size)
      .png()
      .toFile(outPath)

    console.log(`  ✓ ${name} (${size}x${size})`)
  }

  // Generate public/data_connect_1024_1x.png
  await sharp(svgBuffer, { density: Math.ceil((1024 / 832) * 72 * 4) })
    .resize(1024, 1024)
    .png()
    .toFile(join(publicDir, "data_connect_1024_1x.png"))
  console.log("  ✓ public/data_connect_1024_1x.png (1024x1024)")

  // Generate .icns using macOS iconutil
  const iconsetDir = join(iconsDir, "icon.iconset")
  if (!existsSync(iconsetDir)) mkdirSync(iconsetDir, { recursive: true })

  const icnsSizes = [
    { name: "icon_16x16.png", size: 16 },
    { name: "icon_16x16@2x.png", size: 32 },
    { name: "icon_32x32.png", size: 32 },
    { name: "icon_32x32@2x.png", size: 64 },
    { name: "icon_128x128.png", size: 128 },
    { name: "icon_128x128@2x.png", size: 256 },
    { name: "icon_256x256.png", size: 256 },
    { name: "icon_256x256@2x.png", size: 512 },
    { name: "icon_512x512.png", size: 512 },
    { name: "icon_512x512@2x.png", size: 1024 },
  ]

  for (const { name, size } of icnsSizes) {
    await sharp(svgBuffer, { density: Math.ceil((size / 832) * 72 * 4) })
      .resize(size, size)
      .png()
      .toFile(join(iconsetDir, name))
  }

  execSync(`iconutil -c icns "${iconsetDir}" -o "${join(iconsDir, "icon.icns")}"`)
  execSync(`rm -rf "${iconsetDir}"`)
  console.log("  ✓ icon.icns")

  // Generate .ico using sharp (contains 16, 32, 48, 64, 128, 256)
  const icoSizes = [16, 32, 48, 64, 128, 256]
  const icoBuffers = await Promise.all(
    icoSizes.map((size) =>
      sharp(svgBuffer, { density: Math.ceil((size / 832) * 72 * 4) })
        .resize(size, size)
        .png()
        .toBuffer()
    )
  )

  // Build ICO file manually
  const icoBuffer = buildIco(icoBuffers, icoSizes)
  writeFileSync(join(iconsDir, "icon.ico"), icoBuffer)
  console.log("  ✓ icon.ico")

  console.log("\nDone! All icons generated.")
}

function buildIco(pngBuffers, sizes) {
  const numImages = pngBuffers.length
  const headerSize = 6
  const dirEntrySize = 16
  const dataOffset = headerSize + dirEntrySize * numImages

  let totalSize = dataOffset
  for (const buf of pngBuffers) totalSize += buf.length

  const ico = Buffer.alloc(totalSize)

  // ICO header
  ico.writeUInt16LE(0, 0) // reserved
  ico.writeUInt16LE(1, 2) // type (1 = ICO)
  ico.writeUInt16LE(numImages, 4) // count

  let offset = dataOffset
  for (let i = 0; i < numImages; i++) {
    const size = sizes[i]
    const buf = pngBuffers[i]
    const entryOffset = headerSize + i * dirEntrySize

    ico.writeUInt8(size >= 256 ? 0 : size, entryOffset) // width
    ico.writeUInt8(size >= 256 ? 0 : size, entryOffset + 1) // height
    ico.writeUInt8(0, entryOffset + 2) // color palette
    ico.writeUInt8(0, entryOffset + 3) // reserved
    ico.writeUInt16LE(1, entryOffset + 4) // color planes
    ico.writeUInt16LE(32, entryOffset + 6) // bits per pixel
    ico.writeUInt32LE(buf.length, entryOffset + 8) // size of PNG data
    ico.writeUInt32LE(offset, entryOffset + 12) // offset to PNG data

    buf.copy(ico, offset)
    offset += buf.length
  }

  return ico
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
