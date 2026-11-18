import type { BrandKit, Fact } from '../brand/types.ts'
import { type Project, relatedWork } from '../profile/related.ts'
import type { ClipOutcome, PrepareClipResult } from '../render/clip.ts'
import type { Profile, Script } from './types.ts'

export type Scene =
  | {
      kind: 'hook'
      dur: number
      text: string
      sub: string
      /** a job seeker's film: the sender's own face, from the clips step (src/render/clip.ts) */
      face?: PrepareClipResult
    }
  | {
      kind: 'site'
      dur: number
      caption: string
      host: string
      /** the fact the caption is about, to point at on the page (the headline when unknown) */
      focus?: string
    }
  | {
      kind: 'insight'
      dur: number
      value: string | null
      text: string
      /** the host, or "your <title> post" for a requirement (the messages read this) */
      source: string
      /** under the quote, where it's from: "From their changelog, Oct 2026" */
      caption: string
      /** the page it's from, for the share page to link (https only) */
      sourceUrl?: string
      why: string
      /** a job seeker's film: the screenshot (what the site scene showed), in this scene instead */
      thumb?: { host: string; focus?: string }
      /** a job seeker's film: script.noticed, carried here for the share page (no site scene) */
      noticed?: string
      /** a job seeker's film: the renderer makes "why" the headline, not the quoted fact */
      emphasis?: 'why'
    }
  | { kind: 'pitch'; dur: number; from: string; headline: string; points: string[] }
  | {
      kind: 'work'
      dur: number
      /** a project's recording, a project with none, or the sender's own tool (the creator) */
      mode: 'recording' | 'project' | 'creator'
      name: string
      line: string
      url: string
      pr?: { repo: string; merged: boolean }
      /** the clips step's frames, when the recording prepared */
      frames?: PrepareClipResult
    }
  | {
      kind: 'proof'
      dur: number
      stats: { value: string; label: string; where?: string; did?: string }[]
      /** a line above the numbers; recruiter films say whose record they are */
      heading?: string
      /** a job seeker's film: one line someone said about their work */
      quote?: { text: string; who: string; role: string }
    }
  | {
      kind: 'cta'
      dur: number
      line: string
      contact: string
      signoff: string
      /**
       * a job seeker who built the tool that made the film: under the ask, "Made with <name>,
       * which I built", and a link to it on the share page (https only). Left out when the work
       * scene already is the creator, so the film doesn't say it twice.
       */
      made?: { name: string; url: string }
      /** a job seeker's film: one thing about them that isn't on the résumé */
      aside?: string
    }

/**
 * The kinds of scene this storyboard actually has, in order. A sales, recruiter or hiring film
 * always has the same six; a job seeker's varies (no site scene, a work scene only sometimes),
 * so code that used to assume six reads this instead of indexing into `scenes` by position.
 */
export const sceneKinds = (board: Pick<Storyboard, 'scenes'>): Scene['kind'][] =>
  board.scenes.map((s) => s.kind)

export interface Storyboard {
  company: string
  sender: string
  /** recruiter films: the candidate it was made for (the header's "for ...") */
  recipient?: string
  /** the header's right-hand label, when it isn't "for <who>" (hiring films: "Now hiring") */
  header?: string
  scenes: Scene[]
  duration: number
  /**
   * a job seeker's film: a small face in the corner of scenes between the hook and the end
   * card, so the sender has a face in every film. The clips step's frames, or, with no face
   * clip, their photo as a still.
   */
  bubble?: PrepareClipResult | { photo: string }
}

/** "38% fewer late deliveries" -> { value: "38%", rest: "fewer late deliveries" } */
export function splitStat(text: string): { value: string; rest: string } | null {
  const m = text.match(/^([$€£]?\d[\d,.]*(?:%|\+|x|k|m)?\+?)\s+(.{6,})$/i)
  if (!m) return null
  return { value: m[1]!, rest: m[2]!.replace(/\.$/, '') }
}

