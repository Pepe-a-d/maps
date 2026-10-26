// Start screen: a single power button. Pressing it fires up a round
// speedometer that sweeps to the top and back, then bands of colour wipe across
// the screen, racing-game style, and uncover the map.

const SWEEP_MS = 1100;
const SWEEP_TOP_KMH = 300;

const POWER_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v8" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/><path d="M7.1 6.3a7.5 7.5 0 1 0 9.8 0" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>';

// Same 270° arc as the driving speedometer, with its ring of ticks.
const ARC = 'M26.1 93.9A48 48 0 1 1 93.9 93.9';
const TICKS = 'M21.1 98.9A55 55 0 1 1 98.9 98.9';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const easeOut = (t) => 1 - (1 - t) ** 3;

export function showSplash() {
  const root = document.createElement('div');
  root.className = 'splash';
  root.innerHTML = `
    <div class="splash__gauge">
      <svg viewBox="0 0 120 120" aria-hidden="true">
        <path class="splash__track" d="${ARC}" pathLength="100"/>
        <path class="splash__arc" d="${ARC}" pathLength="100"/>
        <path class="splash__ticks" d="${TICKS}" pathLength="100"/>
      </svg>
      <button class="splash__start" type="button" aria-label="Arrancar">${POWER_ICON}</button>
      <b class="splash__speed" aria-hidden="true">0</b>
    </div>
    <div class="splash__wipe" aria-hidden="true"><i></i><i></i><i></i></div>`;
  document.body.append(root);

  const button = root.querySelector('.splash__start');
  const arc = root.querySelector('.splash__arc');
  const speed = root.querySelector('.splash__speed');

  // Needle sweep: up to the top and back down, like a dash coming to life.
  function sweep() {
    return new Promise((resolve) => {
      const start = performance.now();
      function frame(now) {
        const t = Math.min(1, (now - start) / SWEEP_MS);
        const level = t < 0.5 ? easeOut(t * 2) : 1 - easeOut((t - 0.5) * 2);
        arc.style.strokeDasharray = `${level * 100} 100`;
        speed.textContent = Math.round(level * SWEEP_TOP_KMH);
        if (t < 1) requestAnimationFrame(frame);
        else resolve();
      }
      requestAnimationFrame(frame);
    });
  }

  return new Promise((resolve) => {
    button.addEventListener(
      'click',
      async () => {
        navigator.vibrate?.([40, 70, 140]);
        const quick = matchMedia('(prefers-reduced-motion: reduce)').matches;
        root.classList.add('is-starting');
        if (!quick) {
          await wait(300);
          root.classList.add('is-sweeping'); // the button gives way to the numbers
          await sweep();
          root.classList.add('is-wiping'); // colour bands cross the screen and uncover the map
          await wait(1050);
        } else {
          root.classList.add('is-done');
          await wait(150);
        }
        root.remove();
        resolve();
      },
      { once: true },
    );
  });
}
