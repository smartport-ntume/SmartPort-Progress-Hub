import spawn from 'cross-spawn';

export class CommandError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'CommandError';
    Object.assign(this, details);
  }
}

export function runCommand(command, args = [], options = {}) {
  const {
    cwd,
    env = process.env,
    timeoutMs = 120_000,
    maxOutputBytes = 4 * 1024 * 1024,
    allowNonZero = false
  } = options;

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;

    const append = (current, chunk) => {
      const next = current + chunk.toString('utf8');
      return next.length > maxOutputBytes ? next.slice(-maxOutputBytes) : next;
    };
    child.stdout?.on('data', chunk => { stdout = append(stdout, chunk); });
    child.stderr?.on('data', chunk => { stderr = append(stderr, chunk); });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
    }, timeoutMs);
    timer.unref();

    child.once('error', error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new CommandError('Unable to start command: ' + command, {
        command,
        code: error.code,
        cause: error
      }));
    });

    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const result = { command, code, signal, stdout, stderr, timedOut };
      if (timedOut) {
        reject(new CommandError('Command timed out: ' + command, result));
      } else if (code !== 0 && !allowNonZero) {
        reject(new CommandError('Command failed: ' + command, result));
      } else {
        resolve(result);
      }
    });
  });
}
