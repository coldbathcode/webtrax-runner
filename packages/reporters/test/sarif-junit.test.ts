import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import Ajv from 'ajv'
import { describe, expect, it } from 'vitest'
import { buildReport, renderJunit, renderSarif } from '../src'
import { RECORDS, RULES } from './sample'

const report = buildReport(RECORDS, RULES)
const require = createRequire(import.meta.url)

describe('SARIF 2.1.0', () => {
  const sarif = JSON.parse(renderSarif(report))

  it('validates against the official OASIS schema', () => {
    const ajv = new Ajv({ schemaId: 'id', meta: false, allErrors: true, unknownFormats: 'ignore' })
    ajv.addMetaSchema(require('ajv/lib/refs/json-schema-draft-04.json'))
    const schema = JSON.parse(readFileSync(join(import.meta.dirname, 'schema', 'sarif-schema-2.1.0.json'), 'utf8'))
    const valid = ajv.validate(schema, sarif)
    expect(ajv.errors ?? [], JSON.stringify(ajv.errors?.slice(0, 3))).toEqual([])
    expect(valid).toBe(true)
  })

  it('has one result per finding, levels by severity, fingerprints and rule help', () => {
    const run = sarif.runs[0]
    expect(run.results.map((x: { ruleId: string; level: string }) => [x.ruleId, x.level])).toEqual([
      ['links.broken.internal', 'error'], ['security.header.csp_missing', 'warning'], ['seo.lang.missing', 'note'], ['seo.unknown_rule', 'note'],
    ])
    expect(run.results[0].partialFingerprints['webtrax/v1']).toBe('a'.repeat(64))
    expect(run.results[0].relatedLocations).toHaveLength(2)
    const rule = run.tool.driver.rules.find((x: { id: string }) => x.id === 'security.header.csp_missing')
    expect(rule.helpUri).toBe('https://docs.webtrax.dev/rules/security-header-csp-missing/')
    expect(rule.properties['security-severity']).toBe('5.5')
    for (const x of run.results) expect(run.tool.driver.rules[x.ruleIndex].id).toBe(x.ruleId)
  })
})

describe('JUnit', () => {
  const xml = renderJunit(report)
  it('has a suite per check suite and a failing case per finding', () => {
    expect(xml).toMatch(/^<\?xml version="1.0" encoding="UTF-8"\?>\n<testsuites /)
    expect(xml.match(/<testsuite /g)).toHaveLength(3)
    expect(xml.match(/<failure /g)).toHaveLength(4)
    expect(xml).toContain('<testsuite name="webtrax.links" tests="1" failures="1"')
    expect(xml).toContain('classname="links.broken.internal" name="https://shop.example/old"')
  })
  it('escapes markup from the crawled site', () => {
    expect(xml).not.toContain('<b>offer</b>')
    expect(xml).toContain('&lt;b&gt;offer&lt;/b&gt;')
  })
  it('is well-formed XML (every element closed)', () => {
    const opens = (xml.match(/<(testsuites|testsuite|testcase|failure)[ >]/g) ?? []).length
    const selfClosed = (xml.match(/<testcase [^>]*\/>/g) ?? []).length
    const closes = (xml.match(/<\/(testsuites|testsuite|testcase|failure)>/g) ?? []).length
    expect(opens - selfClosed).toBe(closes)
  })
})
