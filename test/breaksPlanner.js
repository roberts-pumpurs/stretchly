import { vi } from 'vitest'
import 'chai/register-should'
import { join } from 'path'
import EventEmitter from 'events'
import Store from 'electron-store'
import { rm } from 'node:fs/promises'
import defaultSettings from '../app/utils/defaultSettings'
import BreaksPlanner from '../app/breaksPlanner'

vi.mock('../app/utils/naturalBreaksManager.js', () => ({
  default: class extends EventEmitter {
    constructor () {
      super()
      this.isOnNaturalBreak = false
      this.isSchedulerCleared = false
      this.isTyping = async () => false
    }

    start () {}
    stop () {}
  }
}))

describe('breaksPlanner', () => {
  let settings = null
  let breaksPlanner = null

  beforeEach(() => {
    settings = new Store({
      cwd: join(__dirname),
      name: 'test-settings-breaksPlanner',
      defaults: defaultSettings
    })
    settings.set('monitorDnd', false)
    settings.set('monitorFullscreen', false)
    settings.set('monitorDndApps', false)
    settings.set('microbreakInterval', 600000)
    settings.set('breakInterval', 2)
    settings.set('microbreakNotificationInterval', 30000)
    settings.set('breakNotificationInterval', 30000)
    settings.set('cursorCountdown', false)
    breaksPlanner = new BreaksPlanner(settings)
  })

  describe('postponeCurrentBreak', () => {
    it('brings a Mini break back after a full interval, minus its notification', () => {
      settings.set('microbreakNotification', true)
      breaksPlanner.nextBreak()
      breaksPlanner.postponeCurrentBreak()
      breaksPlanner.scheduler.reference.should.equal('startMicrobreakNotification')
      breaksPlanner.scheduler.delay.should.equal(600000 - 30000)
      breaksPlanner.postponesNumber.should.equal(1)
    })

    it('keeps a Long break owed and brings it back after a full Mini break interval', () => {
      settings.set('breakNotification', false)
      breaksPlanner.nextBreak()
      breaksPlanner.skipToBreak()
      breaksPlanner.postponeCurrentBreak()
      breaksPlanner.scheduler.reference.should.equal('startBreak')
      breaksPlanner.scheduler.delay.should.equal(600000)
    })

    it('brings a Long break back after a full Long break interval when Mini breaks are off', () => {
      settings.set('microbreak', false)
      settings.set('breakNotification', false)
      breaksPlanner.nextBreak()
      breaksPlanner.postponeCurrentBreak()
      breaksPlanner.scheduler.reference.should.equal('startBreak')
      breaksPlanner.scheduler.delay.should.equal(600000 * 3)
    })
  })

  describe('activity', () => {
    beforeEach(() => {
      vi.useFakeTimers()
      settings.set('microbreakNotification', false)
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('holds the next break while idle and continues with the time that was left', async () => {
      const started = vi.fn()
      breaksPlanner.on('startMicrobreak', started)
      breaksPlanner.nextBreak()
      await vi.advanceTimersByTimeAsync(100000)
      breaksPlanner.naturalBreaksManager.isOnNaturalBreak = true
      breaksPlanner.naturalBreaksManager.emit('idleStarted')
      breaksPlanner.isIdle.should.equal(true)
      await vi.advanceTimersByTimeAsync(1000000)
      started.mock.calls.length.should.equal(0)
      breaksPlanner.naturalBreaksManager.isOnNaturalBreak = false
      breaksPlanner.naturalBreaksManager.emit('idleFinished')
      breaksPlanner.isIdle.should.equal(false)
      await vi.advanceTimersByTimeAsync(499999)
      started.mock.calls.length.should.equal(0)
      await vi.advanceTimersByTimeAsync(1)
      started.mock.calls.length.should.equal(1)
    })

    it('delays a due break until typing stops', async () => {
      const started = vi.fn()
      const typing = [true, true, false]
      breaksPlanner.naturalBreaksManager.isTyping = async () => typing.shift()
      breaksPlanner.on('startMicrobreak', started)
      breaksPlanner.nextBreak()
      await vi.advanceTimersByTimeAsync(600000)
      started.mock.calls.length.should.equal(0)
      breaksPlanner.isDelayedForTyping.should.equal(true)
      await vi.advanceTimersByTimeAsync(1000)
      started.mock.calls.length.should.equal(0)
      await vi.advanceTimersByTimeAsync(1000)
      started.mock.calls.length.should.equal(1)
      breaksPlanner.isDelayedForTyping.should.equal(false)
    })

    it('starts a due break at once when typing delay is off', async () => {
      const started = vi.fn()
      settings.set('delayBreaksWhileTyping', false)
      breaksPlanner.naturalBreaksManager.isTyping = async () => true
      breaksPlanner.on('startMicrobreak', started)
      breaksPlanner.nextBreak()
      await vi.advanceTimersByTimeAsync(600000)
      started.mock.calls.length.should.equal(1)
    })
  })

  describe('cursor countdown', () => {
    beforeEach(() => {
      vi.useFakeTimers()
      settings.set('cursorCountdown', true)
      settings.set('delayBreaksWhileTyping', false)
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('counts down the last 5 seconds before a break without moving the break', async () => {
      settings.set('microbreakNotification', false)
      const countdown = vi.fn()
      const started = vi.fn()
      breaksPlanner.on('startMicrobreakCountdown', countdown)
      breaksPlanner.on('startMicrobreak', started)
      breaksPlanner.nextBreak()
      breaksPlanner.timeToNextBreak.should.equal(600000)
      await vi.advanceTimersByTimeAsync(594999)
      countdown.mock.calls.length.should.equal(0)
      await vi.advanceTimersByTimeAsync(1)
      countdown.mock.calls.length.should.equal(1)
      breaksPlanner.scheduler.reference.should.equal('startMicrobreak')
      breaksPlanner.timeToNextBreak.should.equal(5000)
      await vi.advanceTimersByTimeAsync(4999)
      started.mock.calls.length.should.equal(0)
      await vi.advanceTimersByTimeAsync(1)
      started.mock.calls.length.should.equal(1)
    })

    it('counts down after the notification, inside the notification time', async () => {
      settings.set('microbreak', false)
      const countdown = vi.fn()
      const started = vi.fn()
      breaksPlanner.on('startBreakNotification', () => breaksPlanner.nextBreakAfterNotification())
      breaksPlanner.on('startBreakCountdown', countdown)
      breaksPlanner.on('startBreak', started)
      breaksPlanner.nextBreak()
      await vi.advanceTimersByTimeAsync(600000 * 3 - 30000)
      breaksPlanner.scheduler.reference.should.equal('startBreakCountdown')
      breaksPlanner.timeToNextBreak.should.equal(30000)
      await vi.advanceTimersByTimeAsync(25000)
      countdown.mock.calls.length.should.equal(1)
      await vi.advanceTimersByTimeAsync(5000)
      started.mock.calls.length.should.equal(1)
    })

    it('drops the break when it is postponed during the countdown', async () => {
      settings.set('microbreakNotification', false)
      const started = vi.fn()
      breaksPlanner.on('startMicrobreak', started)
      breaksPlanner.nextBreak()
      await vi.advanceTimersByTimeAsync(596000)
      breaksPlanner.postponeCurrentBreak()
      breaksPlanner.scheduler.reference.should.equal('startMicrobreakCountdown')
      breaksPlanner.timeToNextBreak.should.equal(600000)
      await vi.advanceTimersByTimeAsync(10000)
      started.mock.calls.length.should.equal(0)
    })
  })

  afterEach(async () => {
    breaksPlanner.clear()
    breaksPlanner.dndManager.stop()
    breaksPlanner.appExclusionsManager.stop()
    breaksPlanner = null
    await rm(join(__dirname, '/test-settings-breaksPlanner.json'), { force: true })
    settings = null
  })
})
