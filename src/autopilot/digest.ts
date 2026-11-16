/**
 * The morning message: one line to Slack or Discord once today's Autopilot films have
 * rendered, saying what's ready, what needs a look, and what's due elsewhere (follow-ups,
 * warm leads). Pure: no clock, no network, no names of people or email addresses, just
 * company names and counts. The caller posts `text` the same way the view pings do (Slack
 * reads `text`, Discord reads `content`); `slack` and `discord` are that same body, split out
 * so each service's shape is easy to check on its own.
 */

export interface DigestInput {
  /** companies whose films passed review and are ready to send, best first */
  ready: string[]
  /** films that need a look before they can go out */
  needsLook: number
  /** sent films due a follow-up today */
  followUps: number
  /** warm-lead touches due today (thank-yous, proof of work, stay-in-touch, referral asks/bumps) */
  warm: number
  /** today's Autopilot films that failed to render, with the plain reason */
  failed: { company: string; reason: string }[]
  /** the app, to open Today */
  publicUrl: string
}

export interface Digest {
  text: string
  slack: { text: string }
  discord: { content: string }
}

/** company names shown before "…"; the rest are just a count */
const SHOWN = 3
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
const names = (ns: string[]) =>
  ns.length <= SHOWN ? ns.join(', ') : `${ns.slice(0, SHOWN).join(', ')}, …`
const sentence = (parts: string[]) =>
  parts.length <= 1 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`

/**
 * The morning digest, or null when there's nothing to say (nothing ready, nothing due, nothing
 * failed): the caller posts nothing in that case.
 */
export function digestOf(i: DigestInput): Digest | null {
  const parts: string[] = []
  if (i.ready.length)
    parts.push(`${plural(i.ready.length, 'film')} ready to send (${names(i.ready)})`)
  if (i.needsLook)
    parts.push(`${plural(i.needsLook, 'film')} that need${i.needsLook === 1 ? 's' : ''} a look`)
  if (i.followUps) parts.push(`${plural(i.followUps, 'follow-up')} due`)
  if (i.warm) parts.push(`${plural(i.warm, 'warm touch')} due`)
  if (i.failed.length) {
    const said = i.failed.map((f) => `${f.company} failed: ${f.reason}`).join('; ')
    parts.push(`${plural(i.failed.length, 'film')} failed (${said})`)
  }
  if (!parts.length) return null
  const text = `Good morning. ${sentence(parts)}. Open Today: ${i.publicUrl}`
  return { text, slack: { text }, discord: { content: text } }
}

/** The short second line, once the rest of today's films are done; null when there's none to add */
export function moreReadyMessage(moreReady: number, publicUrl: string): string | null {
  if (moreReady <= 0) return null
  return `${plural(moreReady, 'more film')} ready. Open Today: ${publicUrl}`
}

/** "Send a test message" on Account → Autopilot */
export const TEST_MESSAGE =
  "This is a test message from coldopen's Autopilot. If you can see this, the webhook works."
