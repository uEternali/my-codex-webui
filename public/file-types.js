// Only the SVGs used here are shipped; no icon font or runtime CDN is required.
const types = {
  python: ['python', 'python', 'Python'], cpp: ['cpp', 'cpp', 'C++'], c: ['c', 'cpp', 'C'],
  js: ['js_official', 'javascript', 'JavaScript'], ts: ['typescript_official', 'typescript', 'TypeScript'],
  json: ['json', 'json', 'JSON'], html: ['html', 'xml', 'HTML'], xml: ['html', 'xml', 'XML'],
  css: ['css', 'css', 'CSS'], md: ['markdown', 'markdown', 'Markdown'], yaml: ['yaml', 'yaml', 'YAML'],
  go: ['go', 'go', 'Go'], rust: ['rust', 'rust', 'Rust'], java: ['java', 'java', 'Java'],
  shell: ['shell', 'bash', 'Shell'], powershell: ['powershell', 'powershell', 'PowerShell'],
  docker: ['docker', 'dockerfile', 'Dockerfile'], git: ['git', 'diff', 'Diff'],
  sql: ['sql', 'sql', 'SQL'], config: ['config', 'ini', 'INI'],
  image: ['image'], pdf: ['pdf'], zip: ['zip'], text: ['text'], binary: ['binary'],
};
const extensions = {};
for (const [type, names] of Object.entries({
  python: 'py pyw pyi', cpp: 'cpp cc cxx hpp hh hxx cu cuh', c: 'c h', js: 'js mjs cjs jsx', ts: 'ts mts cts tsx',
  json: 'json jsonc ipynb', html: 'html htm vue svelte', xml: 'xml svg xsl xsd', css: 'css', md: 'md mdx markdown',
  yaml: 'yml yaml', go: 'go', rust: 'rs', java: 'java', shell: 'sh bash zsh fish', powershell: 'ps1 psm1 psd1',
  docker: 'dockerfile', git: 'diff patch', sql: 'sql', config: 'ini conf cfg properties toml',
  image: 'png jpg jpeg gif webp avif bmp ico', pdf: 'pdf', zip: 'zip gz tar tgz bz2 xz 7z rar',
  text: 'txt log csv tsv', binary: 'bin exe dll so o a wasm pyc',
})) for (const extension of names.split(' ')) extensions[extension] = type;

export function fileType(path, kind = 'file', expanded = false) {
  if (kind === 'folder') return { icon: expanded ? 'default_folder_opened' : 'default_folder', label: 'Folder' };
  const name = path.split('/').at(-1).toLowerCase();
  let type = extensions[name.split('.').at(-1)];
  if (/^dockerfile(?:\.|$)/.test(name)) type = 'docker';
  else if (/^\.git/.test(name)) return { icon: 'file_type_git', label: 'Git' };
  else if (/^(?:\.bashrc|\.zshrc|\.profile)$/.test(name)) type = 'shell';
  else if (/^(?:\.env(?:\..*)?|\.editorconfig)$/.test(name)) type = 'config';
  const [icon, language, label] = types[type] || ['default_file'];
  return { icon: icon.startsWith('default_') ? icon : `file_type_${icon}`, language, label: label || 'Plain text' };
}

export function fileIcon(path, kind = 'file', expanded = false) {
  return `<img class="file-type-icon" src="/assets/file-icons/${fileType(path, kind, expanded).icon}.svg" width="16" height="16" alt="" aria-hidden="true" draggable="false">`;
}
