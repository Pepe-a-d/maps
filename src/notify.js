// Game-style notification that slides in from the left: a hexagon badge, a
// small kicker line and a big title. One at a time; a few more wait their turn.

const SHOW_MS = 3200;
const MAX_WAITING = 3;

const queue = [];
let banner = null;
let busy = false;

function element() {
  if (!banner) {
    banner = document.createElement('div');
    banner.className = 'discover';
    banner.setAttribute('role', 'status');
    document.body.append(banner);
  }
  return banner;
}

// { kicker, title, color?, icon? } — icon is SVG markup shown in a hexagon of `color`.
export function notify(message) {
  queue.push(message);
  if (queue.length > MAX_WAITING) queue.splice(0, queue.length - MAX_WAITING);
  if (!busy) next();
}

function next() {
  const message = queue.shift();
  if (!message) {
    busy = false;
    return;
  }
  busy = true;
  const el = element();
  el.innerHTML = `${message.icon ? `<span class="discover__badge" style="--c: ${message.color}">${message.icon}</span>` : ''}
    <span class="discover__text"><small></small><b></b></span>`;
  el.querySelector('small').textContent = message.kicker;
  el.querySelector('b').textContent = message.title;
  el.classList.remove('is-shown');
  void el.offsetWidth; // restart the animation
  el.classList.add('is-shown');
  setTimeout(next, SHOW_MS + 150);
}
