// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { waitForTunnelReady } from './tunnel-ready.cjs'

const URL = 'https://abc123.tunnel.example'

function fakeFrpc() {
  const frpc = new EventEmitter()
  frpc.stdout = new EventEmitter()
  frpc.stderr = new EventEmitter()
  return frpc
}

test('announces the URL when frpc reports the proxy started', async () => {
  const frpc = fakeFrpc()
  const ready = waitForTunnelReady(frpc, URL, { timeoutMs: 1000 })
  frpc.stdout.emit('data', Buffer.from('[I] [proxy_manager.go] [ps-1a2b] start proxy success\n'))
  assert.equal(await ready, URL)
})

test('reads the proxy marker from stderr and across chunk boundaries', async () => {
  const frpc = fakeFrpc()
  const ready = waitForTunnelReady(frpc, URL, { timeoutMs: 1000 })
  frpc.stderr.emit('data', Buffer.from('[I] [ps-1a2b] start pro'))
  frpc.stderr.emit('data', Buffer.from('xy success\n'))
  assert.equal(await ready, URL)
})

test('a server login alone does not announce the URL', async () => {
  const frpc = fakeFrpc()
  const ready = waitForTunnelReady(frpc, URL, { timeoutMs: 50 })
  frpc.stdout.emit('data', Buffer.from('[I] [service.go] login to server success, get run id [x]\n'))
  assert.equal(await ready, null)
})

test('a timeout announces no URL', async () => {
  const frpc = fakeFrpc()
  assert.equal(await waitForTunnelReady(frpc, URL, { timeoutMs: 20 }), null)
})

test('a spawn error announces no URL', async () => {
  const frpc = fakeFrpc()
  const ready = waitForTunnelReady(frpc, URL, { timeoutMs: 1000 })
  frpc.emit('error', Object.assign(new Error('spawn frpc ENOENT'), { code: 'ENOENT' }))
  assert.equal(await ready, null)
})

test('frpc exiting before the proxy starts announces no URL, even with code 0', async () => {
  const frpc = fakeFrpc()
  const ready = waitForTunnelReady(frpc, URL, { timeoutMs: 1000 })
  frpc.stdout.emit('data', Buffer.from('login to server success\n'))
  frpc.emit('exit', 0, null)
  assert.equal(await ready, null)
})

test('later frpc output does not change a settled result', async () => {
  const frpc = fakeFrpc()
  const ready = waitForTunnelReady(frpc, URL, { timeoutMs: 1000 })
  frpc.emit('exit', 1, null)
  frpc.stdout.emit('data', Buffer.from('start proxy success\n'))
  assert.equal(await ready, null)
})
