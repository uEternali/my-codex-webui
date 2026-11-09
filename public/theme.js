import { codexIcon } from './codex-icons.js';

const STORAGE_KEY = 'codex-webui-theme';

export function createThemeController({ button, t, onChange }) {
  const system = matchMedia('(prefers-color-scheme:dark)');
  let preference = readPreference();
  let current;

  function readPreference() {
    let value;
    try { value = localStorage.getItem(STORAGE_KEY); } catch {}
    return value === 'light' || value === 'dark' ? value : null;
  }
  function render() {
    const dark = current === 'dark';
    const label = t(dark ? 'Switch to light mode' : 'Switch to dark mode');
    button.innerHTML = codexIcon(dark ? 'sun' : 'moon');
    button.title = label;
    button.setAttribute('aria-label', label);
    button.setAttribute('aria-pressed', String(dark));
  }
  function apply() {
    current = preference || (system.matches ? 'dark' : 'light');
    document.documentElement.dataset.theme = current;
    document.querySelector('meta[name="theme-color"]').content = current === 'dark' ? '#242424' : '#ffffff';
    render();
    onChange();
  }
  button.onclick = () => {
    preference = current === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem(STORAGE_KEY, preference); } catch {}
    apply();
  };
  system.addEventListener('change', () => { if (!preference) apply(); });
  addEventListener('storage', event => {
    if (event.key !== STORAGE_KEY && event.key !== null) return;
    preference = readPreference();
    apply();
  });
  apply();
  return { render };
}
