import { execFile as execFileCb, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { assertPublicUrl, BlockedUrlError } from '../brand/guard.ts'
import { MAX_CLIP_BYTES, sniffVideo } from '../profile/media.ts'
import { NonRetryableError } from '../runtime/errors.ts'
import { FPS } from './render.ts'

/**
 * Turns a clip URL (a job seeker's face, a project's recording) into frames a composition can
 * show at any time t: window.__seek(t) screenshots the page, so a <video> element can't stay
 * in step (see src/render/render.ts). ffmpeg extracts the frames once; the result is named by
 * its inputs so a killed worker never redownloads or re-encodes a finished clip.
 */

const FFMPEG = process.env.FFMPEG_PATH ?? 'ffmpeg'
const FFPROBE = process.env.FFPROBE_PATH ?? 'ffprobe'
const execFile = promisify(execFileCb)

const NOT_OPENABLE = "Couldn't open that link. Check it's a direct, public link to the video."

/* -------------------------------------------------------------- pure argument builders */

export interface FitPlan {
  /** seconds into the source to start reading */
  start: number
  /** how much to speed up the footage (1 = unchanged, never above the cap) */
  speed: number
  /** seconds of source footage to read, before speeding up */
  take: number
}

/**
 * How to cut a clip of `duration` seconds down to `slot` seconds: speed it up (never past
 * `maxSpeed`), and once the cap is hit, take the middle of the clip rather than the start, so a
 * long recording isn't always introduced by its slowest opening seconds. `freeze` trims still
 * leading/trailing frames (a paused screen recording, a frozen last frame of a face clip) out of
 * the duration before any of that math runs.
 */
export function fitPlan(opts: {
  duration: number
  slot: number
  maxSpeed?: number
  freeze?: { start: number; end: number }
}): FitPlan {
  const maxSpeed = opts.maxSpeed ?? 3
  const leadTrim = opts.freeze?.start ?? 0
  const tailTrim = opts.freeze?.end ?? 0
  const active = Math.max(0, opts.duration - leadTrim - tailTrim)
  const needed = opts.slot > 0 ? active / opts.slot : 0
  // shorter than (or exactly) the slot already: play it at normal speed, in full
  if (needed <= 1) return { start: leadTrim, speed: 1, take: active }
  const speed = Math.min(maxSpeed, needed)
  const take = Math.min(active, speed * opts.slot)
  const start = leadTrim + (active - take) / 2
  return { start, speed, take }
}

/** ffprobe args to read a file's duration and whether it has a video stream. */
export function probeArgs(file: string): string[] {
  return ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]
}

/** ffmpeg args that run the freezedetect filter and discard the (decoded) output. */
export function freezeArgs(
  file: string,
  opts: { noise?: string; minSeconds?: number } = {},
): string[] {
  return [
    '-i',
    file,
    '-vf',
    `freezedetect=n=${opts.noise ?? '-60dB'}:d=${opts.minSeconds ?? 0.5}`,
    '-map',
    '0:v:0',
    '-f',
    'null',
    '-',
  ]
}

/** ffmpeg args that read `plan`'s slice of `input`, fit it to width x height, and write JPEG frames. */
export function extractArgs(opts: {
  input: string
  plan: FitPlan
  fps: number
  width: number
  height: number
  mode: 'cover' | 'contain'
  outPattern: string
}): string[] {
  const { input, plan, fps, width, height, mode, outPattern } = opts
  const fit =
    mode === 'cover'
      ? `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`
      : `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`
  const speed = plan.speed !== 1 ? `,setpts=PTS/${plan.speed}` : ''
  return [
    '-ss',
    String(plan.start),
    '-t',
    String(plan.take),
    '-i',
    input,
    '-an',
    '-vf',
    `${fit}${speed},fps=${fps}`,
    '-q:v',
    '2',
    outPattern,
  ]
}

/** Why a probed file can't be used, in plain words — or null when it's fine. Pure: no ffmpeg. */
export function refusalFor(probed: { duration: number; hasVideo: boolean }): string | null {
  if (!probed.hasVideo) return 'That file has no video in it.'
  if (probed.duration < 2)
    return `This clip is ${probed.duration.toFixed(1)}s long; coldopen needs at least 2s.`
  if (probed.duration > 90)
    return `This clip is ${Math.round(probed.duration)}s long; coldopen's limit for a clip is 90s.`
  return null
}

