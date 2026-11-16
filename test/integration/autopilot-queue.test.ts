import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApi } from '../../src/api/server.ts'
import { makeToken } from '../../src/api/tokens.ts'
import type { Sql } from '../../src/db/index.ts'
import { weekStart } from '../../src/jobs/targets.ts'
import { freshDb, log, profile, testConfig, tmp } from '../helpers/index.ts'

/**
 * Today's "ready to send" queue: Autopilot's films from the last 3 days, split into the ones
 * that passed review and the ones that need a look, with a sent film or a skipped company
 * dropped from either list. Nothing here renders a film; each row is written straight into
 * `runs`, as if Autopilot had made it.
 */
let sql: Sql
let app: Awaited<ReturnType<typeof buildApi>>
const me: Record<string, string> = { authorization: 'Bearer k1' }
let them: Record<string, string>

beforeAll(async () => {
  sql = await freshDb()
  app = await buildApi({
    sql,
    cfg: testConfig({ API_KEYS: 'k1', FILMS_DIR: tmp('autopilot-queue-films-') }),
    log,
    slack: null,
  })
  them = { authorization: `Bearer ${(await makeToken(sql, 'u:gh:queue-other', 't')).token}` }
  await app.inject({
    method: 'PUT',
    url: '/v1/profiles/me',
    headers: me,
    payload: { name: 'Me', data: profile('candidate') },
  })
})

afterAll(async () => {
  await app?.close()
  await sql?.end()
})

const get = (headers = me) => app.inject({ url: '/v1/autopilot/queue', headers })

// the review flags a built-in line 2+ of the sender's last 10 films share (templated_line), so
// each test film's lines carry this counter: otherwise every film after the second would share
// the same deterministic placeholder text and the review would flag all of them
let seq = 0

/**
 * An Autopilot film, written straight to `succeeded`: `proofIndex` 0 reads cleanly (ready);
 * 3 (a result with no "what you did" or "where") doesn't, so the review flags it.
 */
async function autopilotFilm(
  site: string,
  opts: {
    proofIndex?: number
    ageDays?: number
    homework?: { kind: string; title: string; url: string; date?: string }[]
    headers?: Record<string, string>
  } = {},
): Promise<{ id: string; host: string }> {
  const headers = opts.headers ?? me
  const url = `https://${site}/`
  const r = await app.inject({ method: 'POST', url: '/v1/films', headers, payload: { url } })
  const id = r.json().id as string
  const n = ++seq
  const output = {
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
    script: {
      hook: `Hi there, take ${n}`,
      noticed: `noticed thing ${n}`,
      insight: { factId: 'f1', why: `why this matters ${n}` },
      pitch: { headline: `headline ${n}`, points: [`point a ${n}`, `point b ${n}`] },
      proof: [opts.proofIndex ?? 0],
      cta: `an ask, number ${n}`,
    },
    ...(opts.homework ? { homework: { items: opts.homework, pages: [] } } : {}),
  }
  const createdAt = new Date(Date.now() - (opts.ageDays ?? 0) * 86_400_000)
  await sql`
    update runs set status = 'succeeded', completed_at = now(), origin = 'autopilot',
      created_at = ${createdAt}, output = ${sql.json(output as never)}
    where id = ${id}`
  return { id, host: site }
}

