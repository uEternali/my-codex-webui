import pty from 'node-pty';
import { hostname } from 'node:os';

const cwd = process.argv[2] || process.cwd();
const cols = Number(process.argv[3]) || 100;
const rows = Number(process.argv[4]) || 24;
const shell = process.env.SHELL || (process.platform === 'win32' ? 'powershell.exe' : '/bin/zsh');
const args = process.platform === 'win32' ? [] : ['-l'];
const terminal = pty.spawn(shell, args, {
  name: 'xterm-256color',
  cols,
  rows,
  cwd,
  // HOST configures the WebUI listener; zsh also uses it for %m in prompts.
  env: { ...process.env, HOST: hostname(), TERM: 'xterm-256color', COLORTERM: 'truecolor' },
});

terminal.onData(data => process.stdout.write(data));
terminal.onExit(({ exitCode }) => process.exit(Number.isInteger(exitCode) ? exitCode : 0));
process.stdin.on('data', data => terminal.write(data.toString('utf8')));
process.stdin.on('end', () => terminal.kill());
process.on('message', message => {
  if (message?.type === 'resize') terminal.resize(message.cols, message.rows);
});
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
  try { terminal.kill(); } finally { process.exit(0); }
});
