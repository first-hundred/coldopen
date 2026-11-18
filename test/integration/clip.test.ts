import { readdir, rm } from 'node:fs/promises'
import { afterAll, describe, expect, it } from 'vitest'
import { prepareClip } from '../../src/render/clip.ts'
import { fixtureServer, tmp } from '../helpers/index.ts'

afterAll(async () => {
  ;(await fixtureServer()).close()
})

describe('prepareClip', () => {
  it('downloads a clip, cuts it to the slot and extracts frames; a replay reuses the frame dir', async () => {
    const { url } = await fixtureServer()
    const dir = tmp('clip-')
    let fetches = 0
    const countingFetch: typeof fetch = (input, init) => {
      fetches++
      return fetch(input, init)
    }

    const opts = {
      url: `${url}/clips/sample.mp4`,
      slot: 3.0,
      size: { width: 200, height: 200 },
      mode: 'cover' as const,
      dir,
      fetch: countingFetch,
      allowPrivateNetworks: true,
    }
    const first = await prepareClip(opts)
    expect(first.frames).toBeGreaterThan(0)
    expect(first.fps).toBe(30)
    const files = await readdir(first.dir)
    expect(files.filter((f) => f.startsWith('frame-'))).toHaveLength(first.frames)
    expect(fetches).toBe(1)

    // same URL and slot: the frame dir already exists and is complete, so no download or re-encode
    const second = await prepareClip(opts)
    expect(second).toEqual(first)
    expect(fetches).toBe(1)
  })

  it('cuts a 6s fixture to a 6.5s slot with contain framing (no speedup needed)', async () => {
    const { url } = await fixtureServer()
    const result = await prepareClip({
      url: `${url}/clips/sample.mp4`,
      slot: 6.5,
      size: { width: 320, height: 180 },
      mode: 'contain',
      dir: tmp('clip-'),
      allowPrivateNetworks: true,
    })
    expect(result.seconds).toBeCloseTo(6, 0)
    expect(result.frames).toBeGreaterThan(0)
  })

  it('rebuilds from the URL when the frame dir is missing (a replay on a different machine)', async () => {
    const { url } = await fixtureServer()
    const dir = tmp('clip-')
    const opts = {
      url: `${url}/clips/sample.mp4`,
      slot: 3.0,
      size: { width: 200, height: 200 },
      mode: 'cover' as const,
      dir,
      allowPrivateNetworks: true,
    }
    const first = await prepareClip(opts)
    await rm(first.dir, { recursive: true, force: true })

    const second = await prepareClip(opts)
    expect(second).toEqual(first)
    const files = await readdir(second.dir)
    expect(files.filter((f) => f.startsWith('frame-'))).toHaveLength(second.frames)
  })

  it('refuses a link that opens a web page instead of a video', async () => {
    const { url } = await fixtureServer()
    await expect(
      prepareClip({
        url: `${url}/northwind/`,
        slot: 3.0,
        size: { width: 200, height: 200 },
        mode: 'cover',
        dir: tmp('clip-'),
        allowPrivateNetworks: true,
      }),
    ).rejects.toThrow(/video file/)
  })
})
