import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { basename, join } from 'node:path'

const execFileAsync = promisify(execFile)

async function readMacApp (appPath) {
  const { stdout } = await execFileAsync('plutil', ['-extract', 'CFBundleExecutable', 'raw', '-o', '-', join(appPath, 'Contents', 'Info.plist')])
  return { name: basename(appPath, '.app'), process: stdout.trim(), path: appPath }
}

export { readMacApp }
