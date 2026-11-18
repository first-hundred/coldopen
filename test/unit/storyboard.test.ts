import { describe, expect, it } from 'vitest'
import type { BrandKit } from '../../src/brand/types.ts'
import type { PrepareClipResult } from '../../src/render/clip.ts'
import { buildStoryboard, pickWork, sceneKinds } from '../../src/script/storyboard.ts'
import type { Profile, Script } from '../../src/script/types.ts'
import { deterministicScript } from '../../src/script/writer.ts'
import { profile } from '../helpers/index.ts'

/**
 * A job seeker's storyboard: the sender first, the company's fact in 4 seconds, then up to
 * 8 seconds on something they built (step 3 of "the job seeker's storyboard").
 */

const kit = {
  name: 'LangSmith Engine',
  host: 'langsmithengine.example',
  headline: 'Ship agents your team can trust.',
  description: 'LangSmith Engine gives AI teams an agent runtime with evals built in.',
  facts: [
    { id: 'f1', text: 'Ship agents your team can trust.', kind: 'headline' },
    { id: 'f2', text: '40% fewer failed agent runs in the first month', kind: 'stat' },
  ],
} as unknown as BrandKit

const script: Script = {
  hook: 'An agent runtime idea for LangSmith Engine',
  noticed: 'LangSmith Engine promises agents your team can trust',
  insight: {
    factId: 'f2',
    why: "LangSmith Engine's agent runs are where I'd start: a log of every run",
  },
  pitch: {
    headline: "What I'd build next for LangSmith Engine",
    points: [
      "I'd put an agent on failed runs — like the refund agent I built",
      "I'd log every run — like the chaos tests I ran",
    ],
  },
  proof: [0, 1, 2],
  cta: 'Trade notes on agent runtimes?',
}

const PROJECT = {
  name: 'AgentWatch',
  url: 'https://github.com/alex/agentwatch',
  line: 'Flags failed agent runs and retries them automatically',
}

const CREATOR = {
  name: 'coldopen',
  url: 'https://tiwaker9404.github.io/coldopen/',
  line: 'Paste a company website, get a 30-second film made for them',
}

function withWork(): Profile {
  const base = profile('candidate')
  return {
    ...base,
    quote: {
      text: 'Shipped the integration faster than anyone we had worked with',
      who: 'Jamie Park',
      role: 'Engineering manager, Acme',
    },
    aside: 'I restore old motorcycles on weekends',
    proof: [
      ...base.proof.slice(0, 2),
      { value: 'Weekly', label: 'releases shipped to the agent runtime' },
    ],
    projects: [PROJECT],
  }
}

describe('a job seeker storyboard: related project', () => {
  const board = buildStoryboard(kit, withWork(), script)

  it('opens on the sender, points at one fact in 4 seconds, and gives 8 seconds to the work', () => {
    expect(sceneKinds(board)).toEqual(['hook', 'insight', 'pitch', 'work', 'proof', 'cta'])
    expect(board.scenes.find((s) => s.kind === 'insight')!.dur).toBeLessThanOrEqual(4.0)
    expect(board.duration).toBe(29.0)
  })

  it('the hook is the sender, not a greeting; sub is the model line', () => {
    const hook = board.scenes[0]!
    expect(hook.kind).toBe('hook')
    expect(hook.kind === 'hook' && hook.text).toBe('Alex Rivera, Forward deployed engineer')
    expect(hook.kind === 'hook' && hook.sub).toBe(script.hook)
  })

  it('the insight scene carries the thumbnail, noticed line and why emphasis', () => {
    const insight = board.scenes.find((s) => s.kind === 'insight')!
    expect(insight.kind === 'insight' && insight.thumb).toEqual({ host: kit.host })
    expect(insight.kind === 'insight' && insight.noticed).toBe(script.noticed)
    expect(insight.kind === 'insight' && insight.emphasis).toBe('why')
  })

  it('the work scene shows the related project, not a recording (none prepared)', () => {
    const work = board.scenes.find((s) => s.kind === 'work')!
    expect(work.kind === 'work' && work.mode).toBe('project')
    expect(work.kind === 'work' && work.name).toBe('AgentWatch')
    expect(work.kind === 'work' && work.url).toBe(PROJECT.url)
    expect(work.kind === 'work' && work.frames).toBeUndefined()
  })

  it('proof drops stats with no digit ("Weekly" never shows) and carries the quote', () => {
    const proof = board.scenes.find((s) => s.kind === 'proof')!
    expect(proof.kind === 'proof' && proof.stats.map((s) => s.value)).not.toContain('Weekly')
    expect(proof.kind === 'proof' && proof.quote).toEqual(withWork().quote)
  })

  it('the end card carries the aside', () => {
    const cta = board.scenes.find((s) => s.kind === 'cta')!
    expect(cta.kind === 'cta' && cta.aside).toBe('I restore old motorcycles on weekends')
  })
})

