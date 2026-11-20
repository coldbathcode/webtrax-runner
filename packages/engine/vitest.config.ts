import { defineConfig } from 'vitest/config'

// These tests crawl a local fixture site. On a busy CI machine a crawl that takes one second
// alone has taken more than five (pipeline 164), so the default limit is too tight.
export default defineConfig({ test: { testTimeout: 20_000 } })
