import { expect, it } from 'vitest'
import { FilmInputSchema } from '../../src/film.ts'
import { profile } from '../helpers/index.ts'

it('validates and retains only bounded approved opening text', () => {
  const base = { url: 'https://example.com', profile: profile('sales') }
  expect(FilmInputSchema.parse({ ...base, opening: '  Hello Alex.  ' }).opening).toBe('Hello Alex.')
  for (const opening of [
    '',
    ' '.repeat(3),
    'x'.repeat(97),
    Array(13).fill('a').join(' '),
    'Hi\nAlex',
    'Hi\u007fAlex',
  ]) {
    expect(FilmInputSchema.safeParse({ ...base, opening }).success).toBe(false)
  }
})
