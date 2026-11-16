import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { emailWithFilm, withBackupLink } from '../../src/share/embed.ts'
import {
  type AutopilotNeedsLook,
  type AutopilotQueue,
  type AutopilotReady,
  ago,
  api,
  type Film,
  type Messages,
  media,
  send,
} from './api.ts'
import { Copy } from './FilmPanel.tsx'
import { safeUrl } from './safe.ts'
import { ErrorNote, useToast } from './ui.tsx'

/** cards shown in full before "the rest are good, not great" */
const SHOWN = 10
/** LinkedIn's rough weekly cap on connection requests: past this, lead with email instead */
const LINKEDIN_WEEKLY_LIMIT = 90

/**
 * Today's new films, on Today above Network this week: Autopilot's picks from the last 3 days
 * that passed review, each with everything it takes to send it in under two minutes, and the
 * ones that need a look first. Shown only when there's something here.
 */
export function ReadyToSend({ onOpen }: { onOpen: (id: string) => void }) {
  const q = useQuery({
    queryKey: ['autopilot-queue'],
    queryFn: () => api<AutopilotQueue>('/v1/autopilot/queue'),
  })
  const d = q.data
  if (!d || (d.ready.length === 0 && d.needsLook.length === 0)) return null
  const shown = d.ready.slice(0, SHOWN)
  const rest = d.ready.length - shown.length
  const leadWithEmail = d.sentThisWeek >= LINKEDIN_WEEKLY_LIMIT
  return (
    <section className="films ready-to-send" aria-labelledby="ready-title">
      <div className="films-head">
        <h2 id="ready-title">Today’s films</h2>
        <p className="rate">
          {d.made} of {d.perDay} made today
        </p>
      </div>
      {leadWithEmail && (
        <p className="jobs-note">
          You’ve sent {d.sentThisWeek} LinkedIn requests since Monday, close to its weekly limit, so
          these lead with email instead.
        </p>
      )}
      {shown.length > 0 && (
        <ul className="job-list">
          {shown.map((item) => (
            <li key={item.film.id}>
              <ReadyCard item={item} leadWithEmail={leadWithEmail} onOpen={onOpen} />
            </li>
          ))}
        </ul>
      )}
      {rest > 0 && (
        <p className="small muted">The rest are good, not great. Skip them on a busy day.</p>
      )}
      {d.needsLook.length > 0 && (
        <>
          <h3>Needs a look</h3>
          <ul className="job-list">
            {d.needsLook.map((item) => (
              <li key={item.film.id}>
                <NeedsLookCard item={item} onOpen={onOpen} />
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}

/** "Their latest: What they published, Mar" */
function latestLine(hw: AutopilotReady['homework']): string | null {
  if (!hw) return null
  const when = hw.date ? `, ${ago(`${hw.date}T12:00:00Z`)}` : ''
  return `Their latest: ${hw.title}${when}`
}

/** Who to send it to: a name when one's saved, else the first group's searches to run yourself */
function WhoFor({ film, who }: { film: Film; who: AutopilotReady['who'] }) {
  if (film.recipient)
    return (
      <p className="small">
        Writing to <b>{film.recipient.name}</b>
      </p>
    )
  if (!who || who.searches.length === 0) return null
  return (
    <p className="small">
      {who.searches.slice(0, 3).map((s, i) => (
        <span key={s.url}>
          {i > 0 && ' · '}
          <a href={safeUrl(s.url)} target="_blank" rel="noreferrer">
            {s.label}
          </a>
        </span>
      ))}
    </p>
  )
}

function ReadyCard({
  item,
  leadWithEmail,
  onOpen,
}: {
  item: AutopilotReady
  leadWithEmail: boolean
  onOpen: (id: string) => void
}) {
  const { film, who } = item
  const qc = useQueryClient()
  const toast = useToast()
  const questionId = `ready-question-${film.id}`
  const [question, setQuestion] = useState('')
  const m = useQuery({
    queryKey: ['messages', film.id],
    queryFn: () => api<Messages>(`/v1/films/${film.id}/messages`),
    staleTime: Number.POSITIVE_INFINITY,
  })
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['autopilot-queue'] })
    void qc.invalidateQueries({ queryKey: ['films'] })
    void qc.invalidateQueries({ queryKey: ['targets'] })
  }
  // gone from the list straight away; the server catches up
  const drop = () =>
    qc.setQueryData<AutopilotQueue>(['autopilot-queue'], (d) =>
      d ? { ...d, ready: d.ready.filter((x) => x.film.id !== film.id) } : d,
    )
  const sent = useMutation({
    mutationFn: () => send('PUT', `/v1/films/${film.id}/outreach`, { status: 'sent' }),
    onMutate: drop,
    onSettled: refresh,
  })
  const undo = useMutation({
    mutationFn: () => send('POST', '/v1/targets/unhide', { site: film.host ?? film.url }),
    onSettled: refresh,
  })
  // 60 days: long enough that a one-off "no thanks" sticks, short enough it isn't forever
  const skip = useMutation({
    mutationFn: () => send('POST', '/v1/targets/hide', { site: film.host ?? film.url, days: 60 }),
    onMutate: drop,
    onSuccess: () =>
      toast({
        text: `${film.company ?? 'That company'} is off your list.`,
        action: { label: 'Undo', run: () => undo.mutate() },
      }),
    onSettled: refresh,
  })
  const saveQuestion = useMutation({
    mutationFn: () => send('PUT', `/v1/films/${film.id}/homework`, { question: question.trim() }),
    onSuccess: () => {
      toast({ text: 'Saved.' })
      void qc.invalidateQueries({ queryKey: ['messages', film.id] })
    },
  })
  const again = useMutation({
    mutationFn: () => send<Messages>('POST', `/v1/films/${film.id}/messages/rewrite`),
    onSuccess: (msgs) => qc.setQueryData(['messages', film.id], msgs),
  })
  const msgs = m.data
  const link = film.share ?? ''
  const rich = msgs ? emailWithFilm(msgs.email.body, link, film.company) : null
  const emailCopy = msgs && (
    <Copy
      className={leadWithEmail ? 'primary' : undefined}
      html={rich?.html}
      text={rich?.plain ?? msgs.email.body}
      label="Copy email with the film"
      done="Email copied with the film. Paste it into your email"
      fallback="Your browser can only copy text, so the link is where the film goes"
    />
  )
  return (
    <article className="job ready-film">
      {film.files && (
        <span className="ready-media">
          <img src={media(film, 'preview.gif')} alt="" loading="lazy" />
        </span>
      )}
      <div className="job-what">
        <button type="button" className="link title-link" onClick={() => onOpen(film.id)}>
          {film.company ?? film.host ?? film.url}
        </button>
        {msgs?.rewrite && <span className="tag quiet">Written from a template</span>}
        <WhoFor film={film} who={who} />
        {latestLine(item.homework) && <p className="small muted">{latestLine(item.homework)}</p>}
        <div className="ready-question">
          <label htmlFor={questionId} className="small">
            Your question (optional)
          </label>
          <div className="ready-question-row">
            <input
              id={questionId}
              value={question}
              maxLength={200}
              placeholder="Are most customers calling the API directly, or using the app?"
              onChange={(e) => setQuestion(e.target.value)}
            />
            <button
              type="button"
              disabled={saveQuestion.isPending || question.trim().length < 10}
              onClick={() => saveQuestion.mutate()}
            >
              Save
            </button>
            {msgs?.rewrite && (
              <button type="button" onClick={() => again.mutate()} disabled={again.isPending}>
                {again.isPending ? 'Writing…' : 'Write it again'}
              </button>
            )}
          </div>
        </div>
        <ErrorNote error={sent.error ?? skip.error ?? saveQuestion.error ?? again.error} inline />
      </div>
      <div className="job-do">
        {msgs &&
          (leadWithEmail ? (
            <>
              {emailCopy}
              <Copy text={msgs.linkedin} label="Copy note" done="Note copied" />
            </>
          ) : (
            <>
              <Copy className="primary" text={msgs.linkedin} label="Copy note" done="Note copied" />
              {msgs.afterAccept && (
                <Copy
                  text={withBackupLink(msgs.afterAccept, link)}
                  label="Copy after-accept message"
                  done="Message copied"
                />
              )}
              {emailCopy}
            </>
          ))}
        <button type="button" onClick={() => sent.mutate()} disabled={sent.isPending}>
          Mark sent
        </button>
        <button
          type="button"
          className="link"
          onClick={() => skip.mutate()}
          disabled={skip.isPending}
          aria-label={`Skip this company: hide ${film.company ?? 'it'}`}
        >
          Skip this company
        </button>
      </div>
    </article>
  )
}

function NeedsLookCard({
  item,
  onOpen,
}: {
  item: AutopilotNeedsLook
  onOpen: (id: string) => void
}) {
  const { film, flags } = item
  return (
    <article className="job needs-look">
      <div className="job-what">
        <b>{film.company ?? film.host ?? film.url}</b>
        <ul className="small warm-flags">
          {flags.map((f) => (
            <li key={`${f.code}${f.text}`}>{f.text}</li>
          ))}
        </ul>
      </div>
      <div className="job-do">
        <button type="button" className="primary" onClick={() => onOpen(film.id)}>
          Review
        </button>
      </div>
    </article>
  )
}
