import hljs from 'highlight.js/lib/core';
import python from 'highlight.js/lib/languages/python';
import cpp from 'highlight.js/lib/languages/cpp';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import json from 'highlight.js/lib/languages/json';
import xml from 'highlight.js/lib/languages/xml';
import css from 'highlight.js/lib/languages/css';
import bash from 'highlight.js/lib/languages/bash';
import markdown from 'highlight.js/lib/languages/markdown';
import yaml from 'highlight.js/lib/languages/yaml';
import go from 'highlight.js/lib/languages/go';
import rust from 'highlight.js/lib/languages/rust';
import java from 'highlight.js/lib/languages/java';
import sql from 'highlight.js/lib/languages/sql';
import ini from 'highlight.js/lib/languages/ini';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import diff from 'highlight.js/lib/languages/diff';
import powershell from 'highlight.js/lib/languages/powershell';

for (const [name, grammar] of Object.entries({ python, cpp, javascript, typescript, json, xml, css, bash, markdown, yaml, go, rust, java, sql, ini, dockerfile, diff, powershell })) hljs.registerLanguage(name, grammar);

// Highlight the entire source first so multiline strings/comments keep their grammar.
// Balance its escaped span markup at line boundaries to retain the existing gutters.
export function highlightFileLines(text, language) {
  if (!hljs.getLanguage(language) || text.length > 128 * 1024 || text.split(/\r\n|\r|\n/).length > 3000) return null;
  const html = hljs.highlight(text, { language, ignoreIllegals: true }).value;
  const lines = [], stack = []; let line = '';
  for (const part of html.split(/(<span class="[^"]*">|<\/span>|\r\n|\r|\n)/)) {
    if (/^[\r\n]+$/.test(part)) { lines.push(line + '</span>'.repeat(stack.length)); line = stack.join(''); continue; }
    if (part.startsWith('<span ')) stack.push(part);
    else if (part === '</span>') stack.pop();
    line += part;
  }
  lines.push(line + '</span>'.repeat(stack.length));
  return lines;
}
