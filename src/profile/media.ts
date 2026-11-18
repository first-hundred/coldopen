/**
 * Checks for what a job seeker adds to show their work: a clip is really a video (not a web
 * page a share link redirected to) and under the size limit, and a project's pull request link
 * is checked against GitHub itself, so "merged" is never something the client could claim.
 */
import { assertPublicUrl, BlockedUrlError } from '../brand/guard.ts'

export interface MediaCheckOptions {
  fetch?: typeof fetch
  maxBytes?: number
  timeoutMs?: number
  /** for tests against a local fixture server; the hosted app never sets this */
  allowPrivateNetworks?: boolean
}

export interface MediaCheckResult {
  ok: boolean
  /** why it was refused, in plain words, when ok is false */
  reason?: string
}

/** a clip over this is refused outright; the film embeds it, so it has to stay small */
export const MAX_CLIP_BYTES = 20_000_000

const mb = (n: number) => Math.round(n / 1e6)

function sizeReason(bytes: number | null, maxBytes: number): string {
  const limit = mb(maxBytes)
  return bytes != null
    ? `This video is ${mb(bytes)} MB; coldopen's limit for a clip is ${limit} MB.`
    : `This video is larger than ${limit} MB, coldopen's limit for a clip.`
}

const NOT_OPENABLE = "Couldn't open that link. Check it's a direct, public link to the video."

function notVideoReason(bytes: Buffer): string {
  const head = bytes.subarray(0, 512).toString('utf8').trimStart().toLowerCase()
  if (
    head.startsWith('<!doctype html') ||
    head.startsWith('<html') ||
    head.includes('<head') ||
    head.includes('<body')
  )
    return 'That link opens a web page, not a video file. Use a direct link to the .mp4, for example a file in your GitHub Pages site.'
  return "That link isn't a video file coldopen recognizes. Use a direct link to an .mp4 or .webm file."
}

const FTYP = Buffer.from('ftyp', 'ascii')
const WEBM_MAGIC = Buffer.from([0x1a, 0x45, 0xdf, 0xa3])

/** An MP4/MOV `ftyp` box, or a WebM/Matroska EBML header. Never trust content-type for this:
 * GitHub release assets, and many redirecting hosts, serve video as application/octet-stream. */
export function sniffVideo(bytes: Buffer): boolean {
  if (bytes.length >= 4 && bytes.subarray(0, 4).equals(WEBM_MAGIC)) return true
  return bytes.length >= 8 && bytes.subarray(4, 8).equals(FTYP)
}

function numFromHeader(h: string | null): number | null {
  const n = Number(h)
  return h !== null && Number.isFinite(n) && n >= 0 ? n : null
}

/** the total size from a `Content-Range: bytes 0-1023/204800` reply, or null */
function totalFromContentRange(h: string | null): number | null {
  const m = h?.match(/\/(\d+)\s*$/)
  return m ? Number(m[1]) : null
}

/** reads up to `limit` bytes; `truncated` is true when the stream had more left */
async function readUpTo(
  body: ReadableStream<Uint8Array> | null,
  limit: number,
): Promise<{ bytes: Buffer; truncated: boolean }> {
  if (!body) return { bytes: Buffer.alloc(0), truncated: false }
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  let truncated = false
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    size += value.length
    if (size > limit) {
      truncated = true
      break
    }
  }
  await reader.cancel().catch(() => {})
  return { bytes: Buffer.concat(chunks), truncated }
}

/** one request, following redirects by hand so each hop can be checked against the SSRF guard */
async function followRedirects(
  get: typeof fetch,
  startUrl: string,
  init: RequestInit,
  allowPrivateNetworks: boolean,
): Promise<Response> {
  let at = startUrl
  for (let hop = 0; hop < 5; hop++) {
    const res = await get(at, { ...init, redirect: 'manual' })
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location')
      if (!loc) return res
      at = new URL(loc, at).toString()
      if (!allowPrivateNetworks) await assertPublicUrl(at)
      continue
    }
    return res
  }
  throw new Error('too many redirects')
}

/**
 * Is this link really a short video, not a web page a share link opens? A HEAD first (cheap, so
 * an obviously oversized file never needs downloading); when it's refused, a ranged GET stands
 * in for it and still enforces the size, by capping the stream at the limit and treating more
 * data left after that as too big.
 */
export async function checkClip(
  url: string,
  opts: MediaCheckOptions = {},
): Promise<MediaCheckResult> {
  const get = opts.fetch ?? fetch
  const maxBytes = opts.maxBytes ?? MAX_CLIP_BYTES
  const timeoutMs = opts.timeoutMs ?? 8000
  const allow = !!opts.allowPrivateNetworks

  if (!allow) {
    try {
      await assertPublicUrl(url)
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) }
    }
  }

  let headSize: number | null = null
  try {
    const head = await followRedirects(
      get,
      url,
      { method: 'HEAD', signal: AbortSignal.timeout(timeoutMs) },
      allow,
    )
    if (head.ok) headSize = numFromHeader(head.headers.get('content-length'))
  } catch {
    // HEAD refused (405, a network error, a host that only answers GET): the ranged GET below
    // is the fallback, and still catches an oversized file by capping how much it reads.
  }
  if (headSize !== null && headSize > maxBytes)
    return { ok: false, reason: sizeReason(headSize, maxBytes) }

  let res: Response
  try {
    res = await followRedirects(
      get,
      url,
      { headers: { range: `bytes=0-${maxBytes}` }, signal: AbortSignal.timeout(timeoutMs) },
      allow,
    )
  } catch (err) {
    return { ok: false, reason: err instanceof BlockedUrlError ? err.message : NOT_OPENABLE }
  }
  if (!res.ok && res.status !== 206) return { ok: false, reason: NOT_OPENABLE }

  const total =
    totalFromContentRange(res.headers.get('content-range')) ??
    numFromHeader(res.headers.get('content-length')) ??
    headSize
  const { bytes, truncated } = await readUpTo(res.body, maxBytes)
  if (truncated || (total !== null && total > maxBytes))
    return { ok: false, reason: sizeReason(total, maxBytes) }
  if (!sniffVideo(bytes)) return { ok: false, reason: notVideoReason(bytes) }
  return { ok: true }
}

/** https://github.com/<owner>/<repo>/pull/<n>, and only that */
const PR_URL =
  /^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9._-]+)\/pull\/(\d+)\/?$/

export function isPrUrl(url: string): boolean {
  return PR_URL.test(url)
}

export interface PrState {
  repo: string
  merged: boolean
}

/**
 * Whether a project's pull request merged, read from GitHub itself (no token: the public API,
 * rate-limited but good enough for one lookup on save). Null on anything but a clean answer —
 * not a PR link, a 404, a rate limit — so the caller never shows a wrong state as a true one.
 */
export async function prState(
  url: string,
  opts: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<PrState | null> {
  const m = url.match(PR_URL)
  if (!m) return null
  const [, owner, repo, n] = m
  const get = opts.fetch ?? fetch
  try {
    const res = await get(`https://api.github.com/repos/${owner}/${repo}/pulls/${n}`, {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'coldopen (+https://github.com/tiwaker9404/coldopen)',
      },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 6000),
    })
    if (!res.ok) return null
    const body = (await res.json()) as { merged?: unknown }
    if (typeof body.merged !== 'boolean') return null
    return { repo: `${owner}/${repo}`, merged: body.merged }
  } catch {
    return null
  }
}
