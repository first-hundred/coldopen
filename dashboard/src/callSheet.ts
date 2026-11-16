/**
 * What Today's call sheet says, and the count on its tab: follow-ups due and warm-lead touches
 * due both wait on the sender, so both count, and "Nothing waiting on you" only shows when
 * neither does. Pure, so it's tested without a browser.
 */

export interface Waiting {
  /** follow-ups due today (/v1/followups) */
  followUps: number
  /** warm-lead touches due today (/v1/warm lists only the due ones) */
  warm: number
  /** films queued or rendering */
  rolling: number
  /** today's films that passed review, waiting to send (/v1/autopilot/queue's `ready`) */
  ready: number
  /** whether the sender has made any film yet */
  anyFilms: boolean
}

/** The number on Today's tab: everything due that only the sender can send */
export const dueCount = (w: Pick<Waiting, 'followUps' | 'warm'>) => w.followUps + w.warm

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** The call sheet's one line, most urgent first: today's new films, then what's due, then what's rolling */
export function callLine(w: Waiting): string {
  const parts = [
    w.ready > 0 && `${plural(w.ready, 'film ready', 'films ready')}`,
    w.followUps > 0 && `${plural(w.followUps, 'follow-up', 'follow-ups')} due`,
    w.warm > 0 && `${plural(w.warm, 'warm-lead touch', 'warm-lead touches')} due`,
    w.rolling > 0 && `${plural(w.rolling, 'film', 'films')} in production`,
  ].filter(Boolean) as string[]
  if (parts.length) return `${parts.join(', ')}.`
  return w.anyFilms
    ? 'Nothing waiting on you. Make the next film.'
    : 'Your first film is one link away.'
}
