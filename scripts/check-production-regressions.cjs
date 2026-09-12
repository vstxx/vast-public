const fs = require('node:fs')
const path = require('node:path')
const root = path.join(__dirname, '..', 'performance-results')
const beforeName = process.argv[2] || 'production-before-final'
const afterName = process.argv[3] || 'production-after-final'
const read = name => JSON.parse(fs.readFileSync(path.join(root, name + '.json'), 'utf8'))
const before = read(beforeName), after = read(afterName)
const scenario = (report, name) => { const value=report.scenarios.find(s=>s.name===name); if(!value) throw new Error('Missing '+name); return value }
const median = values => [...values].sort((a,b)=>a-b)[Math.floor(values.length/2)]
const startup = (report, temperature, pick) => median(report.scenarios.filter(s=>new RegExp(`^restore-1-${temperature}(?:-|$)`).test(s.name)).map(pick))
const checks = []
function check(name, passed, before, after, limit) { checks.push({name,passed,before,after,limit}) }
function relative(name, before, after, ratio = 1.25, noise = 0) { const limit=Math.max(before*ratio,before+noise); check(name,Number.isFinite(after)&&after<=limit,before,after,limit) }
for(const temperature of ['cold','warm']) {
  relative(`${temperature} startup median ms`, startup(before,temperature,s=>s.shellInteractiveMs), startup(after,temperature,s=>s.shellInteractiveMs),1.25,100)
  relative(`${temperature} FCP median ms`, startup(before,temperature,s=>s.paint['first-contentful-paint']),startup(after,temperature,s=>s.paint['first-contentful-paint']),1.25,100)
  relative(`${temperature} renderer task seconds`,startup(before,temperature,s=>s.rendererMetrics.TaskDuration),startup(after,temperature,s=>s.rendererMetrics.TaskDuration),1.25,.05)
  relative(`${temperature} long-task duration ms`,startup(before,temperature,s=>s.rendererLongTasks.totalDurationMs),startup(after,temperature,s=>s.rendererLongTasks.totalDurationMs),1.25,100)
}
const initial = report=>report.bundle.files.find(f=>/renderer[/\\]assets[/\\]index-[\w-]+\.js$/.test(f.path)).bytes
relative('initial renderer JS bytes',initial(before),initial(after),1.01)
relative('total JS bytes',before.bundle.jsBytes,after.bundle.jsBytes,1.01)
for(const count of [10,100,250]) {
  const a=scenario(before,`restore-${count}-cold`),b=scenario(after,`restore-${count}-cold`)
  relative(`restore ${count} working set bytes`,a.memory.workingSetBytes,b.memory.workingSetBytes,1.1,50*1048576)
  check(`restore ${count} process budget`,b.memory.processCount<=10,a.memory.processCount,b.memory.processCount,10)
}
for(const name of ['restore-100-cold','loaded-10']) {
  const a=scenario(before,name),b=scenario(after,name)
  for(const tab of Object.keys(b.tabSwitchMs)) relative(`${name} switch ${tab} ms`,a.tabSwitchMs[tab],b.tabSwitchMs[tab],1.25,100)
}
const idleBefore = read(beforeName+'-idle'), idleAfter = read(afterName+'-idle')
for (const count of [1,50]) {
  const a = idleBefore.scenarios.filter(s=>s.name.startsWith(`idle-confirmed-${count}-`))
  const b = idleAfter.scenarios.filter(s=>s.name.startsWith(`idle-confirmed-${count}-`))
  if (a.length !== 3 || b.length !== 3) throw new Error('Three fully loaded idle samples are required')
  for (const state of Object.keys(b[0].idleCpu)) relative(`loaded ${count} idle median ${state}`, median(a.map(s=>s.idleCpu[state])), median(b.map(s=>s.idleCpu[state])), 1.25, 3)
  relative(`loaded ${count} idle renderer task seconds`, median(a.map(s=>s.idleRenderer.taskDurationSeconds)), median(b.map(s=>s.idleRenderer.taskDurationSeconds)), 1.25, .05)
  const long = sample => sample.idleRenderer.longTaskDurations.reduce((sum,n)=>sum+n,0)
  relative(`loaded ${count} idle renderer long tasks ms`, median(a.map(long)), median(b.map(long)), 1.25, 100)
}
const closed=scenario(after,'loaded-25')
check('closing tabs reclaims processes',closed.memoryAfterClose.processCount<closed.memory.processCount,closed.memory.processCount,closed.memoryAfterClose.processCount)
check('closing tabs reclaims memory',closed.memoryAfterClose.workingSetBytes<closed.memory.workingSetBytes,closed.memory.workingSetBytes,closed.memoryAfterClose.workingSetBytes)
check('every scenario closes gracefully', after.scenarios.every(s => s.close?.graceful), undefined, after.scenarios.filter(s => !s.close?.graceful).map(s => s.name))
relative('median close duration ms', median(before.scenarios.map(s => s.close.durationMs)), median(after.scenarios.map(s => s.close.durationMs)), 1.25, 500)
const cycles=scenario(after,'lifecycle-cycles').lifecycleCycles
check('15 create/close cycles do not leak processes',cycles.after.processCount<=cycles.before.processCount,cycles.before.processCount,cycles.after.processCount)
const downloadBefore = idleBefore.scenarios.filter(s=>s.name.startsWith('download-confirmed-')).map(s=>s.operationCounters.delta)
const downloadAfter = idleAfter.scenarios.filter(s=>s.name.startsWith('download-confirmed-')).map(s=>s.operationCounters.delta)
if (downloadBefore.length !== 3 || downloadAfter.length !== 3) throw new Error('Three download stress samples are required')
check('download stress emits live progress in every run', downloadAfter.every(s=>s.downloadProgressEvents>0), undefined, downloadAfter.map(s=>s.downloadProgressEvents))
check('download stress bounded durable writes (start, completion, scan)', downloadAfter.every(s=>s.downloadDurableWrites<=3), downloadBefore.map(s=>s.downloadDurableWrites), downloadAfter.map(s=>s.downloadDurableWrites), 3)
// The click may also checkpoint page navigation. Compare that work separately
// from the intentional additional start and scan writes owned by main.
const nonDownload = s=>Math.max(0,s.storageWrites-s.downloadDurableWrites)
const baselineOtherWrites = Math.max(...downloadBefore.map(nonDownload))
check('download stress does not add general renderer saves', Math.max(...downloadAfter.map(nonDownload))<=baselineOtherWrites, downloadBefore.map(nonDownload), downloadAfter.map(nonDownload), baselineOtherWrites)
check('download stress rolling backup limit', downloadAfter.every(s=>s.rollingBackups<=1), downloadBefore.map(s=>s.rollingBackups), downloadAfter.map(s=>s.rollingBackups), 1)
check('all confirmed idle/download scenarios close gracefully', idleAfter.scenarios.every(s=>s.close?.graceful), undefined, idleAfter.scenarios.filter(s=>!s.close?.graceful).map(s=>s.name))
const navigation=scenario(after,'ordinary-navigation').operationCounters.delta.storageWrites
check('navigation stays consolidated',navigation<=1,undefined,navigation,1)
const scrollBefore=read(beforeName+'-scroll'),scrollAfter=read(afterName+'-scroll')
relative('250-tab scroll p95 frame ms',scrollBefore.scrolling.p95FrameMs,scrollAfter.scrolling.p95FrameMs,1.25,8)
const unload=read(afterName+'-unload').smartUnload
check('Smart Unload preserves active/pinned guests',unload.remainingGuests<=2,10,unload.remainingGuests,2)
check('Smart Unload reclaims processes',unload.after.processCount<unload.before.processCount,unload.before.processCount,unload.after.processCount)
const result={before:beforeName,after:afterName,checks,passed:checks.every(c=>c.passed)}
fs.writeFileSync(path.join(root,'production-regressions.json'),JSON.stringify(result,null,2))
for(const c of checks)console.log(`${c.passed?'PASS':'FAIL'} ${c.name}: ${c.before??''} -> ${c.after}${c.limit!==undefined?' (limit '+c.limit+')':''}`)
if(!result.passed)process.exitCode=1
