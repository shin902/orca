import { execFile } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

// Real Git is the oracle; Orca's tree-sha port must not validate itself.
export async function gitTreeShaInFixture(
  directory: string,
  temporaryDirectories: string[]
): Promise<string> {
  const gitDir = await mkdtemp(join(tmpdir(), 'orca-skill-hash-'))
  temporaryDirectories.push(gitDir)
  const env = {
    ...process.env,
    GIT_DIR: gitDir,
    GIT_WORK_TREE: directory,
    GIT_INDEX_FILE: join(gitDir, 'scratch-index'),
    GIT_CONFIG_GLOBAL: join(gitDir, 'no-config'),
    GIT_CONFIG_SYSTEM: join(gitDir, 'no-config')
  }
  await execFileAsync('git', ['init', '--quiet'], { env, cwd: directory })
  await execFileAsync('git', ['add', '-A'], { env, cwd: directory })
  const { stdout } = await execFileAsync('git', ['write-tree'], { env, cwd: directory })
  return stdout.trim()
}
