import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const dir = dirname(fileURLToPath(import.meta.url));
const python = join(dir, '.venv', 'Scripts', 'python.exe');
if (!existsSync(python)) {
  console.error('请先执行：powershell -ExecutionPolicy Bypass -File desktop-pet/setup.ps1');
  process.exitCode = 1;
} else {
  const child = spawn(python, [join(dir, 'run.py'), ...process.argv.slice(2)], { cwd:dirname(dir), windowsHide:true, stdio:'inherit', env:{...process.env,PPA_NODE:process.execPath} });
  child.on('error', e => { console.error(e.message); process.exitCode=1; });
  child.on('exit', code => { process.exitCode=code??1; });
}