describe("today's ready-to-send queue", () => {
  it('splits a clean film from one the review flags, and counts made against films a weekday', async () => {
    const ready = await autopilotFilm('ready-one.example')
    const flagged = await autopilotFilm('needs-look-one.example', { proofIndex: 3 })
    const r = await get()
    expect(r.statusCode).toBe(200)
    const body = r.json()
    expect(body.perDay).toBe(20) // DEFAULT_SETTINGS.perDay; Autopilot was never turned on
    expect(body.made).toBe(2)
    expect(body.ready.map((x: { film: { id: string } }) => x.film.id)).toEqual([ready.id])
    expect(body.ready[0].who).not.toBeNull()
    expect(body.needsLook.map((x: { film: { id: string } }) => x.film.id)).toEqual([flagged.id])
    expect(body.needsLook[0].flags.length).toBeGreaterThan(0)
    expect(body.needsLook[0].flags[0].code).toBe('proof_unclear')
  })

  it('shows the newest thing in a ready film’s homework', async () => {
    const { id } = await autopilotFilm('homework-one.example', {
      homework: [
        {
          kind: 'blog',
          title: 'An older post',
          url: 'https://homework-one.example/old',
          date: '2026-10-01',
        },
        {
          kind: 'blog',
          title: 'A newer post',
          url: 'https://homework-one.example/new',
          date: '2026-11-10',
        },
      ],
    })
    const body = (await get()).json()
    const entry = body.ready.find((x: { film: { id: string } }) => x.film.id === id)
    expect(entry.homework).toEqual({ title: 'A newer post', date: '2026-11-10' })
  })

  it('drops a film once it’s marked sent', async () => {
    const { id } = await autopilotFilm('sent-one.example')
    expect((await get()).json().ready.map((x: { film: { id: string } }) => x.film.id)).toContain(id)
    const put = await app.inject({
      method: 'PUT',
      url: `/v1/films/${id}/outreach`,
      headers: me,
      payload: { status: 'sent' },
    })
    expect(put.statusCode).toBe(200)
    const after = (await get()).json()
    expect(after.ready.map((x: { film: { id: string } }) => x.film.id)).not.toContain(id)
    expect(after.needsLook.map((x: { film: { id: string } }) => x.film.id)).not.toContain(id)
    // the film itself is still there, just not in today's queue
    expect((await app.inject({ url: `/v1/films/${id}`, headers: me })).statusCode).toBe(200)
  })

  it('drops a film once "Not for me" hides its company, and keeps it off once hidden', async () => {
    const { id, host } = await autopilotFilm('skip-one.example')
    expect((await get()).json().ready.map((x: { film: { id: string } }) => x.film.id)).toContain(id)
    const hide = await app.inject({
      method: 'POST',
      url: '/v1/targets/hide',
      headers: me,
      payload: { site: host },
    })
    expect(hide.statusCode).toBe(200)
    const after = (await get()).json()
    expect(after.ready.map((x: { film: { id: string } }) => x.film.id)).not.toContain(id)
  })

  it('only counts films from the last 3 days, Autopilot’s own, and this owner’s', async () => {
    const old = await autopilotFilm('too-old.example', { ageDays: 4 })
    const notAutopilot = await app.inject({
      method: 'POST',
      url: '/v1/films',
      headers: me,
      payload: { url: 'https://by-hand.example/' },
    })
    await sql`
      update runs set status = 'succeeded', completed_at = now(),
        output = ${sql.json({
          company: 'By hand',
          host: 'by-hand.example',
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
            hook: 'Hi',
            noticed: 'x',
            insight: { factId: 'f1', why: 'y' },
            pitch: { headline: 'h', points: ['a', 'b'] },
            proof: [0],
            cta: 'Talk?',
          },
        } as never)}
      where id = ${notAutopilot.json().id}`
    const body = (await get()).json()
    const ids = [...body.ready, ...body.needsLook].map((x: { film: { id: string } }) => x.film.id)
    expect(ids).not.toContain(old.id)
    expect(ids).not.toContain(notAutopilot.json().id)
    // the old one is still a film, just outside the 3-day window
    expect((await app.inject({ url: `/v1/films/${old.id}`, headers: me })).statusCode).toBe(200)
  })

  it('keeps each person’s queue to themselves', async () => {
    await app.inject({
      method: 'PUT',
      url: '/v1/profiles/me',
      headers: them,
      payload: { name: 'Them', data: profile('candidate') },
    })
    const mine = await autopilotFilm('owner-mine.example')
    const theirs = await autopilotFilm('owner-theirs.example', { headers: them })
    const mineIds = [...(await get()).json().ready].map((x: { film: { id: string } }) => x.film.id)
    expect(mineIds).toContain(mine.id)
    expect(mineIds).not.toContain(theirs.id)
    const theirIds = [...(await get(them)).json().ready].map(
      (x: { film: { id: string } }) => x.film.id,
    )
    expect(theirIds).toContain(theirs.id)
    expect(theirIds).not.toContain(mine.id)
  })

  it('counts films marked sent since Monday, for the LinkedIn-limit note', async () => {
    const before = (await get()).json().sentThisWeek as number
    const { id } = await autopilotFilm('counted-sent.example')
    await app.inject({
      method: 'PUT',
      url: `/v1/films/${id}/outreach`,
      headers: me,
      payload: { status: 'sent' },
    })
    const after = (await get()).json().sentThisWeek as number
    expect(after).toBe(before + 1)
    // sent before this week doesn't count
    const old = new Date(weekStart(Date.now()).getTime() - 86_400_000).toISOString()
    await sql`
      update runs set outreach = ${sql.json({ status: 'sent', at: old, sentAt: old } as never)}
      where id = ${id}`
    const notCounted = (await get()).json().sentThisWeek as number
    expect(notCounted).toBe(before)
  })
})
