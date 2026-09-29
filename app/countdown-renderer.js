const countdown = document.querySelector('.countdown')

window.countdown.onUpdate((seconds) => {
  countdown.textContent = seconds
})
