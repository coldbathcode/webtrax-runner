// JSON Schema for tools outside TypeScript. Regenerate with `pnpm gen:schema`
// (UPDATE_SCHEMA=1); otherwise this test fails when schema/ is out of date.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { JobSpec, PROTOCOL_VERSION, RuleMeta, RunLine } from '../src'

const dir = join(import.meta.dirname, '..', 'schema')
const id = (name: string) => `https://webtrax.dev/schema/runner/v${PROTOCOL_VERSION}/${name}.json`

/** Job specs are written by people and tools (input shape, defaults optional); run lines are what the runner wrote (output shape). */
const SCHEMAS = {
  'job-spec': { schema: JobSpec, io: 'input' },
  'run-line': { schema: RunLine, io: 'output' },
  'rule-meta': { schema: RuleMeta, io: 'output' },
} as const

const render = (name: keyof typeof SCHEMAS) => {
  const { schema, io } = SCHEMAS[name]
  const json = z.toJSONSchema(schema, { io, unrepresentable: 'any', target: 'draft-2020-12' })
  return `${JSON.stringify({ $id: id(name), ...json }, null, 2)}\n`
}

describe('JSON Schema export', () => {
  for (const name of Object.keys(SCHEMAS) as (keyof typeof SCHEMAS)[]) {
    it(`schema/${name}.json is up to date`, () => {
      const file = join(dir, `${name}.json`)
      const fresh = render(name)
      if (process.env.UPDATE_SCHEMA) {
        mkdirSync(dir, { recursive: true })
        writeFileSync(file, fresh)
      }
      expect(existsSync(file), `missing ${file}: run pnpm gen:schema`).toBe(true)
      expect(readFileSync(file, 'utf8'), 'schema/ is stale: run pnpm gen:schema').toBe(fresh)
    })
  }

  it('describes every run line type', () => {
    const runLine = JSON.parse(render('run-line'))
    const types = (runLine.oneOf ?? runLine.anyOf).map((s: { properties: { type: { const: string } } }) => s.properties.type.const)
    expect(types.sort()).toEqual(['artifact', 'finding', 'link', 'metric', 'page', 'run', 'snapshot', 'summary'])
  })
})
