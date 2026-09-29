import { vi } from 'vitest'
import 'chai/register-should'
import { join } from 'path'
import { homedir } from 'node:os'
import DndManager from '../app/utils/dndManager'
import Store from 'electron-store'
import defaultSettings from '../app/utils/defaultSettings'
import { rm } from 'node:fs/promises'

const timeout = process.env.CI ? 30000 : 10000

describe('dndManager', function () {
  vi.setConfig({ testTimeout: timeout })
  let settings = null
  let dndManager = null

  beforeEach(() => {
    settings = new Store({
      cwd: join(__dirname),
      name: 'test-settings-dndManager',
      defaults: defaultSettings
    })
    dndManager = new DndManager(settings)
  })

  it('should be running with default settings', () => new Promise((resolve) => {
    dndManager.isOnDnd.should.be.equal(false)
    dndManager.timer.should.not.be.equal(null)
    resolve()
  }))

  it('should not be running when every detection is disabled', () => new Promise((resolve) => {
    settings.set('monitorDnd', false)
    settings.set('monitorFullscreen', false)
    settings.set('monitorDndApps', false)
    dndManager.stop()
    dndManager = null
    dndManager = new DndManager(settings)
    dndManager.isOnDnd.should.be.equal(false)
    ;(dndManager.timer === null).should.be.equal(true)
    resolve()
  }))

  it('should be running with only monitorDnd: true', () => new Promise((resolve) => {
    settings.set('monitorDnd', true)
    settings.set('monitorFullscreen', false)
    settings.set('monitorDndApps', false)
    dndManager.stop()
    dndManager = null
    dndManager = new DndManager(settings)
    dndManager.isOnDnd.should.be.equal(false)
    dndManager.timer.should.not.be.equal(null)
    resolve()
  }))

  it('should start when start()', () => new Promise((resolve) => {
    dndManager.stop()
    dndManager.start()
    dndManager.isOnDnd.should.be.equal(false)
    dndManager.timer.should.not.be.equal(null)
    resolve()
  }))

  it('should stop when stop()', () => new Promise((resolve) => {
    dndManager.stop()
    ;(dndManager.timer === null).should.be.equal(true)
    dndManager.isOnDnd.should.be.equal(false)
    resolve()
  }))

  it('matches DND apps by process name, ignoring case and .exe', async () => {
    settings.set('doNotDisturbApps', [{ name: 'Node', process: 'NODE.exe' }, { name: 'Missing', process: 'stretchly-missing-app' }])
    dndManager.stop()
    dndManager.start()
    ;(await dndManager._runningDndApp()).should.be.equal('node')
    settings.set('doNotDisturbApps', [{ name: 'Missing', process: 'stretchly-missing-app' }])
    dndManager.stop()
    dndManager.start()
    ;((await dndManager._runningDndApp()) === undefined).should.be.equal(true)
  })

  it('does not create a second timer when start() is called twice', () => new Promise((resolve) => {
    dndManager.stop()
    dndManager.start()
    const timer = dndManager.timer
    dndManager.start()
    dndManager.timer.should.be.equal(timer)
    resolve()
  }))

  it('should find correct value of LXQt config file', async () => {
    const value = await dndManager._getConfigValue(join(__dirname, '/test-lxqt.conf'), 'doNotDisturb')
    value.should.be.equal(true)
  })

  it('resolves the LXQt config path', async () => {
    dndManager.stop()
    const originalDesktop = process.env.XDG_CURRENT_DESKTOP
    const originalConfigHome = process.env.XDG_CONFIG_HOME
    let configPath

    process.env.XDG_CURRENT_DESKTOP = 'LXQt'
    dndManager._getOrCreateSessionBus = () => ({})
    dndManager._getConfigValue = async (filePath) => {
      configPath = filePath
      return true
    }

    try {
      process.env.XDG_CONFIG_HOME = join(__dirname, 'xdg-config')
      await dndManager._isDndEnabledLinux()
      configPath.should.equal(join(process.env.XDG_CONFIG_HOME, 'lxqt', 'notifications.conf'))

      delete process.env.XDG_CONFIG_HOME
      await dndManager._isDndEnabledLinux()
      configPath.should.equal(join(homedir(), '.config', 'lxqt', 'notifications.conf'))

      process.env.XDG_CONFIG_HOME = 'relative-config'
      await dndManager._isDndEnabledLinux()
      configPath.should.equal(join(homedir(), '.config', 'lxqt', 'notifications.conf'))
    } finally {
      if (typeof originalDesktop === 'undefined') {
        delete process.env.XDG_CURRENT_DESKTOP
      } else {
        process.env.XDG_CURRENT_DESKTOP = originalDesktop
      }
      if (typeof originalConfigHome === 'undefined') {
        delete process.env.XDG_CONFIG_HOME
      } else {
        process.env.XDG_CONFIG_HOME = originalConfigHome
      }
    }
  })

  it('should return something for _desktopEnvironment', () => new Promise((resolve) => {
    dndManager._desktopEnvironment.should.not.be.equal(null)
    resolve()
  }))

  afterEach(async () => {
    dndManager.stop()
    dndManager = null

    if (settings) {
      await rm(join(__dirname, '/test-settings-dndManager.json'), { force: true })
      settings = null
    }
  })
})
