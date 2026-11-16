/**
 * The `webtrax` executable. First Ctrl-C stops the crawl and reports what it
 * found (partial); a second exits at once.
 */
import { main } from './main'

const controller = new AbortController()
let interrupts = 0
process.on('SIGINT', () => {
  interrupts += 1
  if (interrupts === 1) {
    process.stderr.write('\nStopping: finishing the report with what was found (Ctrl-C again to quit now)\n')
    controller.abort()
  } else process.exit(130)
})

main(process.argv.slice(2), {
  stdout: (t) => process.stdout.write(t),
  stderr: (t) => process.stderr.write(t),
  cwd: process.cwd(),
  tty: process.stdout.isTTY === true && !process.env.NO_COLOR,
  signal: controller.signal,
}).then(
  (code) => { process.exitCode = code },
  (error: unknown) => {
    process.stderr.write(`webtrax: unexpected error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`)
    process.exitCode = 70
  },
)
