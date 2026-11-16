import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { buildApi } from '../../src/api/server.ts'
import type { Sql } from '../../src/db/index.ts'
import { freshDb, log, profile, testConfig, tmp } from '../helpers/index.ts'

/**
 * When SHARE_URL and SHARE_TOKEN are set, webhook posts (test message, morning digest) go
 * through the share worker's /relay/webhook rather than straight from here: the hosted app's
 * own outbound IP (shared on Render) can be blocked by Discord's Cloudflare rules, while the
 * worker's own traffic isn't. test/integration/autopilot-digest.test.ts covers the direct path
 * (no SHARE_URL); test/unit/share-worker.test.ts covers the relay endpoint itself.
 */

let sql: Sql
let app: Awaited<ReturnType<typeof buildApi>>
let relayServer: Server
let relayed: { auth: string | undefined; url: string; payload: unknown }[] = []
let relayResponse: { status: number; body: string | object } = {
  status: 200,
  body: { status: 204, body: '' },
}
let hookUrl: string
const TOKEN = 'dispatch-secret'
const SHARE_TOKEN = 'share-secret'
const me: Record<string, string> = { authorization: 'Bearer k1' }

beforeAll(async () => {
  sql = await freshDb()
  relayServer = createServer(async (req, res) => {
    let raw = ''
    for await (const c of req) raw += c
    const body = JSON.parse(raw) as { url: string; payload: unknown }
    relayed.push({ auth: req.headers.authorization, url: body.url, payload: body.payload })
    res.writeHead(relayResponse.status, { 'content-type': 'application/json' })
    res.end(
      typeof relayResponse.body === 'string'
        ? relayResponse.body
        : JSON.stringify(relayResponse.body),
    )
  })
  await new Promise<void>((r) => relayServer.listen(0, '127.0.0.1', r))
  const relayUrl = `http://127.0.0.1:${(relayServer.address() as AddressInfo).port}`
  hookUrl = 'https://discord.com/api/webhooks/1/not-actually-called'
  app = await buildApi({
    sql,
    cfg: testConfig({
      API_KEYS: 'k1',
      FILMS_DIR: tmp('autopilot-relay-'),
      RENDER_DISPATCH_TOKEN: TOKEN,
      PUBLIC_URL: 'https://coldopen.example/',
      SHARE_URL: relayUrl,
      SHARE_TOKEN,
    }),
    log,
    slack: null,
  })
  expect(
    (
      await app.inject({
        method: 'PUT',
        url: '/v1/profiles/me',
        headers: me,
        payload: { name: 'Me', data: profile('candidate') },
      })
    ).statusCode,
  ).toBeLessThan(300)
})

afterAll(async () => {
  await app?.close()
  await new Promise<void>((r) => relayServer.close(() => r()))
  await sql?.end()
})

beforeEach(async () => {
  relayed = []
  relayResponse = { status: 200, body: { status: 204, body: '' } }
  await sql`delete from runs`
  await sql`delete from autopilot_runs`
  await sql`delete from autopilot`
})

const turnOn = () => sql`
  insert into autopilot (owner, "on", per_day, days, profile_id, format, webhook)
  values ('team', true, 20, '{1,2,3,4,5,6,7}', 'me', 'square', ${hookUrl})
  on conflict (owner) do update set "on" = true, webhook = excluded.webhook`

describe('POST /v1/autopilot/test, with a share worker configured', () => {
  it('goes through the relay with the SHARE_TOKEN, naming the real webhook only to the relay', async () => {
    await turnOn()
    const r = await app.inject({
      method: 'POST',
      url: '/v1/autopilot/test',
      headers: me,
      payload: {},
    })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toEqual({ sent: true, message: 'Sent.' })
    expect(relayed).toHaveLength(1)
    expect(relayed[0]?.auth).toBe(`Bearer ${SHARE_TOKEN}`)
    expect(relayed[0]?.url).toBe(hookUrl)
    expect(relayed[0]?.payload).toMatchObject({ content: expect.stringContaining('test message') })
  })

  it('reports what the relay says the webhook answered, success or failure alike', async () => {
    await turnOn()
    relayResponse = { status: 200, body: { status: 403, body: 'Invalid Webhook Token' } }
    const r = await app.inject({
      method: 'POST',
      url: '/v1/autopilot/test',
      headers: me,
      payload: {},
    })
    const body = r.json()
    expect(body.sent).toBe(false)
    expect(body.message).toContain('answered 403')
    expect(body.message).toContain('Invalid Webhook Token')
  })
})

describe('the morning digest, with a share worker configured', () => {
  it('posts through the relay too', async () => {
    await turnOn()
    const made = await app.inject({
      method: 'POST',
      url: '/v1/films',
      headers: me,
      payload: { url: 'https://relay-ready.example/' },
    })
    const id = made.json().id as string
    await sql`
      update runs set status = 'succeeded', completed_at = now(), origin = 'autopilot',
        output = ${sql.json({
          company: 'relay-ready',
          host: 'relay-ready.example',
          format: 'square',
          durationSec: 29,
          files: {
            film: 'x/film-square.mp4',
            poster: 'x/poster.jpg',
            gif: 'x/preview.gif',
            sheet: 'x/contact-sheet.jpg',
            kit: 'x/kit.json',
            storyboard: 'x/storyboard.json',
          },
          script: {
            hook: 'Hi there',
            noticed: 'noticed thing',
            insight: { factId: 'f1', why: 'why this matters' },
            pitch: { headline: 'headline', points: ['point a', 'point b'] },
            proof: [0],
            cta: 'an ask',
          },
        } as never)}
      where id = ${id}`
    await sql`
      insert into autopilot_runs (owner, day, picked, made, skipped)
      values ('team', current_date, '[]',
        ${sql.json([{ id, site: 'relay-ready.example', company: 'relay-ready', at: new Date().toISOString() }] as never)}, '[]')
      on conflict (owner, day) do update set made = excluded.made`

    const r = await app.inject({
      method: 'POST',
      url: '/internal/autopilot/digest',
      headers: { authorization: `Bearer ${TOKEN}` },
    })
    expect(r.json()).toMatchObject({ checked: 1, pending: 0 })
    expect(relayed).toHaveLength(1)
    expect(relayed[0]?.url).toBe(hookUrl)
    expect(relayed[0]?.payload).toMatchObject({ content: expect.stringContaining('ready to send') })
  })
})
