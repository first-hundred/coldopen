import { describe, expect, it } from 'vitest'
import { digestOf, moreReadyMessage, TEST_MESSAGE } from '../../src/autopilot/digest.ts'

const base = {
  ready: [] as string[],
  needsLook: 0,
  followUps: 0,
  warm: 0,
  failed: [] as { company: string; reason: string }[],
  publicUrl: 'https://coldopen.example',
}

describe('the morning digest', () => {
  it('says nothing when nothing is ready and nothing is due', () => {
    expect(digestOf(base)).toBeNull()
  })

  it('names up to three ready companies, then just a count', () => {
    const one = digestOf({ ...base, ready: ['Parcelpine'] })
    expect(one!.text).toBe(
      'Good morning. 1 film ready to send (Parcelpine). Open Today: https://coldopen.example',
    )
    const many = digestOf({ ...base, ready: ['Parcelpine', 'Northwind', 'Lumen', 'Globex'] })
    expect(many!.text).toBe(
      'Good morning. 4 films ready to send (Parcelpine, Northwind, Lumen, …). Open Today: https://coldopen.example',
    )
  })

  it('joins several due things in one sentence, singular and plural', () => {
    const d = digestOf({
      ...base,
      ready: ['Parcelpine', 'Northwind'],
      needsLook: 1,
      followUps: 2,
      warm: 1,
    })
    expect(d!.text).toBe(
      'Good morning. 2 films ready to send (Parcelpine, Northwind), 1 film that needs a look, ' +
        '2 follow-ups due and 1 warm touch due. Open Today: https://coldopen.example',
    )
  })

  it('names a failed film with the plain reason, never anyone’s name or email', () => {
    const d = digestOf({ ...base, failed: [{ company: 'Lumen', reason: 'the site timed out' }] })
    expect(d!.text).toBe(
      'Good morning. 1 film failed (Lumen failed: the site timed out). Open Today: https://coldopen.example',
    )
    expect(d!.text).not.toMatch(/@/)
  })

  it('gives the same text to Slack (as `text`) and Discord (as `content`)', () => {
    const d = digestOf({ ...base, ready: ['Parcelpine'] })!
    expect(d.slack).toEqual({ text: d.text })
    expect(d.discord).toEqual({ content: d.text })
  })
})

describe('the second, shorter message', () => {
  it('says how many more are ready, or nothing when there are none', () => {
    expect(moreReadyMessage(0, 'https://coldopen.example')).toBeNull()
    expect(moreReadyMessage(6, 'https://coldopen.example')).toBe(
      '6 more films ready. Open Today: https://coldopen.example',
    )
    expect(moreReadyMessage(1, 'https://coldopen.example')).toBe(
      '1 more film ready. Open Today: https://coldopen.example',
    )
  })
})

describe('the test message', () => {
  it('has no personal details', () => {
    expect(TEST_MESSAGE).not.toMatch(/@/)
  })
})
