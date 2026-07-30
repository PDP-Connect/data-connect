import assert from 'node:assert/strict'
import test from 'node:test'
import {
  PERSONAL_SERVER_HOSTNAME,
  createPersonalServerServeOptions,
} from '../listener-options.cjs'

test('Personal Server listener binds loopback without tunnel options', () => {
  const fetch = () => new Response('ok')

  assert.deepEqual(createPersonalServerServeOptions(fetch, 8080), {
    fetch,
    hostname: '127.0.0.1',
    port: 8080,
  })
  assert.equal(PERSONAL_SERVER_HOSTNAME, '127.0.0.1')
})
