import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkClip, isPrUrl, MAX_CLIP_BYTES, prState, sniffVideo } from '../../src/profile/media.ts'

const fixture = (name: string) =>
  readFileSync(join(import.meta.dirname, '../../fixtures/github', name), 'utf8')

/** a minimal MP4: a box size, then the `ftyp` box, padded to `total` bytes */
function mp4Bytes(total = 32): Buffer {
  const buf = Buffer.alloc(total)
  buf.writeUInt32BE(total, 0)
  buf.write('ftyp', 4, 'ascii')
  buf.write('isom', 8, 'ascii')
  return buf
}

/** a minimal WebM: the EBML header magic, padded to `total` bytes */
function webmBytes(total = 32): Buffer {
  const buf = Buffer.alloc(total)
  buf.set([0x1a, 0x45, 0xdf, 0xa3], 0)
  return buf
}

/** routes a fake fetch by "METHOD url", falling back to a plain url for either method */
function fakeFetch(
  handlers: Record<string, (init: RequestInit) => Response | never>,
): typeof fetch {
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input instanceof Request ? input.url : input)
    const method = (init.method ?? (input instanceof Request ? input.method : 'GET') ?? 'GET')
      .toString()
      .toUpperCase()
    const h = handlers[`${method} ${url}`] ?? handlers[url]
    if (!h) return new Response('not found', { status: 404 })
    return h(init)
  }) as typeof fetch
}

describe('sniffVideo: a video by its first bytes, never by content-type', () => {
  it('recognizes an mp4 (ftyp box) and a webm (EBML header)', () => {
    expect(sniffVideo(mp4Bytes())).toBe(true)
    expect(sniffVideo(webmBytes())).toBe(true)
  })

  it('rejects an html page and short garbage', () => {
    expect(sniffVideo(Buffer.from('<!doctype html><html></html>'))).toBe(false)
    expect(sniffVideo(Buffer.from([1, 2, 3]))).toBe(false)
  })
})

describe('checkClip: is this link really a short video?', () => {
  it('is ok for a direct mp4 link, sniffed past a misleading content-type', async () => {
    const bytes = mp4Bytes(2048)
    const fetchFn = fakeFetch({
      'HEAD https://cdn.example.test/clip.mp4': () =>
        new Response(null, {
          status: 200,
          headers: {
            'content-length': String(bytes.length),
            'content-type': 'application/octet-stream',
          },
        }),
      'GET https://cdn.example.test/clip.mp4': () =>
        new Response(new Uint8Array(bytes), {
          status: 200,
          headers: { 'content-length': String(bytes.length) },
        }),
    })
    const r = await checkClip('https://cdn.example.test/clip.mp4', {
      fetch: fetchFn,
      allowPrivateNetworks: true,
    })
    expect(r).toEqual({ ok: true })
  })

  it('refuses a Drive-style share link: it opens a web page, not a video', async () => {
    const html = Buffer.from(
      '<!doctype html><html><head><title>Drive</title></head><body>Redirecting…</body></html>',
    )
    const fetchFn = fakeFetch({
      'HEAD https://drive.example.test/share': () =>
        new Response(null, { status: 200, headers: { 'content-length': String(html.length) } }),
      'GET https://drive.example.test/share': () =>
        new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }),
    })
    const r = await checkClip('https://drive.example.test/share', {
      fetch: fetchFn,
      allowPrivateNetworks: true,
    })
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/opens a web page, not a video file/)
  })

  it('refuses a clip over the size limit, naming the size', async () => {
    const size = 25_000_000
    const fetchFn = fakeFetch({
      'HEAD https://cdn.example.test/huge.mp4': () =>
        new Response(null, { status: 200, headers: { 'content-length': String(size) } }),
    })
    const r = await checkClip('https://cdn.example.test/huge.mp4', {
      fetch: fetchFn,
      allowPrivateNetworks: true,
    })
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('25 MB')
    expect(r.reason).toContain(`${Math.round(MAX_CLIP_BYTES / 1e6)} MB`)
  })

  it('falls back to a ranged GET when HEAD is refused, and still finds the video', async () => {
    const bytes = mp4Bytes(64)
    const fetchFn = fakeFetch({
      'HEAD https://releases.example.test/demo.mp4': () => new Response(null, { status: 405 }),
      'GET https://releases.example.test/demo.mp4': () =>
        new Response(new Uint8Array(bytes), { status: 200 }),
    })
    const r = await checkClip('https://releases.example.test/demo.mp4', {
      fetch: fetchFn,
      allowPrivateNetworks: true,
    })
    expect(r).toEqual({ ok: true })
  })

  it('refuses a private address without making a request', async () => {
    const fetchFn = fakeFetch({}) // any call here is a bug: the guard should stop it first
    const r = await checkClip('https://192.168.1.50/clip.mp4', { fetch: fetchFn })
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/private or local address/)
  })
})

describe("prState: a project's pull request, read from GitHub itself", () => {
  const url = 'https://api.github.com/repos/alex-rivera/integration-triage/pulls/42'

  it('is not a PR link: null, no request made', async () => {
    const fetchFn = fakeFetch({})
    expect(isPrUrl('https://github.com/alex-rivera/integration-triage')).toBe(false)
    const r = await prState('https://github.com/alex-rivera/integration-triage', { fetch: fetchFn })
    expect(r).toBeNull()
  })

  it('a merged pull request', async () => {
    expect(isPrUrl('https://github.com/alex-rivera/integration-triage/pull/42')).toBe(true)
    const fetchFn = fakeFetch({
      [url]: () => new Response(fixture('pr-merged.json'), { status: 200 }),
    })
    const r = await prState('https://github.com/alex-rivera/integration-triage/pull/42', {
      fetch: fetchFn,
    })
    expect(r).toEqual({ repo: 'alex-rivera/integration-triage', merged: true })
  })

  it('an open pull request', async () => {
    const openUrl = 'https://api.github.com/repos/alex-rivera/integration-triage/pulls/51'
    const fetchFn = fakeFetch({
      [openUrl]: () => new Response(fixture('pr-open.json'), { status: 200 }),
    })
    const r = await prState('https://github.com/alex-rivera/integration-triage/pull/51', {
      fetch: fetchFn,
    })
    expect(r).toEqual({ repo: 'alex-rivera/integration-triage', merged: false })
  })

  it('a 404: null, never shown as a false merge', async () => {
    const fetchFn = fakeFetch({
      [url]: () => new Response(fixture('pr-not-found.json'), { status: 404 }),
    })
    const r = await prState('https://github.com/alex-rivera/integration-triage/pull/42', {
      fetch: fetchFn,
    })
    expect(r).toBeNull()
  })

  it('rate-limited: null, not an error thrown', async () => {
    const fetchFn = fakeFetch({
      [url]: () => new Response(fixture('pr-rate-limited.json'), { status: 403 }),
    })
    const r = await prState('https://github.com/alex-rivera/integration-triage/pull/42', {
      fetch: fetchFn,
    })
    expect(r).toBeNull()
  })
})
