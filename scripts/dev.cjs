const { spawn } = require('node:child_process')

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

function quoteWindowsArg(value) {
  return `"${String(value).replaceAll('"', '""')}"`
}

const child = process.platform === 'win32'
  ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/c', ['npx electron-vite dev', ...process.argv.slice(2).map(quoteWindowsArg)].join(' ')], {
      env,
      stdio: 'inherit',
      windowsHide: false
    })
  : spawn('npx', ['electron-vite', 'dev', ...process.argv.slice(2)], {
  env,
  stdio: 'inherit',
  windowsHide: false
    })

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 0)
})
