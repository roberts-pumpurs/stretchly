import EventEmitter from 'events'
import log from 'electron-log/main.js'
import { getFocusAssist } from 'windows-focus-assist'
import dbus from '@particle/dbus-next'
import psList from 'ps-list'
import { exec, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

const execFileAsync = promisify(execFile)
const normalizeProcessName = (name) => name.toLowerCase().replace(/\.exe$/, '')

const macOSFullscreenScript = `
ObjC.import('AppKit')
ObjC.import('CoreGraphics')
ObjC.bindFunction('CGSMainConnectionID', ['int', []])
ObjC.bindFunction('CGSCopyManagedDisplaySpaces', ['id', ['int']])
function run (argv) {
  const ownPid = Number(argv[0])
  const displays = ObjC.deepUnwrap($.CGSCopyManagedDisplaySpaces($.CGSMainConnectionID())) || []
  const inFullscreenSpace = displays.some(display => {
    const space = display['Current Space'] || {}
    const tiles = (space.TileLayoutManager && space.TileLayoutManager.TileSpaces) || []
    return space.type === 4 && tiles.some(tile => typeof tile.pid === 'number' && tile.pid !== ownPid)
  })
  if (inFullscreenSpace) return true
  const screens = $.NSScreen.screens.js
  const mainHeight = screens[0].frame.size.height
  const screenBounds = screens.map(screen => {
    const { origin, size } = screen.frame
    return { X: origin.x, Y: mainHeight - origin.y - size.height, Width: size.width, Height: size.height }
  })
  const windows = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(
    $.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, $.kCGNullWindowID))) || []
  return windows.some(window => window.kCGWindowLayer === 0 && window.kCGWindowOwnerPID !== ownPid &&
    screenBounds.some(bounds => ['X', 'Y', 'Width', 'Height'].every(key => window.kCGWindowBounds[key] === bounds[key])))
}
`

class DndManager extends EventEmitter {
  constructor (settings) {
    super()
    this.settings = settings
    this.monitorDndCheckInterval = settings.get('monitorDndCheckInterval')
    this.timer = null
    this.isOnDnd = false

    this._unsupDEErrorShown = false
    this._errorLogged = {}

    this.start()
  }

  start () {
    if (this.timer) return
    this.monitorDnd = this.settings.get('monitorDnd')
    this.monitorFullscreen = this.settings.get('monitorFullscreen') && process.platform === 'darwin'
    this.dndApps = this.settings.get('monitorDndApps') ? this.settings.get('dndApps').map(normalizeProcessName) : []
    if (!this.monitorDnd && !this.monitorFullscreen && this.dndApps.length === 0) return
    this._checkDnd()
    log.info(`Stretchly: starting Do Not Disturb monitoring (DND: ${this.monitorDnd}, full screen apps: ${this.monitorFullscreen}, apps: ${JSON.stringify(this.dndApps)})`)
    if (process.platform === 'linux') {
      log.info(`System: Your Desktop seems to be ${this._desktopEnvironment}.`)
    }
  }

  stop () {
    if (!this.timer) return
    this.isOnDnd = false
    clearInterval(this.timer)
    this.timer = null
    if (this.__sessionBus) {
      this.__sessionBus.disconnect()
      this.__sessionBus = null
    }
    log.info('Stretchly: stopping Do Not Disturb monitoring')
  }

  get _desktopEnvironment () {
    // https://specifications.freedesktop.org/mime-apps-spec/latest/file.html
    // https://specifications.freedesktop.org/menu-spec/latest/onlyshowin-registry.html
    return process.env.XDG_CURRENT_DESKTOP || 'unknown'
  }

  async _isDndEnabledLinux () {
    const de = this._desktopEnvironment.toLowerCase()
    const sessionBus = this._getOrCreateSessionBus()
    switch (true) {
      case de.includes('kde'):
        try {
          const obj = await sessionBus.getProxyObject('org.freedesktop.Notifications', '/org/freedesktop/Notifications')
          const properties = obj.getInterface('org.freedesktop.DBus.Properties')
          const dndEnabled = await properties.Get('org.freedesktop.Notifications', 'Inhibited')
          if (await dndEnabled.value) {
            return true
          }
        } catch (e) {
          this._logErrorOnce('kde', e)
        }
        break
      case de.includes('xfce'):
        try {
          const obj = await sessionBus.getProxyObject('org.xfce.Xfconf', '/org/xfce/Xfconf')
          const properties = obj.getInterface('org.xfce.Xfconf')
          const dndEnabled = await properties.GetProperty('xfce4-notifyd', '/do-not-disturb')
          if (await dndEnabled.value) {
            return true
          }
        } catch (e) {
          this._logErrorOnce('xfce', e)
        }
        break
      case de.includes('gnome') || de.includes('unity'):
        try {
          const asyncExec = this._getOrCreateAsyncExec()
          const { stdout } = await asyncExec('gsettings get org.gnome.desktop.notifications show-banners')
          if (stdout.replace(/[^0-9a-zA-Z]/g, '') === 'false') {
            return true
          }
        } catch (e) {
          this._logErrorOnce('gnome/unity', e)
        }
        break
      case de.includes('cinnamon'):
        try {
          const asyncExec = this._getOrCreateAsyncExec()
          const { stdout } = await asyncExec('gsettings get org.cinnamon.desktop.notifications display-notifications')
          if (stdout.replace(/[^0-9a-zA-Z]/g, '') === 'false') {
            return true
          }
        } catch (e) {
          this._logErrorOnce('cinnamon', e)
        }
        break
      case de.includes('mate'):
        try {
          const asyncExec = this._getOrCreateAsyncExec()
          const { stdout } = await asyncExec('gsettings get org.mate.NotificationDaemon do-not-disturb')
          if (stdout.replace(/[^0-9a-zA-Z]/g, '') === 'true') {
            return true
          }
        } catch (e) {
          this._logErrorOnce('mate', e)
        }
        break
      case de.includes('lxqt'): {
        const configHome = process.env.XDG_CONFIG_HOME
        return await this._getConfigValue(
          join(configHome && isAbsolute(configHome) ? configHome : join(homedir(), '.config'), 'lxqt', 'notifications.conf'),
          'doNotDisturb'
        )
      }
      default:
        if (!this._unsupDEErrorShown) {
          log.info(`Stretchly: ${this._desktopEnvironment} not supported for DND detection, yet.`)
          this._unsupDEErrorShown = true
        }
        return false
    }
  }

  _getOrCreateSessionBus () {
    if (!this.__sessionBus) {
      const bus = dbus.sessionBus()
      this.__sessionBus = bus
      bus.on('error', () => { this.__sessionBus = null })
      bus.on('close', () => { this.__sessionBus = null })
    }
    return this.__sessionBus
  }

  async _isDndEnabled () {
    // TODO also check for session state? https://github.com/felixrieseberg/electron-notification-state/tree/master#session-state
    if (process.platform === 'win32') {
      let wfa = 0
      try {
        wfa = getFocusAssist().value
      } catch (e) { wfa = -1 } // getFocusAssist() throw an error if OS isn't windows
      return wfa === 1 || wfa === 2
    } else if (process.platform === 'darwin') {
      const macOSMajorVersion = parseInt(process.getSystemVersion().split('.')[0])
      let cmd = ''
      if (macOSMajorVersion >= 26) {
        cmd = 'defaults read com.apple.controlcenter "NSStatusItem VisibleCC FocusModes"'
      } else {
        cmd = 'defaults read com.apple.controlcenter "NSStatusItem Visible FocusModes"'
      }
      try {
        const asyncExec = this._getOrCreateAsyncExec()
        const { stdout } = await asyncExec(cmd)
        if (stdout.replace(/[^0-9a-zA-Z]/g, '') === '1') {
          return true
        }
      } catch (e) {
        if (!e.message.includes('The domain/default pair of (com.apple.controlcenter, NSStatusItem VisibleCC FocusModes) does not exist')) {
          // On macOS Tahoe 26.0, this entry would not exist if no focus mode is enabled
          this._logErrorOnce('macos', e)
        }
      }
    } else if (process.platform === 'linux') {
      return await this._isDndEnabledLinux()
    }
    return false
  }

  async _runningDndApp () {
    try {
      const processes = await psList()
      return this.dndApps.find(app => processes.some(({ name }) => name && normalizeProcessName(name) === app))
    } catch (e) {
      this._logErrorOnce('apps', e)
      return undefined
    }
  }

  async _isFullscreenAppActive () {
    try {
      const { stdout } = await execFileAsync('osascript', ['-l', 'JavaScript', '-e', macOSFullscreenScript, String(process.pid)])
      return stdout.trim() === 'true'
    } catch (e) {
      this._logErrorOnce('fullscreen', e)
      return false
    }
  }

  async _dndReason () {
    if (this.monitorDnd && await this._isDndEnabled()) return 'Do Not Disturb'
    if (this.dndApps.length > 0) {
      const app = await this._runningDndApp()
      if (app) return `running app '${app}'`
    }
    if (this.monitorFullscreen && await this._isFullscreenAppActive()) return 'full screen app'
    return null
  }

  _getOrCreateAsyncExec () {
    if (!this.__asyncExec) {
      this.__asyncExec = promisify(exec)
    }
    return this.__asyncExec
  }

  async _getConfigValue (filePath, key) {
    try {
      const data = await readFile(filePath, 'utf8')
      const lines = data.split('\n')
      for (const line of lines) {
        const [configKey, value] = line.split('=')
        if (configKey.trim() === key) {
          return value.trim().toLowerCase() === 'true'
        }
      }
      return false
    } catch (e) {
      this._logErrorOnce(`config-read-${filePath}`, e)
      return false
    }
  }

  _logErrorOnce (environment, error) {
    const errorKey = `${environment}-${error.code || error.message.substring(0, 20)}`
    if (!this._errorLogged[errorKey]) {
      log.error(`Stretchly: DND detection error in ${environment}:`, error)
      this._errorLogged[errorKey] = true
    }
  }

  _checkDnd () {
    this.timer = setInterval(async () => {
      const reason = await this._dndReason()
      if (!this.isOnDnd && reason) {
        this.isOnDnd = true
        this.emit('dndStarted', reason)
      }
      if (this.isOnDnd && !reason) {
        this.isOnDnd = false
        this.emit('dndFinished')
      }
    }, this.monitorDndCheckInterval)
  }
}

export default DndManager