export interface FreezeWindow {
  start: number
  end: number
}

/** Parses ffmpeg's freezedetect log lines (freeze_start / freeze_end) into still-frame windows. */
export function parseFreezes(log: string): FreezeWindow[] {
  const starts = [...log.matchAll(/freeze_start:\s*([\d.]+)/g)].map((m) => Number(m[1]))
  const ends = [...log.matchAll(/freeze_end:\s*([\d.]+)/g)].map((m) => Number(m[1]))
  const n = Math.min(starts.length, ends.length)
  const out: FreezeWindow[] = []
  for (let i = 0; i < n; i++) out.push({ start: starts[i]!, end: ends[i]! })
  return out
}

/** How much still footage sits at the very start and very end of the clip, for fitPlan's freeze. */
export function trimFromFreezes(
  windows: FreezeWindow[],
  duration: number,
): { start: number; end: number } {
  const lead = windows.find((w) => w.start <= 0.05)
  const tail = windows.find((w) => w.end >= duration - 0.05)
  return { start: lead ? lead.end : 0, end: tail ? duration - tail.start : 0 }
}

/* --------------------------------------------------------------------------- the runner */

export interface PrepareClipOptions {
  url: string
  /** the scene's length in seconds (3.0 for a face clip, 6.5 for a project recording) */
  slot: number
  size: { width: number; height: number }
  mode: 'cover' | 'contain'
  /** the clip's frame directory is created under here, named by its own hash */
  dir: string
  fetch?: typeof fetch
  fps?: number
  allowPrivateNetworks?: boolean
  maxSpeed?: number
}

export interface PrepareClipResult {
  /** the frame directory: frame-0001.jpg, frame-0002.jpg, ... */
  dir: string
  frames: number
  fps: number
  hash: string
  /** the clip's length once sped up to fit the slot */
  seconds: number
}

/** The sender's claim that a clip failed in a way retrying can't fix; never thrown past film.ts. */
export type ClipOutcome = PrepareClipResult | { failed: string }

function clipHash(
  url: string,
  params: { slot: number; size: { width: number; height: number }; mode: string; fps: number },
): string {
  return createHash('sha256')
    .update(JSON.stringify({ url, ...params }))
    .digest('hex')
    .slice(0, 24)
}

async function readManifest(file: string): Promise<Omit<PrepareClipResult, 'dir'> | null> {
  try {
    const raw = JSON.parse(await readFile(file, 'utf8')) as {
      status?: string
      frames?: number
      fps?: number
      hash?: string
      seconds?: number
    }
    if (raw.status === 'complete' && typeof raw.frames === 'number')
      return { frames: raw.frames, fps: raw.fps!, hash: raw.hash!, seconds: raw.seconds! }
  } catch {
    // no manifest, or a partial one from a killed worker: redo this clip below
  }
  return null
}

/** One request, following redirects by hand so each hop is checked against the SSRF guard. */
async function downloadClip(
  url: string,
  opts: { fetch: typeof fetch; timeoutMs: number; allowPrivateNetworks: boolean },
): Promise<Buffer> {
  try {
    if (!opts.allowPrivateNetworks) await assertPublicUrl(url)
    let at = url
    let res: Response
    for (let hop = 0; ; hop++) {
      if (hop > 5) throw new Error('too many redirects')
      res = await opts.fetch(at, {
        redirect: 'manual',
        signal: AbortSignal.timeout(opts.timeoutMs),
      })
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location')
        if (!loc) break
        at = new URL(loc, at).toString()
        if (!opts.allowPrivateNetworks) await assertPublicUrl(at)
        continue
      }
      break
    }
    if (!res.ok) throw new Error(NOT_OPENABLE)

    const reader = res.body?.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
        size += value.length
        // stop reading past the limit: a 20 MB+ host never gets to finish sending it to us
        if (size > MAX_CLIP_BYTES) {
          await reader.cancel().catch(() => {})
          throw new NonRetryableError(
            `This video is larger than ${Math.round(MAX_CLIP_BYTES / 1e6)} MB; coldopen's limit for a clip is ${Math.round(MAX_CLIP_BYTES / 1e6)} MB.`,
          )
        }
      }
    }
    const bytes = Buffer.concat(chunks)
    if (!sniffVideo(bytes)) {
      throw new NonRetryableError(
        "That link isn't a video file coldopen recognizes. Use a direct link to an .mp4 or .webm file.",
      )
    }
    return bytes
  } catch (err) {
    if (err instanceof NonRetryableError) throw err
    if (err instanceof BlockedUrlError) throw new NonRetryableError(err.message)
    if (err instanceof Error && err.name === 'TimeoutError')
      throw new NonRetryableError("This video took too long to download; coldopen's limit is 30s.")
    throw new NonRetryableError(NOT_OPENABLE)
  }
}

