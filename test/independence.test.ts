// The runner is open source and will be split out of this monorepo at the
// alpha (ADR 0010). That split stays mechanical only if nothing under
// runner/ reaches outside it: no dependency on a cloud package, no import of
// one, no relative path, tsconfig or ESLint config that climbs out.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')
const SKIP = new Set(['node_modules', 'dist', '.turbo', 'schema', '.webtrax'])
const CODE = /\.(c|m)?(t|j)sx?$/

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue
    const path = join(dir, name)
    if (statSync(path).isDirectory()) walk(path, out)
    else out.push(path)
  }
  return out
}

const files = walk(root)
const manifests = files.filter((f) => f.endsWith('package.json'))
const runnerPackages = new Set(manifests.map((f) => JSON.parse(readFileSync(f, 'utf8')).name as string))
const inside = (path: string) => !relative(root, path).startsWith('..')

/** Import specifiers in a source file: static, dynamic, re-exports and require. */
export function specifiers(source: string): string[] {
  const found: string[] = []
  const patterns = [
    /\bfrom\s+['"]([^'"]+)['"]/g,
    /\bimport\s+['"]([^'"]+)['"]/g,
    /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]
  for (const re of patterns) for (const m of source.matchAll(re)) found.push(m[1]!)
  return found
}

describe('runner independence (ADR 0010)', () => {
  it('finds the runner packages', () => {
    expect(runnerPackages).toContain('@webtrax/protocol')
    expect(runnerPackages).toContain('@webtrax/runner-workspace')
  })

  it('depends only on runner packages among @webtrax/*', () => {
    const bad: string[] = []
    for (const file of manifests) {
      const pkg = JSON.parse(readFileSync(file, 'utf8'))
      for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
        for (const [name, version] of Object.entries<string>(pkg[field] ?? {})) {
          if (name.startsWith('@webtrax/') && !runnerPackages.has(name)) bad.push(`${relative(root, file)}: ${name}`)
          if (version.startsWith('file:') || version.startsWith('link:')) {
            const target = resolve(dirname(file), version.replace(/^(file|link):/, ''))
            if (!inside(target)) bad.push(`${relative(root, file)}: ${name} -> ${version}`)
          }
        }
      }
    }
    expect(bad).toEqual([])
  })

  it('imports nothing from outside runner/', () => {
    const bad: string[] = []
    // This file is skipped: its self-test below quotes forbidden imports on purpose.
    for (const file of files.filter((f) => CODE.test(f) && f !== import.meta.filename)) {
      for (const spec of specifiers(readFileSync(file, 'utf8'))) {
        if (spec.startsWith('.')) {
          if (!inside(resolve(dirname(file), spec))) bad.push(`${relative(root, file)}: ${spec}`)
        } else if (spec.startsWith('@webtrax/')) {
          const name = spec.split('/').slice(0, 2).join('/')
          if (!runnerPackages.has(name)) bad.push(`${relative(root, file)}: ${spec}`)
        }
      }
    }
    expect(bad).toEqual([])
  })

  it('extends only tsconfigs inside runner/', () => {
    const bad: string[] = []
    for (const file of files.filter((f) => /tsconfig.*\.json$/.test(f))) {
      const ext = JSON.parse(readFileSync(file, 'utf8')).extends as string | undefined
      if (ext && (!ext.startsWith('.') || !inside(resolve(dirname(file), ext)))) bad.push(`${relative(root, file)}: ${ext}`)
    }
    expect(bad).toEqual([])
  })

  it('is Apache-2.0 throughout', () => {
    expect(readFileSync(join(root, 'LICENSE'), 'utf8')).toContain('Apache License')
    for (const file of manifests) expect(JSON.parse(readFileSync(file, 'utf8')).license, relative(root, file)).toBe('Apache-2.0')
  })

  it('catches what it should (self-test)', () => {
    expect(specifiers(`import a from '@webtrax/domain'\nexport * from "../../packages/x"\nconst m = await import('@webtrax/db/x')`))
      .toEqual(['@webtrax/domain', '../../packages/x', '@webtrax/db/x'])
  })
})