const SKIP = new Set(
  'your their the and for with from that this what about homepage site page shows says leads opens'.split(
    ' ',
  ),
)
/** words that carry meaning, plural or not ("trucks" and "truck" match) */
const contentWords = (t: string, skip: Set<string> = SKIP) =>
  (t.toLowerCase().match(/[a-z][a-z'-]{3,}/g) ?? [])
    .filter((w) => !skip.has(w))
    .map((w) => w.replace(/(?<=[a-z]{3})s$/, ''))
const numbers = (t: string) => (t.match(/\d[\d,.]*/g) ?? []).map((n) => n.replace(/[,.]/g, ''))

/**
 * Which fact on the page the "noticed" line is about, so the homepage scene can point at it.
 * A number in the line decides it ("93,000 vendors"); otherwise the fact sharing the most
 * words with it. Only facts the film can show (on the first screen, or with a close-up).
 */
export function noticedFact(kit: BrandKit, noticed: string) {
  const showable = kit.facts.filter(
    (f) => f.shot || (f.box && f.box.y + f.box.h <= kit.screenshot.height),
  )
  const nums = numbers(noticed).filter((n) => n.length > 0 && n !== '0')
  if (nums.length) {
    const hit = showable.find((f) => nums.some((n) => numbers(f.text).includes(n)))
    if (hit) return hit
  }
  // their own name is in most lines, so it says nothing about which one
  const skip = new Set([...SKIP, ...kit.name.toLowerCase().split(/\s+/)])
  const words = new Set(contentWords(noticed, skip))
  if (words.size === 0) return null
  let best: { fact: (typeof showable)[number]; score: number } | null = null
  for (const f of showable) {
    const shared = new Set(contentWords(f.text, skip).filter((w) => words.has(w))).size
    const score = shared / words.size
    if (score >= 0.5 && (!best || score > best.score)) best = { fact: f, score }
  }
  return best?.fact ?? null
}

const MONTHS = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ')
/** "2026-10-28" -> "Oct 2026" */
export const monthOf = (iso: string) => {
  const m = iso.match(/^(\d{4})-(\d{2})/)
  return m ? `${MONTHS[Number(m[2]) - 1]} ${m[1]}` : ''
}

const PLACE: Record<string, string> = {
  homepage: 'homepage',
  docs: 'docs',
  blog: 'blog',
  changelog: 'changelog',
  engineering: 'engineering blog',
  podcast: 'podcast, episode notes',
  news: 'newsroom',
}

/**
 * Where the quoted fact is from, in the words under it: "From their homepage", "From their
 * changelog, Oct 2026", "From their podcast, episode notes, Sep 2026", "From your Analyst post".
 * The date shows only when the source gives one. A film made by the company itself (hiring,
 * recruiter) says "our". Facts saved before sources were kept are from the homepage or the post.
 */
export function captionFor(
  fact: Pick<Fact, 'kind' | 'source'>,
  opts: { own?: boolean; job?: string } = {},
): string {
  const kind = fact.source?.kind ?? (fact.kind === 'requirement' ? 'job' : 'homepage')
  if (kind === 'job') {
    const title = fact.source?.title ?? opts.job
    return title ? `From ${opts.own ? 'our' : 'your'} ${title} post` : 'From the job post'
  }
  const when = fact.source?.date ? monthOf(fact.source.date) : ''
  return `From ${opts.own ? 'our' : 'their'} ${PLACE[kind]}${when ? `, ${when}` : ''}`
}

/** a source link the share page may show: their own https page, nothing else */
const httpsUrl = (u: string | undefined) => (u && /^https:\/\/\S{4,300}$/.test(u) ? u : undefined)

/** "Could we talk this week" is a question; the end card shouldn't lose its question mark */
export function asked(line: string): string {
  const t = line.trim().replace(/[.!]+$/, '')
  return /^(could|can|would|will|shall|should|do|does|did|are|is|may|might|want|open to|free)\b/i.test(
    t,
  ) && !t.endsWith('?')
    ? `${t}?`
    : line.trim()
}

export type WorkPick =
  | { kind: 'project'; project: Project }
  | { kind: 'creator'; creator: NonNullable<Profile['creator']> }
  | { kind: 'none' }

/**
 * What a job seeker's work scene shows: the project closest to this company and role
 * (relatedWork), or, with no related project, the tool they built that made the film (so
 * coldopen's own film shows coldopen). `override` is `input.project` (film.ts): it wins when
 * it names one of the sender's projects. Pure, so film.ts can call it before the clips step
 * (to know which recording to prepare) and buildStoryboard can call it again after preparing
 * clips, and get the same pick both times — a replay never disagrees with itself.
 */
export function pickWork(
  profile: Pick<Profile, 'projects' | 'creator'>,
  kit: Parameters<typeof relatedWork>[1],
  override?: string,
): WorkPick {
  const forced = override ? profile.projects?.find((p) => p.name === override) : undefined
  if (forced) return { kind: 'project', project: forced }
  const related = relatedWork(profile, kit)
  if (related) return { kind: 'project', project: related }
  if (profile.creator) return { kind: 'creator', creator: profile.creator }
  return { kind: 'none' }
}

export interface BuildStoryboardOptions {
  /** the clips step's output (src/render/clip.ts): the sender's face and/or the work recording */
  clips?: { face?: ClipOutcome; recording?: ClipOutcome }
  /** input.project (film.ts): forces which project's recording the work scene shows */
  project?: string
}

/** a successful clip outcome, or undefined when it's missing or failed to prepare */
const preparedClip = (c: ClipOutcome | undefined): PrepareClipResult | undefined =>
  c && !('failed' in c) ? c : undefined

/**
 * Deterministic assembly. The model's lines go where they belong, and everything factual
 * comes straight from its source: the quote from the site, the proof from the profile.
 */
export function buildStoryboard(
  kit: BrandKit,
  profile: Profile,
  script: Script,
  opts: BuildStoryboardOptions = {},
): Storyboard {
  if (profile.preset === 'candidate') return buildCandidateStoryboard(kit, profile, script, opts)
  const fact = kit.facts.find((f) => f.id === script.insight.factId) ?? kit.facts[0]!
  // a requirement is their words, shown as a quote even when it has a number in it
  const stat = fact.kind === 'requirement' ? null : splitStat(fact.text)
  const from = profile.sender.company
    ? `${profile.sender.name}, ${profile.sender.company}`
    : profile.sender.name
  const recruiter = profile.preset === 'recruiter'
  const hiring = profile.preset === 'hiring'
  const them = profile.recipient?.name
  const scenes: Scene[] = [
    {
      kind: 'hook',
      dur: 3.2,
      text: script.hook.replace(/[.,]$/, ''),
      sub: hiring
        ? kit.job
          ? `Now hiring: ${kit.job.title}`
          : 'An open role on our team'
        : recruiter
          ? kit.job
            ? `About our ${kit.job.title} role`
            : `A 30-second film from ${kit.name}`
          : kit.job
            ? `For your ${kit.job.title} role`
            : `A 30-second film for ${kit.name}`,
    },
    (() => {
      const focus = noticedFact(kit, script.noticed)
      return {
        kind: 'site' as const,
        dur: 5.2,
        caption: script.noticed.replace(/\.$/, ''),
        host: kit.host,
        ...(focus ? { focus: focus.id } : {}),
      }
    })(),
    {
      kind: 'insight',
      dur: 5.4,
      value: stat?.value ?? null,
      text: stat ? stat.rest : fact.text.replace(/^["“]|["”]$/g, ''),
      // a requirement is quoted from the job post, not the homepage
      source:
        fact.kind === 'requirement' && kit.job
          ? `${recruiter ? 'our' : 'your'} ${kit.job.title} post`
          : kit.host,
      caption: captionFor(fact, {
        own: recruiter || hiring,
        ...(kit.job ? { job: kit.job.title } : {}),
      }),
      ...(httpsUrl(fact.source?.url) ? { sourceUrl: httpsUrl(fact.source?.url)! } : {}),
      why: script.insight.why.replace(/\.$/, ''),
    },
    {
      kind: 'pitch',
      dur: 6.0,
      from,
      headline: script.pitch.headline.replace(/\.$/, ''),
      points: script.pitch.points.map((x) => x.replace(/\.$/, '')),
    },
    // a hiring film shows the company's own numbers, and skips the scene when the site has none
    ...(hiring && !script.proof.some((i) => profile.proof[i])
      ? []
      : [
          {
            kind: 'proof' as const,
            dur: 4.8,
            stats: script.proof.map((i) => profile.proof[i]!).filter(Boolean),
            ...(recruiter
              ? { heading: 'What caught our eye' }
              : hiring
                ? { heading: `${kit.name}, by the numbers` }
                : {}),
          },
        ]),
    {
      kind: 'cta',
      dur: 4.6,
      line: asked(script.cta),
      contact: profile.cta.contact,
      signoff: hiring
        ? `Posted by ${profile.sender.name} at ${profile.sender.company ?? kit.name}`
        : recruiter
          ? `Made for ${them ?? 'you'} by ${profile.sender.name} at ${profile.sender.company ?? kit.name}`
          : `Made for ${kit.name} by ${profile.sender.name}${profile.sender.company ? ` at ${profile.sender.company}` : ''}`,
    },
  ]
  return {
    company: kit.name,
    sender: from,
    ...(recruiter && them ? { recipient: them } : {}),
    ...(hiring ? { header: 'Now hiring' } : {}),
    scenes,
    duration: Math.round(scenes.reduce((a, s) => a + s.dur, 0) * 10) / 10,
  }
}

/**
 * A job seeker's storyboard: the sender first (the hook is who they are, not a greeting), the
 * company's fact in 4 seconds flat, then up to 8 seconds on something they built. No site
 * scene: the screenshot moves into the insight scene as `thumb`.
 */
function buildCandidateStoryboard(
  kit: BrandKit,
  profile: Profile,
  script: Script,
  opts: BuildStoryboardOptions,
): Storyboard {
  const fact = kit.facts.find((f) => f.id === script.insight.factId) ?? kit.facts[0]!
  const stat = fact.kind === 'requirement' ? null : splitStat(fact.text)
  const from = profile.sender.company
    ? `${profile.sender.name}, ${profile.sender.company}`
    : profile.sender.name

  const face = preparedClip(opts.clips?.face)
  const recording = preparedClip(opts.clips?.recording)

  const pick = pickWork(profile, kit, opts.project)
  const work: Scene | null =
    pick.kind === 'project'
      ? {
          kind: 'work',
          dur: 8.0,
          mode: recording ? 'recording' : 'project',
          name: pick.project.name,
          line: pick.project.line,
          url: pick.project.url,
          ...(pick.project.pr ? { pr: pick.project.pr } : {}),
          ...(recording ? { frames: recording } : {}),
        }
      : pick.kind === 'creator'
        ? {
            kind: 'work',
            dur: 8.0,
            mode: 'creator',
            name: pick.creator.name,
            line: pick.creator.line,
            url: pick.creator.url,
            ...(recording ? { frames: recording } : {}),
          }
        : null

  const focus = noticedFact(kit, script.noticed)
  // "Weekly" and other labels with no number don't read as a result on screen
  const proofStats = script.proof.map((i) => profile.proof[i]!).filter((p) => /\d/.test(p.value))

  const scenes: Scene[] = [
    {
      kind: 'hook',
      dur: 3.0,
      text: profile.sender.role
        ? `${profile.sender.name}, ${profile.sender.role}`
        : profile.sender.name,
      sub: script.hook.replace(/[.,]$/, ''),
      ...(face ? { face } : {}),
    },
    {
      kind: 'insight',
      dur: 4.0,
      value: stat?.value ?? null,
      text: stat ? stat.rest : fact.text.replace(/^["“]|["”]$/g, ''),
      // a requirement is quoted from the job post, not the homepage
      source: fact.kind === 'requirement' && kit.job ? `your ${kit.job.title} post` : kit.host,
      caption: captionFor(fact, { ...(kit.job ? { job: kit.job.title } : {}) }),
      ...(httpsUrl(fact.source?.url) ? { sourceUrl: httpsUrl(fact.source?.url)! } : {}),
      why: script.insight.why.replace(/\.$/, ''),
      thumb: { host: kit.host, ...(focus ? { focus: focus.id } : {}) },
      noticed: script.noticed.replace(/\.$/, ''),
      emphasis: 'why',
    },
    {
      kind: 'pitch',
      dur: work ? 5.0 : 6.0,
      from,
      headline: script.pitch.headline.replace(/\.$/, ''),
      points: script.pitch.points.map((x) => x.replace(/\.$/, '')),
    },
    ...(work ? [work] : []),
    ...(proofStats.length
      ? [
          {
            kind: 'proof' as const,
            dur: 4.4,
            stats: proofStats,
            ...(profile.quote ? { quote: profile.quote } : {}),
          },
        ]
      : []),
    {
      kind: 'cta',
      dur: 4.6,
      line: asked(script.cta),
      contact: profile.cta.contact,
      signoff: `Made for ${kit.name} by ${profile.sender.name}${profile.sender.company ? ` at ${profile.sender.company}` : ''}`,
      // the work scene already is the creator: saying "made with" again would repeat it
      ...(profile.creator && pick.kind !== 'creator'
        ? { made: { name: profile.creator.name, url: profile.creator.url } }
        : {}),
      ...(profile.aside ? { aside: profile.aside } : {}),
    },
  ]

  const bubble = face ?? (profile.sender.photo ? { photo: profile.sender.photo } : undefined)

  return {
    company: kit.name,
    sender: from,
    scenes,
    duration: Math.round(scenes.reduce((a, s) => a + s.dur, 0) * 10) / 10,
    ...(bubble ? { bubble } : {}),
  }
}
