// Scan profiles (C06.8): each expands into spec fields that parse, the
// targeted profile follows the rules it is given, and rule selection matches
// by id or prefix.
import { describe, expect, it } from 'vitest'
import { applyScanProfile, JobSpec, ruleSelected, SCAN_PROFILE, SCAN_PROFILES, SUITES, suitesOfRules } from '../src'

describe('scan profiles', () => {
  it('each expand into a valid job spec that records the profile', () => {
    for (const id of SCAN_PROFILES) {
      const part = applyScanProfile(id)
      const spec = JobSpec.parse({
        spec_version: 1, job_id: id, target: { start_url: 'https://example.com/', ...(SCAN_PROFILE[id].urls ? { urls: ['https://example.com/a'] } : {}) },
        ...part, limits: part.limits,
      })
      expect(spec.profile).toBe(id)
      expect(Object.keys(spec.suites)).toEqual([...SCAN_PROFILE[id].suites])
      for (const s of Object.keys(spec.suites)) expect(SUITES).toContain(s)
    }
  })

  it('match the plan: quick is small and start-page only, deep covers more pages than standard', () => {
    const quick = applyScanProfile('quick')
    expect(quick.limits.max_pages).toBe(50)
    expect(quick.suites.seo?.config).toEqual({ start_only: true })
    expect(quick.suites.performance?.config).toEqual({ sample: 1 })
    expect(quick.browser).toEqual({ profiles: ['phone'] })
    expect(applyScanProfile('standard').browser).toEqual({ profiles: ['desktop', 'phone'], extra_profile_pages: 1 })
    expect(applyScanProfile('deep').suites.a11y?.config).toEqual({ sample: 200 })
    expect(SCAN_PROFILE['release-gate'].fail_on).toBe('high')
  })

  it('narrow to the suites asked for and add the caller\'s settings over the profile\'s', () => {
    const part = applyScanProfile('quick', { only: ['links', 'seo'], config: { seo: { extra: 1 } } })
    expect(Object.keys(part.suites)).toEqual(['links', 'seo'])
    expect(part.suites.seo?.config).toEqual({ start_only: true, extra: 1 })
    expect(part.browser).toBeUndefined()
    // A targeted check runs whatever suites own the rules asked about, browser ones included.
    expect(Object.keys(applyScanProfile('targeted', { only: suitesOfRules(['a11y.image_alt', 'links.broken']) }).suites)).toEqual(['links', 'a11y'])
  })

  it('select rules by id or by a prefix that ends at a dot', () => {
    expect(ruleSelected('links.broken.internal', undefined)).toBe(true)
    expect(ruleSelected('links.broken.internal', ['links.broken'])).toBe(true)
    expect(ruleSelected('links.broken.internal', ['links.broken.internal'])).toBe(true)
    expect(ruleSelected('links.broken_x', ['links.broken'])).toBe(false)
    expect(ruleSelected('seo.title.missing', ['links'])).toBe(false)
  })
})
