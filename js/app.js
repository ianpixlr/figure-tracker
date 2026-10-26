import { render, start } from './ui.js';
import { load } from './store.js';
import { startAutoSync } from './sync.js';
import { currentMonth, now, setNow, todayYMD } from './time.js';

start();
startAutoSync(() => {
  const loaded = load(currentMonth());
  return loaded.corrupt ? null : loaded.data;
});

if ('serviceWorker' in navigator) {
  let reloaded = false;
  const hadController = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloaded) return;
    reloaded = true;
    window.location.reload();
  });
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}

const host = location.hostname;
if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]') {
  window.__figureCap = {
    setNow(value) {
      setNow(value);
      render();
    },
    clearNow() {
      setNow(null);
      render();
    },
    dump() {
      return load(todayYMD());
    },
    today() {
      return todayYMD();
    },
    now() {
      return now().toISOString();
    }
  };
}
