import { readPinnedBunVersion } from '../../tool-invocation/pinned-bun-executable.mjs'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { measurePreflightCommand } from './preflight-benchmark-command.mjs'
import { buildCounterbalancedSchedule } from '../../performance/measurement/counterbalanced-benchmark-schedule.mjs'
import { summarizeBenchmarkSamples } from '../../performance/measurement/benchmark-sample-summary.mjs'

const root = fileURLToPath(new URL('../../../..', import.meta.url))
const output = path.join(root, '.build/preflight-benchmark')
mkdirSync(output, { recursive: true })
const bun = process.env.ORCA_BENCHMARK_BUN ?? 'bun'
const sourcePath =
  'config/scripts/static-analysis/process-boundaries/check-compat-boundary-imports.mjs'
const baselineRef = process.env.ORCA_COMPAT_BASELINE_REF ?? 'HEAD^'
const baselinePath = path.join(output, 'compat-baseline.mjs')
const report = {
  sourceSha: process.env.GITHUB_SHA ?? null,
  baselineRef,
  measurements: [],
  comparisons: {},
  negativeProbe: null
}
const save = () =>
  writeFileSync(path.join(output, 'compat-boundary.json'), `${JSON.stringify(report, null, 2)}\n`)
const command = (program, args, label) =>
  measurePreflightCommand({
    program,
    args,
    label,
    root,
    output,
    env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' }
  })
async function requireSuccess(program, args, label) {
  const result = await command(program, args, label)
  if (result.code !== 0 || result.signal || result.timedOut) {
    throw new Error(`${label}: ${JSON.stringify(result)}`)
  }
  return result
}
report.bunVersion = (await requireSuccess(bun, ['--version'], 'compat-bun-version')).stdout.trim()
if (report.bunVersion !== readPinnedBunVersion(root)) {
  throw new Error(`Pin Bun ${readPinnedBunVersion(root)}`)
}
report.baselineSha = (
  await requireSuccess('git', ['rev-parse', baselineRef], 'compat-baseline-sha')
).stdout.trim()
// The check script may be new in this PR (a sync spanning its introduction), so
// there may be no baseline copy to compare against. In that case compare only the
// current script across runtimes instead of failing on the missing baseline.
const baselineResult = await command(
  'git',
  ['show', `${report.baselineSha}:${sourcePath}`],
  'compat-baseline-source'
)
const baselineSource = baselineResult.code === 0 ? baselineResult.stdout : null
if (baselineSource === null) {
  report.baselineMissing = true
}
// Both versions inspect this checkout and load the same parser and source inventory.
const baselineImportPaths = {
  './check-process-host-imports.mjs':
    'config/scripts/static-analysis/process-boundaries/check-process-host-imports.mjs',
  './static-module-specifiers.mjs':
    'config/scripts/static-analysis/module-requests/static-module-specifiers.mjs',
  './test-only-source-path.mjs':
    'config/scripts/static-analysis/process-boundaries/test-only-source-path.mjs'
}
if (baselineSource !== null) {
  writeFileSync(
    baselinePath,
    baselineSource.replace(
      /from '(\.\/[^']+)'/g,
      (_, specifier) =>
        `from '${
          pathToFileURL(
            path.resolve(
              root,
              baselineImportPaths[specifier] ?? path.posix.join('config/scripts', specifier)
            )
          ).href
        }'`
    )
  )
}
const arms = {
  ...(baselineSource !== null ? { baseline: [process.execPath, baselinePath] } : {}),
  node: [process.execPath, sourcePath],
  bun: [bun, sourcePath]
}
const comparisons = [
  ...(baselineSource !== null ? [['compat-prefilter', 'baseline', 'node']] : []),
  ['compat-runtime', 'node', 'bun']
]
for (const [comparison, first, second] of comparisons) {
  let diagnostics
  for (const [pair, order] of buildCounterbalancedSchedule(4, first, second).entries()) {
    for (const arm of order) {
      const [program, script] = arms[arm]
      const result = await requireSuccess(program, [script], `${comparison}-${pair}-${arm}`)
      const findings = `${result.stdout}${result.stderr}`
      if (diagnostics !== undefined && diagnostics !== findings) {
        throw new Error(`Diagnostics changed: ${comparison}`)
      }
      diagnostics = findings
      report.measurements.push({ comparison, pair, arm, ...result })
      save()
      console.log(JSON.stringify({ comparison, pair, arm, durationMs: result.durationMs }))
    }
  }
  report.comparisons[comparison] = Object.fromEntries(
    [first, second].map((arm) => [
      arm,
      summarizeBenchmarkSamples(
        report.measurements
          .filter((sample) => sample.comparison === comparison && sample.arm === arm)
          .map((sample) => sample.durationMs)
      )
    ])
  )
  save()
}
const probeDirectory = mkdtempSync(path.join(root, 'src/shared/preflight-compat-probe-'))
try {
  for (const [name, specifier] of [
    ['plain', '../workspace-layout/old-client'],
    ['escaped', '../workspace-layout/old-\\u0063lient/private']
  ]) {
    writeFileSync(path.join(probeDirectory, `${name}.ts`), `import '${specifier}'\n`)
  }
  let diagnostics
  for (const [arm, [program, script]] of Object.entries(arms)) {
    const result = await command(program, [script], `compat-invalid-${arm}`)
    const findings = `${result.stdout}${result.stderr}`
    if (
      result.code !== 1 ||
      result.signal ||
      result.timedOut ||
      !findings.includes('/plain.ts:') ||
      !findings.includes('/escaped.ts:')
    ) {
      throw new Error(`Compatibility check did not reject fixtures: ${JSON.stringify(result)}`)
    }
    if (diagnostics !== undefined && diagnostics !== findings) {
      throw new Error(`Negative-probe diagnostics changed: ${arm}`)
    }
    diagnostics = findings
  }
  report.negativeProbe =
    baselineSource !== null
      ? 'identical findings in baseline Node, optimized Node and optimized Bun'
      : 'identical findings in optimized Node and optimized Bun (no baseline: the check is new in this PR)'
  save()
} finally {
  rmSync(probeDirectory, { recursive: true, force: true })
}
console.log(JSON.stringify(report.comparisons))
