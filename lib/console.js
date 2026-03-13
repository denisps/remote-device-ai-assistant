'use strict';

const readline = require('readline');

/**
 * Helper for interacting with the terminal in both TTY and piped modes.
 *
 * Provides consistent prompts for questions, password input, and yes/no prompts.
 * In piped mode (stdin not a TTY), input is pre-buffered so sequential prompts
 * behave predictably.
 */
class Console {
  constructor() {
    this._pipedLines = null;   // null = TTY / not yet initialized
    this._pipedLineIndex = 0;
  }

  /**
   * Pre-buffer stdin lines in non-TTY mode so sequential prompts work.
   */
  async initStdin() {
    if (process.stdin.isTTY) return;
    if (this._pipedLines !== null) return;

    return new Promise((resolve) => {
      const lines = [];
      const rl = readline.createInterface({ input: process.stdin, terminal: false });
      rl.on('line', (l) => lines.push(l));
      rl.on('close', () => { this._pipedLines = lines; resolve(); });
    });
  }

  /**
   * No-op in current implementation; kept for API compatibility.
   */
  closeRL() {
    // Nothing to close — readline interfaces are short-lived in TTY mode
    // and stdin is already consumed in piped mode.
  }

  /**
   * Prompt for a line of input with an optional default value.
   * @param {string} question
   * @param {string} [defaultVal='']
   */
  ask(question, defaultVal = '') {
    return new Promise((resolve) => {
      const label = defaultVal !== '' ? `${question} [${defaultVal}]: ` : `${question}: `;

      if (this._pipedLines !== null) {
        // Piped / non-interactive mode: answer from pre-buffered lines.
        const raw = (this._pipedLineIndex < this._pipedLines.length) ? this._pipedLines[this._pipedLineIndex++] : '';
        const answer = raw.trim() !== '' ? raw.trim() : defaultVal;
        process.stdout.write(`${label}${answer}\n`);
        resolve(answer);
        return;
      }

      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.question(label, (answer) => {
        rl.close();
        resolve(answer.trim() !== '' ? answer.trim() : defaultVal);
      });
    });
  }

  /**
   * Prompt for a yes/no answer.
   * @param {string} question
   * @param {boolean} [defaultYes=true]
   */
  async askYesNo(question, defaultYes = true) {
    const hint = defaultYes ? 'Y/n' : 'y/N';
    const answer = await this.ask(`${question} [${hint}]`);
    if (answer === '' || answer === (defaultYes ? 'Y/n' : 'y/N')) return defaultYes;
    return /^y/i.test(answer);
  }

  /**
   * Prompt for a secret value (password) without echoing typed characters.
   * Falls back to a visible prompt when stdin is not a TTY.
   * @param {string} question
   */
  askSecret(question) {
    if (this._pipedLines !== null) return this.ask(question);

    return new Promise((resolve) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      let questionShown = false;
      rl._writeToOutput = (str) => {
        if (!questionShown) {
          process.stdout.write(str);
          questionShown = true;
        } else if (str === '\r\n' || str === '\n' || str === '\r') {
          process.stdout.write('\n');
        }
        // Suppress echoing of typed characters
      };
      rl.question(`${question}: `, (answer) => {
        rl.close();
        resolve(answer);
      });
    });
  }
}

module.exports = { Console };
