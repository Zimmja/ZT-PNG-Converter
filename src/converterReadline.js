const readline = require('readline');

function createRl() {
  // Piped stdin (e.g. tests) stays paused until resumed; readline still needs bytes flowing.
  if (typeof process.stdin.isPaused === 'function' && process.stdin.isPaused()) {
    process.stdin.resume();
  }
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: Boolean(process.stdin.isTTY),
  });
}

/**
 * @param {import('readline').Interface} rl
 * @param {string} prompt
 * @param {string} [defaultValue]
 */
function ask(rl, prompt, defaultValue) {
  const hint =
    defaultValue !== undefined && defaultValue !== ''
      ? ` (default: ${defaultValue})`
      : '';
  return new Promise((resolve) => {
    rl.question(`${prompt}${hint}: `, (answer) => {
      const t = String(answer).trim();
      if (t === '' && defaultValue !== undefined) {
        resolve(defaultValue);
        return;
      }
      resolve(t);
    });
  });
}

module.exports = {
  createRl,
  ask,
};
