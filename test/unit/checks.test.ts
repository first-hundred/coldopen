import { describe, expect, it } from 'vitest'
import type { BrandKit } from '../../src/brand/types.ts'
import { checkScript } from '../../src/script/checks.ts'
import type { Script } from '../../src/script/types.ts'
import { deterministicScript } from '../../src/script/writer.ts'
import { profile } from '../helpers/index.ts'

/**
 * A job seeker's hook says what the film is about for them, never a greeting: the sender's
 * own name already opens the film (storyboard.ts), so a greeting would say it twice.
 */

const kit = {
  name: 'Northwind Freight',
  host: 'northwindfreight.example',
  headline: "Every pallet, visible before it's late.",
  description: 'Northwind gives mid-size shippers live visibility into every pallet.',
  facts: [
    { id: 'f1', text: "Every pallet, visible before it's late.", kind: 'headline' },
    { id: 'f2', text: '38% fewer late deliveries in the first quarter', kind: 'stat' },
  ],
} as unknown as BrandKit

const candidate = profile('candidate')
const good: Script = deterministicScript(kit, candidate)

describe('a job seeker film: the hook says what it is about, never a greeting', () => {
  it.each(['Hi Northwind Freight team', 'Hey Northwind Freight', 'Hello Northwind Freight team'])(
    'fails a candidate hook that greets them ("%s")',
    (hook) => {
      const v = checkScript({ ...good, hook }, kit, candidate)
      expect(v.join(' ')).toContain('greets them')
    },
  )

  it('passes a candidate hook that names their product or team, with no greeting', () => {
    expect(checkScript({ ...good, hook: 'An idea for Northwind Freight' }, kit, candidate)).toEqual(
      [],
    )
  })

  it("the deterministic writer's own hook already complies", () => {
    expect(/^(hi|hey|hello)\b/i.test(good.hook)).toBe(false)
    expect(checkScript(good, kit, candidate)).toEqual([])
  })

  it('still lets sales, recruiter and hiring films greet them', () => {
    const sales = profile('sales')
    const script = { ...deterministicScript(kit, sales), hook: 'Hi Northwind Freight team' }
    expect(checkScript(script, kit, sales)).toEqual([])
  })
})
