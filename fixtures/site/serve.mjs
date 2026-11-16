// Starts the fixture site and prints its origin, for tests outside vitest
// (the GitHub Action test in CI). Runs until killed.
import { startFixtureSite } from './server.mjs'

const site = await startFixtureSite()
console.log(site.origin)
