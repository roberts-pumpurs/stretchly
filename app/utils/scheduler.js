class Scheduler {
  constructor (func, delay, reference = null) {
    this.timer = null
    this.delay = delay
    this.func = func
    this.reference = reference
    this.remaining = null
  }

  get timeLeft () {
    if (this.remaining !== null) return this.remaining
    if (this.timer === null) return false
    return this.now + this.delay - Date.now()
  }

  get isPaused () {
    return this.remaining !== null
  }

  plan () {
    this.now = Date.now()
    this.timer = setTimeout(this.func, this.delay)
  }

  correct () {
    if (this.timer === null) return
    clearTimeout(this.timer)
    this.timer = setTimeout(this.func, this.timeLeft)
  }

  pause () {
    if (this.timer === null) return
    this.remaining = Math.max(0, this.timeLeft)
    clearTimeout(this.timer)
    this.timer = null
  }

  resume () {
    if (this.remaining === null) return
    this.now = Date.now() - (this.delay - this.remaining)
    this.timer = setTimeout(this.func, this.remaining)
    this.remaining = null
  }

  cancel () {
    clearTimeout(this.timer)
    this.timer = null
    this.remaining = null
    this.reference = null
    this.func = null
  }
}

export default Scheduler
