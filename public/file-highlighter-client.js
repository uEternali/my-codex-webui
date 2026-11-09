import { fileType } from './file-types.js';

export function createFileHighlighter(window) {
  let worker = null, sequence = 0, unavailable = false;
  const jobs = new Map();
  function stop() {
    worker?.terminate(); worker = null;
    for (const job of jobs.values()) { clearTimeout(job.timer); job.resolve(null); }
    jobs.clear();
  }
  return {
    highlight(path, text) {
      const language = fileType(path).language;
      if (unavailable || !language || !window.Worker || text.length > 128 * 1024 || text.split(/\r\n|\r|\n/).length > 3000) return Promise.resolve(null);
      try {
        if (!worker) {
          worker = new window.Worker('/file-highlight-worker.bundle.js');
          worker.onmessage = ({ data }) => {
            const job = jobs.get(data.id); if (!job) return;
            clearTimeout(job.timer); jobs.delete(data.id); job.resolve(data.lines);
          };
          worker.onerror = () => { unavailable = true; stop(); };
        }
        return new Promise(resolve => {
          const id = ++sequence;
          const timer = setTimeout(() => { unavailable = true; stop(); }, 3000);
          jobs.set(id, { resolve, timer }); worker.postMessage({ id, text, language });
        });
      } catch { unavailable = true; stop(); return Promise.resolve(null); }
    },
    dispose() { unavailable = true; stop(); },
  };
}
