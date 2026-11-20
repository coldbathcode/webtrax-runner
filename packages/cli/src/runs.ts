/** Runs on disk (`.webtrax/runs/<id>/run.ndjson`), shared by the CLI commands and the MCP server. */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseNdjson, type RuleMeta, type RunLine } from '@webtrax/protocol'
import { a11ySuite } from '@webtrax/suite-a11y'
import { linksSuite } from '@webtrax/suite-links'
import { performanceSuite } from '@webtrax/suite-performance'
import { securitySuite } from '@webtrax/suite-security'
import { seoSuite } from '@webtrax/suite-seo'
import { aiSuite } from '@webtrax/suite-ai'
import { contentSuite } from '@webtrax/suite-content'
import { ConfigError } from './config'

export const SUITES = [linksSuite, securitySuite, seoSuite, contentSuite, aiSuite, a11ySuite, performanceSuite]
export const RULES: RuleMeta[] = SUITES.flatMap((s) => s.rules)

export const runsDir = (root: string) => join(root, '.webtrax', 'runs')

/** Run ids (directory names) under `root`, oldest first. */
export function listRuns(root: string): string[] {
  const dir = runsDir(root)
  return existsSync(dir) ? readdirSync(dir).filter((d) => existsSync(join(dir, d, 'run.ndjson'))).sort() : []
}

/** A run by id, run directory or NDJSON path. */
export function readRun(root: string, ref: string): RunLine[] {
  const candidates = [join(runsDir(root), ref, 'run.ndjson'), resolve(root, ref, 'run.ndjson'), resolve(root, ref)]
  const file = candidates.find((c) => c.endsWith('.ndjson') && existsSync(c))
  if (!file) throw new ConfigError(`no run found at ${ref}`)
  const lines = parseNdjson(readFileSync(file, 'utf8'))
  const bad = lines.filter((l) => !l.ok)
  if (bad.length) throw new ConfigError(`${file}: ${bad.length} invalid line(s), first at line ${bad[0]!.line}`)
  return lines.flatMap((l) => (l.ok ? [l.record] : []))
}
