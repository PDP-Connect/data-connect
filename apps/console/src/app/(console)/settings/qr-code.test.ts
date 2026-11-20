// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
// The On card's QR code: the SVG carries exactly the modules the vendored
// encoder produces for the address, and it shows only for a public https address.
import assert from "node:assert/strict";
import test from "node:test";
import { qrcodegen } from "../../../vendor/qrcodegen.ts";
import { publicHttpsAddress, qrModules, qrSvg } from "./qr-code.ts";

const ADDRESS = "https://5211b6141a2ef1.app.example.invalid";

/** Reads the dark modules back out of the SVG path, undoing the quiet-zone shift. */
function modulesFromSvg(address: string): boolean[][] {
  const { size, path } = qrSvg(address);
  const quiet = (size - qrcodegen.QrCode.encodeText(address, qrcodegen.QrCode.Ecc.MEDIUM).size) / 2;
  const grid = Array.from({ length: size - quiet * 2 }, () => Array.from({ length: size - quiet * 2 }, () => false));
  for (const match of path.matchAll(/M(\d+),(\d+)h1v1h-1z/g)) {
    const row = grid[Number(match[2]) - quiet];
    assert.ok(row, "a path square lies outside the code");
    row[Number(match[1]) - quiet] = true;
  }
  return grid;
}

test("the SVG module matrix equals the matrix qrcodegen produces for the address", () => {
  const code = qrcodegen.QrCode.encodeText(ADDRESS, qrcodegen.QrCode.Ecc.MEDIUM);
  const expected = Array.from({ length: code.size }, (_, y) => Array.from({ length: code.size }, (_, x) => code.getModule(x, y)));
  assert.deepEqual(qrModules(ADDRESS), expected);
  assert.deepEqual(modulesFromSvg(ADDRESS), expected);
});

test("the code has the shape of a QR symbol: a 4-module quiet zone and the three finder squares", () => {
  const modules = qrModules(ADDRESS);
  const size = modules.length;
  assert.equal((size - 21) % 4, 0, "the side is 21 + 4 * (version - 1)");
  assert.equal(qrSvg(ADDRESS).size, size + 8);
  for (const [x, y] of [[0, 0], [size - 7, 0], [0, size - 7]] as const) {
    for (let dy = 0; dy < 7; dy++) {
      for (let dx = 0; dx < 7; dx++) {
        const edge = dx === 0 || dy === 0 || dx === 6 || dy === 6;
        const core = dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4;
        assert.equal(modules[y + dy]?.[x + dx], edge || core, `finder at ${x},${y} module ${dx},${dy}`);
      }
    }
  }
});

test("a different address gives a different code", () => {
  assert.notDeepEqual(qrModules(ADDRESS), qrModules(`${ADDRESS}x`));
});

test("only a public https address gets a code", () => {
  assert.equal(publicHttpsAddress(ADDRESS, "public"), ADDRESS);
  assert.equal(publicHttpsAddress(ADDRESS, "this-device"), null);
  assert.equal(publicHttpsAddress("http://one.example.invalid", "public"), null);
  assert.equal(publicHttpsAddress("not an address", "public"), null);
  assert.equal(publicHttpsAddress("", "public"), null);
  assert.equal(publicHttpsAddress(null, "public"), null);
});
