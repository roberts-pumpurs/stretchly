import EventEmitter from 'events'
import log from 'electron-log/main.js'
import { desktopIdle } from 'node-desktop-idle-v2'
import { powerMonitor } from 'electron'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const idleThreshold = 20000
const typingPauseTime = 3000
const macOSSecondsSinceKeyDownScript = `
ObjC.import('CoreGraphics')
$.CGEventSourceSecondsSinceLastEventType($.kCGEventSourceStateCombinedSessionState, $.kCGEventKeyDown)
`

class NaturalBreaksManager extends EventEmitter {
  constructor (settings) {
    super()
    this.settings = settings
    this.usingNaturalBreaks = settings.get('naturalBreaks')
    this.naturalBreaksCheckInterval = settings.get('naturalBreaksCheckInterval')
    this.timer = null
    this.isOnNaturalBreak = false
    this.isSchedulerCleared = false
    if (this.usingNaturalBreaks) {
      this.start()
    }
  }

  start () {
    if (this.timer) return
    this.usingNaturalBreaks = true
    desktopIdle.startMonitoring()
    this._checkIdleTime()
    log.info('Stretchly: starting Idle time monitoring')
  }

  stop () {
    if (!this.timer) return
    this.usingNaturalBreaks = false
    this.isOnNaturalBreak = false
    this.isSchedulerCleared = false
    clearInterval(this.timer)
    this.timer = null
    desktopIdle.stopMonitoring()
    log.info('Stretchly: stopping Idle time monitoring')
  }

  get idleTime () {
    if (this.usingNaturalBreaks) {
      return (powerMonitor.getSystemIdleTime() || desktopIdle.getIdleTime()) * 1000
    } else {
      return 0
    }
  }

  async isTyping () {
    if (process.platform !== 'darwin') return false
    try {
      const { stdout } = await execFileAsync('osascript', ['-l', 'JavaScript', '-e', macOSSecondsSinceKeyDownScript])
      return parseFloat(stdout) * 1000 < typingPauseTime
    } catch (e) {
      if (!this._typingErrorLogged) {
        log.error('Stretchly: typing detection error:', e)
        this._typingErrorLogged = true
      }
      return false
    }
  }

  _checkIdleTime () {
    let lastIdleTime = 0
    this.timer = setInterval(() => {
      const idleTime = this.idleTime
      if (!this.isOnNaturalBreak && idleTime > idleThreshold) {
        this.isOnNaturalBreak = true
        this.emit('idleStarted')
      }
      if (this.isOnNaturalBreak && idleTime < idleThreshold) {
        this.isOnNaturalBreak = false
        if (lastIdleTime > this.settings.get('naturalBreaksInactivityResetTime')) {
          this.isSchedulerCleared = false
          this.emit('naturalBreakFinished')
        } else {
          this.emit('idleFinished', lastIdleTime)
        }
      }
      if (this.isOnNaturalBreak && idleTime > this.settings.get('naturalBreaksInactivityResetTime')) {
        this.isSchedulerCleared = true
        this.emit('clearBreakScheduler')
      }
      lastIdleTime = idleTime
    }, this.naturalBreaksCheckInterval)
  }
}

export default NaturalBreaksManager
