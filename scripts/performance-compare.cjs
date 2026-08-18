const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const baseline = JSON.parse(fs.readFileSync(path.join(root, 'performance-results', 'baseline.json'), 'utf8'))
const final = JSON.parse(fs.readFileSync(path.join(root, 'performance-results', 'final.json'), 'utf8'))
const scenario = (report, name) => report.scenarios.find((item) => item.name === name)
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
const startupValues = (report, temperature) => report.scenarios
  .filter((item) => new RegExp(`^restore-1-${temperature}(?:-|$)`).test(item.name))
  .map((item) => item.shellInteractiveMs)
const percent = (before, after) => (before - after) / before * 100
const mib = (bytes) => bytes / 1048576

const coldBefore = median(startupValues(baseline, 'cold'))
const coldAfter = median(startupValues(final, 'cold'))
const warmBefore = median(startupValues(baseline, 'warm'))
const warmAfter = median(startupValues(final, 'warm'))
const downloadBefore = scenario(baseline, 'download-progress-stress').probe.counters.storageWrites
const downloadAfter = scenario(final, 'download-progress-stress').operationCounters.delta.downloadDurableWrites
const navigationWrites = scenario(final, 'ordinary-navigation').operationCounters.delta.storageWrites
const restore250Before = mib(scenario(baseline, 'restore-250-cold').memory.workingSetBytes)
const restore250After = mib(scenario(final, 'restore-250-cold').memory.workingSetBytes)
const loaded25 = scenario(final, 'loaded-25')
const lifecycleCycles = scenario(final, 'lifecycle-cycles').lifecycleCycles

const result = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  startup: {
    cold: { baselineMedianMs: coldBefore, finalMedianMs: coldAfter, improvementPercent: percent(coldBefore, coldAfter) },
    warm: { baselineMedianMs: warmBefore, finalMedianMs: warmAfter, improvementPercent: percent(warmBefore, warmAfter) }
  },
  persistence: {
    navigationDurableWrites: navigationWrites,
    downloadStressBaselineWrites: downloadBefore,
    downloadStressOperationWrites: downloadAfter,
    downloadWriteReductionPercent: percent(downloadBefore, downloadAfter),
    downloadProgressEvents: scenario(final, 'download-progress-stress').operationCounters.delta.downloadProgressEvents
  },
  tabs: {
    restore250WorkingSetMiB: { baseline: restore250Before, final: restore250After, improvementPercent: percent(restore250Before, restore250After) },
    restore250ProcessCount: scenario(final, 'restore-250-cold').memory.processCount,
    switch100Ms: {
      baseline: scenario(baseline, 'restore-100-cold').tabSwitchMs,
      final: scenario(final, 'restore-100-cold').tabSwitchMs
    },
    loaded25AfterClose: {
      beforeMiB: mib(loaded25.memory.workingSetBytes),
      afterMiB: mib(loaded25.memoryAfterClose.workingSetBytes),
      processCountBefore: loaded25.memory.processCount,
      processCountAfter: loaded25.memoryAfterClose.processCount
    },
    loaded50IdleCpuPercent: {
      baseline: scenario(baseline, 'loaded-50').idleCpu.visiblePercent,
      final: scenario(final, 'loaded-50').idleCpu.visiblePercent
    },
    lifecycleCycles
  },
  bundle: {
    baselineJavaScriptBytes: baseline.bundle.jsBytes,
    finalJavaScriptBytes: final.bundle.jsBytes,
    improvementPercent: percent(baseline.bundle.jsBytes, final.bundle.jsBytes)
  }
}
result.acceptance = {
  coldStartupAtLeast25Percent: result.startup.cold.improvementPercent >= 25,
  downloadWritesAtLeast90PercentLower: result.persistence.downloadWriteReductionPercent >= 90,
  navigationAtMostOneWrite: navigationWrites <= 1,
  largeRestoreIsLightweight: result.tabs.restore250ProcessCount <= 10,
  closeReleasesMemoryAndProcesses: result.tabs.loaded25AfterClose.afterMiB < result.tabs.loaded25AfterClose.beforeMiB && result.tabs.loaded25AfterClose.processCountAfter < result.tabs.loaded25AfterClose.processCountBefore,
  lifecycleCyclesDoNotLeakProcesses: lifecycleCycles.after.processCount <= lifecycleCycles.before.processCount
}

fs.writeFileSync(path.join(root, 'performance-results', 'comparison.json'), `${JSON.stringify(result, null, 2)}\n`)
console.log(JSON.stringify(result, null, 2))
if (Object.values(result.acceptance).some((passed) => !passed)) process.exitCode = 1
