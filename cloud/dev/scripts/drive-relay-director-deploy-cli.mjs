import process from 'node:process'
import { spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline/promises'
import { pathToFileURL } from 'node:url'
import { createDriver, parseDriverArguments } from './drive-relay-director-deploy-core.mjs'

export function defaultDependencies() {
  return {
    run: (program, args, input) =>
      spawnSync(program, args, {
        encoding: 'utf8',
        input,
        maxBuffer: 256 * 1024 * 1024,
        stdio: ['pipe', 'pipe', 'pipe']
      }),
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)),
    print: (line) => process.stdout.write(`${line}\n`),
    prompt: async (question) => {
      const reader = createInterface({ input: process.stdin, output: process.stdout })
      try {
        return await reader.question(question)
      } finally {
        reader.close()
      }
    }
  }
}

export async function main(argv = process.argv.slice(2), deps = defaultDependencies()) {
  const driver = createDriver(parseDriverArguments(argv), deps)
  for (const [signal, code] of [
    ['SIGINT', 130],
    ['SIGTERM', 143],
    ['SIGHUP', 129]
  ]) {
    process.once(signal, () => {
      driver.interrupt(signal)
      process.exit(code)
    })
  }
  return await driver.run()
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    if (!error.reported) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    }
    process.exitCode = 1
  })
}
