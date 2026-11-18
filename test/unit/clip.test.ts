import { describe, expect, it } from 'vitest'
import {
  extractArgs,
  fitPlan,
  parseFreezes,
  probeArgs,
  refusalFor,
  trimFromFreezes,
} from '../../src/render/clip.ts'

describe('fitPlan', () => {
  const FACE = 3.0
  const RECORDING = 6.5

  it.each([
    [3, FACE, { start: 0, speed: 1, take: 3 }],
    [8, FACE, { start: 0, speed: 8 / 3, take: 8 }],
    [20, FACE, { start: 5.5, speed: 3, take: 9 }],
    [60, FACE, { start: 25.5, speed: 3, take: 9 }],
    [90, FACE, { start: 40.5, speed: 3, take: 9 }],
  ])('face slot: %ss clip -> %o', (duration, slot, want) => {
    const plan = fitPlan({ duration, slot })
    expect(plan.start).toBeCloseTo(want.start, 5)
    expect(plan.speed).toBeCloseTo(want.speed, 5)
    expect(plan.take).toBeCloseTo(want.take, 5)
  })

  it.each([
    [3, RECORDING, { start: 0, speed: 1, take: 3 }],
    [8, RECORDING, { start: 0, speed: 8 / 6.5, take: 8 }],
    [20, RECORDING, { start: 0.25, speed: 3, take: 19.5 }],
    [60, RECORDING, { start: 20.25, speed: 3, take: 19.5 }],
    [90, RECORDING, { start: 35.25, speed: 3, take: 19.5 }],
  ])('recording slot: %ss clip -> %o', (duration, slot, want) => {
    const plan = fitPlan({ duration, slot })
    expect(plan.start).toBeCloseTo(want.start, 5)
    expect(plan.speed).toBeCloseTo(want.speed, 5)
    expect(plan.take).toBeCloseTo(want.take, 5)
  })

  it('never speeds past maxSpeed, however long the clip', () => {
    for (const duration of [20, 60, 90, 500]) {
      expect(fitPlan({ duration, slot: FACE }).speed).toBeLessThanOrEqual(3)
    }
  })

  it('takes the middle of the clip once the speed cap is hit', () => {
    const plan = fitPlan({ duration: 60, slot: FACE })
    const end = plan.start + plan.take
    const remaining = 60 - plan.take
    expect(plan.start).toBeCloseTo(remaining / 2, 5)
    expect(60 - end).toBeCloseTo(remaining / 2, 5)
  })

  it('a custom maxSpeed changes the cap', () => {
    const plan = fitPlan({ duration: 20, slot: 3, maxSpeed: 1.5 })
    expect(plan.speed).toBe(1.5)
    expect(plan.take).toBeCloseTo(4.5, 5)
  })

  it('trims leading and trailing still frames before any of the speed math', () => {
    // a 10s clip with the first 1s and last 2s frozen: only 7s of it is "active"
    const plan = fitPlan({ duration: 10, slot: 3.5, freeze: { start: 1, end: 2 } })
    expect(plan.start).toBe(1)
    expect(plan.speed).toBe(2)
    expect(plan.take).toBe(7)
  })
})

