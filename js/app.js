import { render, start } from './ui.js';
import { load } from './store.js';
import { now, setNow, todayYMD } from './time.js';

start();

if ('serviceWorker' in navigator) {
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