describe('a job seeker storyboard: no project and no creator', () => {
  it('has no work scene, pitch takes 6 seconds, and totals 22 seconds', () => {
    const p = profile('candidate')
    const s = deterministicScript(kit, p)
    const board = buildStoryboard(kit, p, s)
    expect(sceneKinds(board)).toEqual(['hook', 'insight', 'pitch', 'proof', 'cta'])
    expect(board.scenes.find((x) => x.kind === 'pitch')!.dur).toBe(6.0)
    expect(board.duration).toBe(22.0)
  })
})

describe('a job seeker storyboard: the creator stands in for the work', () => {
  it('shows the creator in the work scene and drops the end-card line, to avoid saying it twice', () => {
    const p = { ...profile('candidate'), creator: CREATOR }
    const board = buildStoryboard(kit, p, deterministicScript(kit, p))
    const work = board.scenes.find((s) => s.kind === 'work')!
    expect(work.kind === 'work' && work.mode).toBe('creator')
    expect(work.kind === 'work' && work.name).toBe(CREATOR.name)
    const cta = board.scenes.find((s) => s.kind === 'cta')!
    expect(cta.kind === 'cta' && cta.made).toBeUndefined()
  })
})

describe('the clips step feeds the hook, the bubble and the work scene', () => {
  const frames: PrepareClipResult = {
    dir: 'd/clip',
    frames: 90,
    fps: 30,
    hash: 'abc123',
    seconds: 3,
  }

  it('a prepared face shows in the hook and becomes the bubble', () => {
    const p = withWork()
    const board = buildStoryboard(kit, p, script, { clips: { face: frames } })
    const hook = board.scenes[0]!
    expect(hook.kind === 'hook' && hook.face).toEqual(frames)
    expect(board.bubble).toEqual(frames)
  })

  it('a failed face clip falls back to the sender photo for the bubble', () => {
    const p = { ...withWork(), sender: { ...withWork().sender, photo: 'https://x.example/me.jpg' } }
    const board = buildStoryboard(kit, p, script, { clips: { face: { failed: 'no face' } } })
    expect(board.scenes[0]!.kind === 'hook' && board.scenes[0]!.face).toBeUndefined()
    expect(board.bubble).toEqual({ photo: 'https://x.example/me.jpg' })
  })

  it('a prepared recording makes the work scene mode "recording"', () => {
    const p = withWork()
    const board = buildStoryboard(kit, p, script, { clips: { recording: frames } })
    const work = board.scenes.find((s) => s.kind === 'work')!
    expect(work.kind === 'work' && work.mode).toBe('recording')
    expect(work.kind === 'work' && work.frames).toEqual(frames)
  })

  it('a failed recording falls back to mode "project", with no frames', () => {
    const p = withWork()
    const board = buildStoryboard(kit, p, script, { clips: { recording: { failed: 'nope' } } })
    const work = board.scenes.find((s) => s.kind === 'work')!
    expect(work.kind === 'work' && work.mode).toBe('project')
    expect(work.kind === 'work' && work.frames).toBeUndefined()
  })
})

describe('pickWork', () => {
  it('picks the project closest to the company over the creator', () => {
    const p = { ...withWork(), creator: CREATOR }
    expect(pickWork(p, kit)).toEqual({
      kind: 'project',
      project: { ...PROJECT, shared: expect.any(Array) },
    })
  })

  it('falls back to the creator, with or without a clip, when no project is related', () => {
    const noClip = { ...profile('candidate'), creator: CREATOR }
    expect(pickWork(noClip, kit)).toEqual({ kind: 'creator', creator: CREATOR })
    const withClip = {
      ...profile('candidate'),
      creator: { ...CREATOR, clip: 'https://x.example/demo.mp4' },
    }
    expect(pickWork(withClip, kit)).toEqual({ kind: 'creator', creator: withClip.creator })
  })

  it('input.project, when it names a real project, wins over relatedWork', () => {
    const other = {
      name: 'Unrelated',
      url: 'https://example.com/x',
      line: 'Nothing to do with this',
    }
    const p = { ...withWork(), projects: [other, PROJECT] }
    expect(pickWork(p, kit, 'Unrelated')).toEqual({ kind: 'project', project: other })
  })

  it('an override that names no real project is ignored', () => {
    const p = withWork()
    expect(pickWork(p, kit, 'Does not exist')).toEqual({
      kind: 'project',
      project: { ...PROJECT, shared: expect.any(Array) },
    })
  })

  it('picks none with no project and no creator', () => {
    expect(pickWork(profile('candidate'), kit)).toEqual({ kind: 'none' })
  })
})

describe('sales, recruiter and hiring storyboards are unchanged', () => {
  it('still have the same six scenes in the same order', () => {
    const sales = profile('sales')
    const board = buildStoryboard(kit, sales, deterministicScript(kit, sales))
    expect(sceneKinds(board)).toEqual(['hook', 'site', 'insight', 'pitch', 'proof', 'cta'])
  })
})
