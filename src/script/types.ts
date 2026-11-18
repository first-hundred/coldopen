import { z } from 'zod'

/** a LinkedIn profile page: https://www.linkedin.com/in/<name>, with or without www */
export const LINKEDIN = /^https:\/\/(www\.)?linkedin\.com\/in\/[A-Za-z0-9\-_%]{2,100}\/?$/

/** Who is sending the film, and what they offer. Lives in a JSON file per team or person. */
export const ProfileSchema = z.object({
  /**
   * sales: a seller pitches a company. candidate: a job seeker pitches a company.
   * recruiter: a recruiter pitches a role to one candidate; proof and points are the
   * candidate's own record (from their résumé), and the film speaks to them as "you".
   * hiring: a team announces an open role to everyone (a LinkedIn post); the points are the
   * role's own lines and the proof is numbers from the company's site, filled in at film time.
   */
  preset: z.enum(['sales', 'candidate', 'recruiter', 'hiring']).default('sales'),
  sender: z.object({
    name: z.string().min(1),
    company: z.string().optional(),
    role: z.string().optional(),
    /**
     * a job seeker's LinkedIn profile and photo, shown on their film's page so whoever opens it
     * knows who sent it. The photo is a link to an image already online (no uploads).
     */
    linkedin: z
      .string()
      .regex(LINKEDIN, 'a LinkedIn link looks like https://www.linkedin.com/in/your-name')
      .optional(),
    photo: z
      .string()
      .regex(/^https:\/\/\S{4,300}$/, 'a photo link starts with https://')
      .optional(),
    /**
     * a short clip of the sender saying hi (2-15s, played silent): a job seeker's face, not
     * just their name, on the film's page. Checked against the SSRF guard and sniffed by its
     * first bytes (see src/profile/media.ts), never trusted by content-type alone.
     */
    clip: z
      .object({
        url: z.string().regex(/^https:\/\/\S{4,300}$/, 'a clip link starts with https://'),
        caption: z
          .string()
          .trim()
          .refine((s) => s.split(/\s+/).filter(Boolean).length <= 8, 'a caption is at most 8 words')
          .optional(),
      })
      .optional(),
  }),
  /** recruiter films: the candidate the film is made for */
  recipient: z
    .object({ name: z.string().trim().min(1).max(80), role: z.string().max(80).optional() })
    .optional(),
  /** one line: what you offer, in the recipient's terms */
  offer: z.string().min(3).max(120),
  /** value props / strengths the script may tailor (never invent new ones) */
  points: z.array(z.string().min(3).max(120)).min(2).max(6),
  /** hard evidence; the film shows these verbatim, the model only picks which */
  proof: z
    .array(
      z.object({
        value: z.string().min(1).max(12),
        label: z.string().min(3).max(60),
        /** where it happened ("Rail Inc.", "Deloitte"); context is what makes a number credible */
        where: z.string().min(2).max(40).optional(),
        /**
         * what they did to get it, starting with a verb ("Built containerized ETL with Docker
         * and PostgreSQL"): a stranger needs the act, not just the number. Shown under it.
         */
        did: z.string().min(12).max(90).optional(),
      }),
    )
    .min(1)
    .max(8),
  cta: z.object({
    line: z.string().min(3).max(60),
    contact: z.string().min(3).max(80),
    /** a booking link (Calendly, Cal.com...): the share page's main button */
    book: z
      .string()
      .regex(/^https:\/\/\S{4,300}$/, 'a booking link starts with https://')
      .optional(),
  }),
  /**
   * things they built, with a link: each film shows the one closest to the company and role
   * on its share page and in the email ("Something I built that's close to what you do")
   */
  projects: z
    .array(
      z.object({
        name: z.string().trim().min(2).max(60),
        url: z.string().regex(/^https:\/\/\S{4,300}$/, 'a project link starts with https://'),
        /** one line on what it does, in plain words */
        line: z.string().trim().min(3).max(120),
        /** a screen recording of this project, 90s or under, so a stranger sees it run */
        clip: z
          .string()
          .regex(/^https:\/\/\S{4,300}$/, 'a recording link starts with https://')
          .optional(),
        /**
         * whether the project's pull request merged, read from GitHub on save
         * (src/profile/media.ts's prState). The server sets this; a client's own value is
         * always discarded and recomputed, so it's never a claim someone could type in.
         */
        pr: z
          .object({
            repo: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+$/),
            merged: z.boolean(),
          })
          .optional(),
      }),
    )
    .max(8)
    .optional(),
  /**
   * something you built that made this film, so messages and the end card can say so (for
   * example coldopen). Unlike projects, it's about the film itself, not the company's work.
   */
  creator: z
    .object({
      name: z.string().trim().min(2).max(40),
      url: z
        .string()
        .regex(/^https:\/\/\S{4,300}$/, 'a link to what you built starts with https://'),
      /** one line on what it is, in plain words */
      line: z.string().trim().min(3).max(120),
    })
    .optional(),
  /** one line someone said about their work: a stranger's word for it, not the sender's own */
  quote: z
    .object({
      text: z.string().trim().min(10).max(140),
      who: z.string().trim().min(2).max(60),
      role: z.string().trim().min(2).max(80),
    })
    .optional(),
  /** one thing about them that isn't on the résumé, for the film's end card */
  aside: z.string().trim().min(3).max(60).optional(),
  /** schools they went to ("Duke University"): who to reach includes alumni at the company */
  schools: z.array(z.string().trim().min(2).max(60)).max(4).optional(),
  /** skills and tools they have, in their words ("Kubernetes", "Salesforce"): counted by Fit check */
  skills: z.array(z.string().trim().min(1).max(40)).max(40).optional(),
  /** optional sender brand for the end card */
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
})
export type Profile = z.infer<typeof ProfileSchema>

/** What the model writes. Short lines plus pointers into sources it may not alter. */
export const ScriptSchema = z.object({
  hook: z.string().describe('2-6 words, greets the company by name'),
  noticed: z.string().describe('one specific observation about their homepage, max 12 words'),
  insight: z.object({
    factId: z.string().describe('id of the fact from their site to feature, e.g. "f3"'),
    why: z.string().describe('max 14 words: why that fact matters for what the sender offers'),
  }),
  pitch: z.object({
    headline: z.string().describe('max 10 words'),
    points: z
      .array(z.string())
      .min(2)
      .max(3)
      .describe('each max 10 words, tailored from the profile points'),
  }),
  proof: z
    .array(z.number().int().min(0))
    .min(1)
    .max(3)
    .describe('indices into the profile proof list'),
  cta: z.string().describe('max 8 words'),
})
export type Script = z.infer<typeof ScriptSchema>

export interface ScriptMeta {
  model: string
  rounds: number
  violations: string[][]
  /** every line came from the deterministic writer */
  usedFallback: boolean
  /** lines the model couldn't get right, swapped for the deterministic writer's version */
  replaced: string[]
}
