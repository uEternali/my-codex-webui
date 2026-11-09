import { highlightFileLines } from './file-highlight.js';

self.onmessage = ({ data: { id, text, language } }) => {
  let lines = null;
  try { lines = highlightFileLines(text, language); } catch { /* A failed grammar keeps the plain preview. */ }
  self.postMessage({ id, lines });
};
