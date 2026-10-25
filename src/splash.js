// Start screen: a single power button. Pressing it plays the power-on check of
// a bike dashboard (every warning lamp lights up, the bar and the speedometer
// sweep to the top and back) and then hands over to the map.

const SEGMENTS = 30;
const SWEEP_MS = 1100;
const SWEEP_TOP_KMH = 240;

const LAMPS = [
  { color: '#3ccf6e', svg: '<path d="M10 5 3 12l7 7v-4.5h7v-5h-7z"/>' }, // left indicator
  { color: '#4c8dff', svg: '<path d="M12 5a7 7 0 0 0 0 14zM14 7h7M14 10.3h7M14 13.7h7M14 17h7" stroke="currentColor" stroke-width="2"/>' }, // high beam
  { color: '#3ccf6e', text: 'N' }, // neutral
  { color: '#ffc93c', text: 'ABS' },
  { color: '#ff4d4d', svg: '<path d="M3 13c3-4 5-5 8-4l2 2h5l3-2v3l-3 2H8z"/><circle cx="19.5" cy="17" r="1.6"/>' }, // oil
  { color: '#ffc93c', svg: '<path d="M7 7h6v2h3l2 2h2v6h-2l-2 2H8l-2-2H4v-3H2v-3h2v-2h3z"/>' }, // engine
  { color: '#3ccf6e', svg: '<path d="m14 5 7 7-7 7v-4.5H7v-5h7z"/>' }, // right indicator
];

const POWER_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v8" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/><path d="M7.1 6.3a7.5 7.5 0 1 0 9.8 0" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const easeOut = (t) => 1 - (1 - t) ** 3;

export function showSplash() {
  const root = document.createElement('div');
  root.className = 'splash';
  root.innerHTML = `
    <button class="splash__start" type="button" aria-label="Arrancar">${POWER_ICON}</button>
    <div class="splash__dash" aria-hidden="true">
      <div class="splash__lamps">
        ${LAMPS.map(
          (lamp) =>
            `<i style="--c: ${lamp.color}">${lamp.text ?? `<svg viewBox="0 0 24 24" fill="currentColor">${lamp.svg}</svg>`}</i>`,
        ).join('')}
      </div>
      <div class="splash__speed"><b>0</b><small>km/h</small></div>
      <div class="splash__rev">${Array.from({ length: SEGMENTS }, (_, i) => `<i style="--t: ${i / (SEGMENTS - 1)}"></i>`).join('')}</div>
    </div>`;
  document.body.append(root);

  const button = root.querySelector('.splash__start');
  const speed = root.querySelector('.splash__speed b');
  const segments = [...root.querySelectorAll('.splash__rev i')];

  // Needle sweep: up to the top and back down, like a dash self-test.
  function sweep() {
    return new Promise((resolve) => {
      const start = performance.now();
      function frame(now) {
        const t = Math.min(1, (now - start) / SWEEP_MS);
        const level = t < 0.5 ? easeOut(t * 2) : 1 - easeOut((t - 0.5) * 2);
        const lit = Math.round(level * SEGMENTS);
        segments.forEach((segment, i) => segment.classList.toggle('on', i < lit));
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
          await wait(350);
          root.classList.add('is-check'); // dash lights up, every lamp on
          await wait(250);
          await sweep();
          root.classList.add('is-ready'); // lamps go out, as they do once the engine runs
          await wait(450);
        }
        root.classList.add('is-done');
        await wait(quick ? 150 : 500);
        root.remove();
        resolve();
      },
      { once: true },
    );
  });
}