async function probeFile(file: string): Promise<{ duration: number; hasVideo: boolean }> {
  const { stdout } = await execFile(FFPROBE, probeArgs(file), { maxBuffer: 10 * 1024 * 1024 })
  const json = JSON.parse(stdout) as {
    format?: { duration?: string }
    streams?: { codec_type?: string }[]
  }
  return {
    duration: Number(json.format?.duration ?? 0),
    hasVideo: (json.streams ?? []).some((s) => s.codec_type === 'video'),
  }
}

/** freezedetect's log lines come at ffmpeg's default (info) level; -loglevel error would hide them */
function ffmpegVerbose(args: string[]): Promise<string> {
  return new Promise((resolve) => {
    const proc = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'info', ...args], {
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let out = ''
    proc.stderr?.on('data', (d) => {
      out += d.toString()
    })
    // a freezedetect pass is a heuristic, not load-bearing: if it can't run, treat it as "no freezes"
    proc.on('error', () => resolve(''))
    proc.on('close', () => resolve(out))
  })
}

async function detectFreezes(file: string): Promise<FreezeWindow[]> {
  const log = await ffmpegVerbose(freezeArgs(file))
  return parseFreezes(log)
}

function ffmpegRun(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let err = ''
    proc.stderr?.on('data', (d) => {
      err += d.toString()
    })
    proc.on('error', (e) => reject(new Error(`could not start ffmpeg (${FFMPEG}): ${e.message}`)))
    proc.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${err.slice(-800)}`)),
    )
  })
}

/**
 * Downloads a clip once, checks it, cuts it to fit its slot and extracts frames at the slot's
 * size — then returns instantly on replay. The frame directory is named by the URL and the
 * slot's own parameters (not the plan ffprobe derives), so a repeat call can check for it
 * before any network or ffmpeg work runs; when it's missing (a different machine, a different
 * disk) it rebuilds from the URL.
 */
export async function prepareClip(opts: PrepareClipOptions): Promise<PrepareClipResult> {
  const fps = opts.fps ?? FPS
  const fetchFn = opts.fetch ?? fetch
  const hash = clipHash(opts.url, { slot: opts.slot, size: opts.size, mode: opts.mode, fps })
  const frameDir = join(opts.dir, hash)
  const manifestFile = join(frameDir, 'manifest.json')

  const existing = await readManifest(manifestFile)
  if (existing) return { dir: frameDir, ...existing }

  await rm(frameDir, { recursive: true, force: true })
  await mkdir(frameDir, { recursive: true })
  const srcFile = join(opts.dir, `${hash}.src`)
  try {
    const bytes = await downloadClip(opts.url, {
      fetch: fetchFn,
      timeoutMs: 30_000,
      allowPrivateNetworks: opts.allowPrivateNetworks ?? false,
    })
    await writeFile(srcFile, bytes)

    const probed = await probeFile(srcFile)
    const refusal = refusalFor(probed)
    if (refusal) throw new NonRetryableError(refusal)

    const freezes = await detectFreezes(srcFile)
    const trim = trimFromFreezes(freezes, probed.duration)
    const plan = fitPlan({
      duration: probed.duration,
      slot: opts.slot,
      maxSpeed: opts.maxSpeed ?? 3,
      freeze: trim,
    })

    const outPattern = join(frameDir, 'frame-%04d.jpg')
    await ffmpegRun(
      extractArgs({
        input: srcFile,
        plan,
        fps,
        width: opts.size.width,
        height: opts.size.height,
        mode: opts.mode,
        outPattern,
      }),
    )

    const frames = (await readdir(frameDir)).filter((f) => f.startsWith('frame-')).length
    const result = { frames, fps, hash, seconds: plan.take / plan.speed }
    await writeFile(manifestFile, JSON.stringify({ status: 'complete', ...result }))
    return { dir: frameDir, ...result }
  } finally {
    await rm(srcFile, { force: true })
  }
}