describe('extractArgs', () => {
  const plan = { start: 1.5, speed: 2, take: 6 }

  it('covers by scaling up then cropping to the exact size', () => {
    const args = extractArgs({
      input: 'in.mp4',
      plan,
      fps: 30,
      width: 1080,
      height: 1080,
      mode: 'cover',
      outPattern: 'out/frame-%04d.jpg',
    })
    const vf = args[args.indexOf('-vf') + 1]!
    expect(vf).toContain('force_original_aspect_ratio=increase')
    expect(vf).toContain('crop=1080:1080')
    expect(vf).not.toContain('pad=')
    expect(vf).toContain('fps=30')
  })

  it('contains by scaling down then padding to the exact size', () => {
    const args = extractArgs({
      input: 'in.mp4',
      plan,
      fps: 30,
      width: 1920,
      height: 1080,
      mode: 'contain',
      outPattern: 'out/frame-%04d.jpg',
    })
    const vf = args[args.indexOf('-vf') + 1]!
    expect(vf).toContain('force_original_aspect_ratio=decrease')
    expect(vf).toContain('pad=1920:1080')
    expect(vf).not.toContain('crop=')
  })

  it('seeks and trims to the plan, and reads no audio', () => {
    const args = extractArgs({
      input: 'in.mp4',
      plan,
      fps: 30,
      width: 100,
      height: 100,
      mode: 'cover',
      outPattern: 'out/frame-%04d.jpg',
    })
    expect(args[args.indexOf('-ss') + 1]).toBe('1.5')
    expect(args[args.indexOf('-t') + 1]).toBe('6')
    expect(args).toContain('-an')
  })

  it('speeds up the footage with setpts, in proportion to the plan', () => {
    const vf = extractArgs({
      input: 'in.mp4',
      plan: { start: 0, speed: 2.5, take: 10 },
      fps: 30,
      width: 100,
      height: 100,
      mode: 'cover',
      outPattern: 'out/%04d.jpg',
    })
    const filter = vf[vf.indexOf('-vf') + 1]!
    expect(filter).toContain('setpts=PTS/2.5')
  })

  it('skips setpts entirely when the clip already fits (speed 1)', () => {
    const vf = extractArgs({
      input: 'in.mp4',
      plan: { start: 0, speed: 1, take: 3 },
      fps: 30,
      width: 100,
      height: 100,
      mode: 'cover',
      outPattern: 'out/%04d.jpg',
    })
    const filter = vf[vf.indexOf('-vf') + 1]!
    expect(filter).not.toContain('setpts')
  })
})

describe('probeArgs', () => {
  it('asks ffprobe for the format and streams as JSON', () => {
    const args = probeArgs('clip.mp4')
    expect(args).toContain('-show_format')
    expect(args).toContain('-show_streams')
    expect(args.at(-1)).toBe('clip.mp4')
  })
})

describe('refusalFor', () => {
  it('refuses a file with no video stream', () => {
    expect(refusalFor({ duration: 10, hasVideo: false })).toMatch(/no video/)
  })

  it('refuses a clip shorter than 2s', () => {
    expect(refusalFor({ duration: 1.4, hasVideo: true })).toMatch(/at least 2s/)
  })

  it('refuses a clip longer than 90s', () => {
    expect(refusalFor({ duration: 91, hasVideo: true })).toMatch(/limit.*90s/)
  })

  it('accepts anything from 2s to 90s with a video stream', () => {
    expect(refusalFor({ duration: 2, hasVideo: true })).toBeNull()
    expect(refusalFor({ duration: 90, hasVideo: true })).toBeNull()
    expect(refusalFor({ duration: 45, hasVideo: true })).toBeNull()
  })
})

describe('freezedetect parsing', () => {
  const log = `
[freezedetect @ 0x1] freeze_start: 0
[freezedetect @ 0x1] freeze_duration: 0.8
[freezedetect @ 0x1] freeze_end: 0.8
[freezedetect @ 0x1] freeze_start: 9.1
[freezedetect @ 0x1] freeze_duration: 0.9
[freezedetect @ 0x1] freeze_end: 10
`

  it('pairs freeze_start with freeze_end into windows', () => {
    expect(parseFreezes(log)).toEqual([
      { start: 0, end: 0.8 },
      { start: 9.1, end: 10 },
    ])
  })

  it('ignores an unmatched trailing freeze_start (still running when the log was cut)', () => {
    expect(parseFreezes(`${log}\n[freezedetect @ 0x1] freeze_start: 15`)).toHaveLength(2)
  })

  it('finds only a window that touches the very start or end of the clip', () => {
    const trim = trimFromFreezes(parseFreezes(log), 10)
    expect(trim.start).toBeCloseTo(0.8, 5)
    expect(trim.end).toBeCloseTo(0.9, 5)
  })

  it('trims nothing when no freeze window touches an edge', () => {
    const middle = '[freezedetect @ 0x1] freeze_start: 4\n[freezedetect @ 0x1] freeze_end: 5\n'
    expect(trimFromFreezes(parseFreezes(middle), 10)).toEqual({ start: 0, end: 0 })
  })

  it('returns no windows from a clip with no stillness', () => {
    expect(parseFreezes('')).toEqual([])
  })
})
