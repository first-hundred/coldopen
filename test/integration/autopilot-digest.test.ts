import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { buildApi } from '../../src/api/server.ts'
import type { Sql } from '../../src/db/index.ts'
import { freshDb, log, profile, testConfig, tmp } from '../helpers/index.ts'

/**
 * The morning message: once today's Autopilot films are finished or failed, one post to the
 * webhook saying what's ready, what needs a look and what's due; a retried or re-polled check
 * never posts it twice. Posted against a local HTTP server standing in for Slack or Discord, the
 * same way test/integration/api.test.ts stands in for Slack's API. Settings are written straight
 * to the `autopilot` table, bypassing PUT /v1/autopilot's Slack/Discord-only webhook check
 * (covered in test/integration/autopilot.test.ts), since a local server isn't on either domain.
 */

let sql: Sql
let app: Awaited<ReturnType<typeof buildApi>>
let hookServer: Server
let posts: string[] = []
let headersSeen: Record<string, string | string[] | undefined>[] = []
let hookResponse = { status: 200, body: 'ok' }
let hookUrl: string
const TOKEN = 'dispatch-secret'
const me: Record<string, string> = { authorization: 'Bearer k1' }

beforeAll(async () => {
  sql = await freshDb()
  hookServer = createServer(async (req, res) => {
    let body = ''
    for await (const c of req) body += c
    posts.push(body)
    headersSeen.push(req.headers)
    res.writeHead(hookResponse.status)
    res.end(hookResponse.body)
  })
  await new Promise<void>((r) => hookServer.listen(0, '127.0.0.1', r))
  hookUrl = `http://127.0.0.1:${(hookServer.address() as AddressInfo).port}/hook`
  app = await buildApi({
    sql,
    cfg: testConfig({
      API_KEYS: 'k1',
      FILMS_DIR: tmp('autopilot-digest-'),
      RENDER_DISPATCH_TOKEN: TOKEN,
      PUBLIC_URL: 'https://coldopen.example/',
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
  await new Promise<void>((r) => hookServer.close(() => r()))
  await sql?.end()
})

beforeEach(async () => {
  posts = []
  headersSeen = []
  hookResponse = { status: 200, body: 'ok' }
  await sql`delete from runs`
  await sql`delete from autopilot_runs`
  await sql`delete from autopilot`
})

const turnOn = (webhook: string | null) => sql`
  insert into autopilot (owner, "on", per_day, days, profile_id, format, webhook)
  values ('team', true, 20, '{1,2,3,4,5,6,7}', 'me', 'square', ${webhook})
  on conflict (owner) do update set "on" = true, webhook = excluded.webhook`

const checkDigest = () =>
  app.inject({
    method: 'POST',
    url: '/internal/autopilot/digest',
    headers: { authorization: `Bearer ${TOKEN}` },
  })

// a built-in line 2+ of the sender's last 10 films share gets flagged (templated_line), so each
// film's lines carry this counter: otherwise every film after the second would read as templated
let seq = 0
const scriptOf = (n: number) => ({
  hook: `Hi there, take ${n}`,
  noticed: `noticed thing ${n}`,
  insight: { factId: 'f1', why: `why this matters ${n}` },
  pitch: { headline: `headline ${n}`, points: [`point a ${n}`, `point b ${n}`] },
  proof: [0],
  cta: `an ask, number ${n}`,
})
const outputOf = (site: string) => ({
  company: site.split('.')[0],
  host: site,
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
  script: scriptOf(++seq),
})

/** An Autopilot film, written straight to a terminal status, as the render workflow would leave it */
async function autopilotFilm(
  site: string,
  status: 'succeeded' | 'running' | 'failed' = 'succeeded',
): Promise<{ id: string; site: string; company: string }> {
  const r = await app.inject({
    method: 'POST',
    url: '/v1/films',
    headers: me,
    payload: { url: `https://${site}/` },
  })
  const id = r.json().id as string
  const company = site.split('.')[0]!
  if (status === 'running') return { id, site, company }
  if (status === 'failed') {
    await sql`
      update runs set status = 'failed', completed_at = now(), origin = 'autopilot',
        error = 'the site timed out'
      where id = ${id}`
    return { id, site, company }
  }
  await sql`
    update runs set status = 'succeeded', completed_at = now(), origin = 'autopilot',
      output = ${sql.json(outputOf(site) as never)}
    where id = ${id}`
  return { id, site, company }
}

/** Finishes a film Autopilot had left running, the way a render completing would */
const finish = (id: string, site: string) => sql`
  update runs set status = 'succeeded', completed_at = now(), origin = 'autopilot',
    output = ${sql.json(outputOf(site) as never)}
  where id = ${id}`

const storeMade = (made: { id: string; site: string; company: string }[]) => sql`
  insert into autopilot_runs (owner, day, picked, made, skipped)
  values ('team', current_date, '[]',
    ${sql.json(made.map((m) => ({ ...m, at: new Date().toISOString() })) as never)}, '[]')
  on conflict (owner, day) do update set made = excluded.made`

describe('the morning digest', () => {
  it('posts once today’s films are finished or failed, naming what’s ready and what failed', async () => {
    await turnOn(hookUrl)
    const a = await autopilotFilm('ready-a.example')
    const b = await autopilotFilm('ready-b.example', 'failed')
    await storeMade([a, b])

    expect((await checkDigest()).statusCode).toBe(200)
    expect(posts).toHaveLength(1)
    const body = JSON.parse(posts[0]!)
    expect(body.text).toContain('ready to send (ready-a)')
    expect(body.text).toContain('ready-b failed: the site timed out')
    expect(body.text).toContain('Open Today: https://coldopen.example')
    expect(body.text).toBe(body.content) // the one body both Slack and Discord read from
    expect(headersSeen[0]?.['user-agent']).toBeTruthy()
  })

  it('reports pending in its response while films are still rendering, 0 once settled', async () => {
    await turnOn(hookUrl)
    const a = await autopilotFilm('pending-a.example', 'running')
    await storeMade([a])
    expect((await checkDigest()).json()).toMatchObject({ checked: 1, pending: 1 })
    await sql`update runs set status = 'failed', error = 'ran out of time' where id = ${a.id}`
    expect((await checkDigest()).json()).toMatchObject({ checked: 1, pending: 0 })
  })

  it('still marks itself done, and never names the webhook, when the post fails', async () => {
    await turnOn(hookUrl)
    hookResponse = { status: 403, body: 'Invalid Webhook Token' }
    const a = await autopilotFilm('bad-hook.example')
    await storeMade([a])
    expect((await checkDigest()).json()).toMatchObject({ checked: 1, pending: 0 })
    expect(posts).toHaveLength(1) // it did try to post
    await checkDigest()
    expect(posts).toHaveLength(1) // but never retries once it's marked settled
  })

  it('never posts twice, even when checked again or the run retries', async () => {
    await turnOn(hookUrl)
    const a = await autopilotFilm('once-a.example')
    await storeMade([a])
    await checkDigest()
    expect(posts).toHaveLength(1)
    await checkDigest()
    await checkDigest()
    expect(posts).toHaveLength(1)
  })

  it('waits for a still-rendering film before posting', async () => {
    await turnOn(hookUrl)
    const a = await autopilotFilm('waiting-a.example', 'running')
    await storeMade([a])
    await checkDigest()
    expect(posts).toHaveLength(0)
    await sql`update runs set status = 'failed', error = 'ran out of time' where id = ${a.id}`
    await checkDigest()
    expect(posts).toHaveLength(1)
  })

  it('says nothing when nothing is ready, needs a look or failed', async () => {
    await turnOn(hookUrl)
    await storeMade([])
    await checkDigest()
    expect(posts).toHaveLength(0)
  })

  it('posts nothing when no webhook is saved', async () => {
    await turnOn(null)
    const a = await autopilotFilm('no-hook.example')
    await storeMade([a])
    await checkDigest()
    expect(posts).toHaveLength(0)
  })

  it('sends a short second line once the rest of a long day’s films are done', async () => {
    await turnOn(hookUrl)
    const first10 = await Promise.all(
      Array.from({ length: 10 }, (_, i) => autopilotFilm(`batch1-${i}.example`)),
    )
    const eleventh = await autopilotFilm('batch2-a.example', 'running')
    await storeMade([...first10, eleventh])

    await checkDigest()
    expect(posts).toHaveLength(1) // the first 10 are done; the 11th isn't, so no second line yet

    await finish(eleventh.id, eleventh.site)
    await checkDigest()
    expect(posts).toHaveLength(2)
    expect(posts[1]).toContain('1 more film ready')
    await checkDigest()
    expect(posts).toHaveLength(2) // not a third time
  })
})

describe('POST /v1/autopilot/test', () => {
  it('sends a test message to the saved webhook, with a User-Agent, and says it was sent', async () => {
    await turnOn(hookUrl)
    const r = await app.inject({
      method: 'POST',
      url: '/v1/autopilot/test',
      headers: me,
      payload: {},
    })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toEqual({ sent: true, message: 'Sent.' })
    expect(posts).toHaveLength(1)
    expect(headersSeen[0]?.['user-agent']).toBeTruthy()
  })

  it('says what the service answered, instead of claiming success, on a bad webhook', async () => {
    await turnOn(hookUrl)
    hookResponse = { status: 403, body: 'Invalid Webhook Token' }
    const r = await app.inject({
      method: 'POST',
      url: '/v1/autopilot/test',
      headers: me,
      payload: {},
    })
    expect(r.statusCode).toBe(200) // never an HTTP error: posting to it never fails the run either
    const body = r.json()
    expect(body.sent).toBe(false)
    expect(body.message).toContain('answered 403')
    expect(body.message).toContain('Invalid Webhook Token')
  })

  it('needs a webhook saved first', async () => {
    await turnOn(null)
    const r = await app.inject({
      method: 'POST',
      url: '/v1/autopilot/test',
      headers: me,
      payload: {},
    })
    expect(r.statusCode).toBe(409)
    expect(posts).toHaveLength(0)
  })
})
