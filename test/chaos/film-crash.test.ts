import { type ChildProcess, spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { Sql } from '../../src/db/index.ts'
import { FilmInputSchema } from '../../src/film.ts'
import { createRun, getLog, getRun, getSteps } from '../../src/runtime/store.ts'
import { fixtureServer, freshDb, profile, TEST_DB, tmp } from '../helpers/index.ts'

/**
 * The real thing: a worker process renders a film, gets SIGKILLed partway through the
 * render, and a fresh worker finishes it. Finished scenes must not be rendered again.
 */
let sql: Sql
const procs: ChildProcess[] = []
const filmsDir = tmp('crash-films-')

beforeAll(async () => {
  sql = await freshDb()
})
afterAll(async () => {
  for (const p of procs) p.kill('SIGKILL')
  await sql?.end()
  ;(await fixtureServer()).close()
})
// a worker left running from one test would race the next test's own worker for its run
afterEach(async () => {
  for (const p of procs) p.kill('SIGKILL')
  procs.length = 0
  await sleep(200)
})

function worker(): ChildProcess {
  const p = spawn(process.execPath, ['src/main.ts', 'worker'], {
    cwd: join(import.meta.dirname, '../..'),
    env: {
      ...process.env,
      DATABASE_URL: TEST_DB,
      FILMS_DIR: filmsDir,
      LEASE_MS: '3000',
      POLL_INTERVAL_MS: '200',
      ALLOW_PRIVATE_NETWORKS: 'true',
      LOG_LEVEL: 'error',
    },
    stdio: 'ignore',
  })
  procs.push(p)
  return p
}

describe('crash during render', () => {
  it('a new worker finishes the film without re-rendering finished scenes', async () => {
    const { url } = await fixtureServer()
    const input = FilmInputSchema.parse({ url: `${url}/northwind/`, profile: profile('sales') })
    const { run } = await createRun(sql, { agent: 'film', input })

    const first = worker()
    // wait until at least two scenes are rendered, then kill -9. Scenes render several at a
    // time, so which ones finished first varies: remember them
    let finished: string[] = []
    for (let i = 0; ; i++) {
      finished = (await getSteps(sql, run.id))
        .filter((s) => s.key.startsWith('render:') && s.status === 'completed')
        .map((s) => s.key)
      if (finished.length >= 2) break
      if (i > 600) throw new Error('first worker never got to the render stage')
      await sleep(200)
    }
    first.kill('SIGKILL')

    worker()
    for (let i = 0; ; i++) {
      const r = await getRun(sql, run.id)
      if (r?.status === 'succeeded') break
      if (r?.status === 'failed') throw new Error(`film failed: ${r.error}`)
      if (i > 900) throw new Error('second worker never finished the film')
      await sleep(200)
    }

    const final = (await getRun(sql, run.id))!
    expect(final.attempts).toBe(2)
    const steps = await getSteps(sql, run.id)
    const replayed = steps.filter((s) => s.replays > 0).map((s) => s.key)
    expect(replayed).toEqual(expect.arrayContaining(['research', 'script', 'compose', ...finished]))
    // each scene was journaled by exactly one execution: finished scenes were never redone
    for (const s of steps.filter((x) => x.key.startsWith('render:'))) expect(s.attempts).toBe(1)
    const timeline = (await getLog(sql, run.id)).map((l) => l.kind)
    expect(timeline).toEqual(expect.arrayContaining(['worker_lost', 'replayed', 'succeeded']))
  }, 300_000)
})

/**
 * Serves fixtures/clips/sample.mp4 one slice at a time, so the download inside the clips step
 * takes a few real seconds — long enough for the test to reliably catch the worker mid-step
 * (ffmpeg alone finishes a 6s fixture almost instantly, too fast to poll for).
 */
async function slowClip(delayMs: number): Promise<{ url: string; close: () => void }> {
  const bytes = await readFile(join(import.meta.dirname, '../../fixtures/clips/sample.mp4'))
  const slices = 24
  const sliceSize = Math.ceil(bytes.length / slices)
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(bytes.length) })
    let i = 0
    const tick = () => {
      if (i >= bytes.length) {
        res.end()
        return
      }
      res.write(bytes.subarray(i, i + sliceSize))
      i += sliceSize
      setTimeout(tick, delayMs)
    }
    tick()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  return { url: `http://127.0.0.1:${port}/clip.mp4`, close: () => server.close() }
}

describe('crash during clips', () => {
  it('a new worker finishes the film by redoing only the clips step', async () => {
    const { url } = await fixtureServer()
    const slow = await slowClip(120)
    try {
      const base = profile('candidate')
      const withClip = { ...base, sender: { ...base.sender, clip: { url: slow.url } } }
      // the clip lives on a plain http test server: skip FilmInputSchema's https-only check
      // (an API-boundary rule, not something the worker re-checks) and build the input the
      // way createRun's own `unknown` input field allows
      const input = { url: `${url}/northwind/`, profile: withClip, format: 'square' }
      const { run } = await createRun(sql, { agent: 'film', input })

      const first = worker()
      // the clips step hasn't journaled yet (it only does on success): catch the window
      // where progress has reached "design" (preparing the clip) but clips isn't done
      for (let i = 0; ; i++) {
        const r = await getRun(sql, run.id)
        const steps = await getSteps(sql, run.id)
        const clipsDone = steps.some((s) => s.key === 'clips' && s.status === 'completed')
        if ((r?.progress as { stage?: string } | null)?.stage === 'design' && !clipsDone) break
        if (i > 600) throw new Error('first worker never reached the clips step')
        await sleep(50)
      }
      first.kill('SIGKILL')

      worker()
      for (let i = 0; ; i++) {
        const r = await getRun(sql, run.id)
        if (r?.status === 'succeeded') break
        if (r?.status === 'failed') throw new Error(`film failed: ${r.error}`)
        if (i > 900) throw new Error('second worker never finished the film')
        await sleep(200)
      }

      const final = (await getRun(sql, run.id))!
      expect(final.attempts).toBe(2)
      const steps = await getSteps(sql, run.id)
      const replayed = steps.filter((s) => s.replays > 0).map((s) => s.key)
      // steps that finished before the kill (clips runs before compose) were never redone;
      // clips itself, incomplete at the kill, was
      expect(replayed).toEqual(expect.arrayContaining(['research', 'script']))
      expect(replayed).not.toContain('clips')
      expect(replayed).not.toContain('compose')
      const clipsStep = steps.find((s) => s.key === 'clips')
      expect(clipsStep?.status).toBe('completed')
    } finally {
      slow.close()
    }
  }, 300_000)
})
