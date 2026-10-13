import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { main } from './drive-relay-director-deploy-cli.mjs'

export * from './drive-relay-director-deploy-core.mjs'
export { defaultDependencies, main } from './drive-relay-director-deploy-cli.mjs'

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    if (!error.reported) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    }
    process.exitCode = 1
  })
}
