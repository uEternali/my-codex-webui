const STORAGE_KEY = 'codex-webui-prompt-history';
const LIMIT = 100;

function texts(values) {
  return (Array.isArray(values) ? values : []).filter(value => typeof value === 'string' && value.trim());
}

export function createPromptHistory({ getEntries, storage } = {}) {
  let saved = [];
  try { saved = texts(JSON.parse(storage?.getItem(STORAGE_KEY) || '[]')).slice(-LIMIT); } catch { /* Storage is optional. */ }
  const recent = new Map();
  let snapshot = null, index = 0;
  const reset = () => { snapshot = null; index = 0; };
  return {
    reset,
    remember(text, scope = '') {
      reset();
      if (!text?.trim()) return;
      saved = [...saved.filter(value => value !== text), text].slice(-LIMIT);
      const entries = recent.get(scope) || [];
      recent.set(scope, [...entries.filter(value => value !== text), text].slice(-LIMIT));
      try { storage?.setItem(STORAGE_KEY, JSON.stringify(saved)); } catch { /* Keep navigation working when storage is full or unavailable. */ }
    },
    navigate(key, value, scope = '') {
      if (key !== 'ArrowUp' && key !== 'ArrowDown') return null;
      if (!snapshot) {
        if (value !== '') return null;
        const history = texts(getEntries?.()), local = recent.get(scope) || [];
        const entries = history.length ? [...history, ...local] : saved;
        // Keep the most recent occurrence, including prompts just sent before a native snapshot arrives.
        snapshot = [...new Set([...entries].reverse())].reverse();
        if (!snapshot.length) { reset(); return null; }
        index = snapshot.length;
      }
      index = Math.max(0, Math.min(snapshot.length, index + (key === 'ArrowUp' ? -1 : 1)));
      return snapshot[index] ?? '';
    },
  };
}
