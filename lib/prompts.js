'use strict';

/**
 * Default system prompt for the VNC-controlling agent.
 *
 * Kept intentionally concise so it works well with small local models.
 * Replace or extend via Agent's `systemPrompt` option.
 */
const SYSTEM_PROMPT = `You control a remote desktop via VNC. You see screenshots and respond with actions.

Available actions (JSON objects):
  {"cmd":"screenshot"}                              - capture the screen
  {"cmd":"click","x":X,"y":Y}                       - left-click at (X, Y)
  {"cmd":"click","x":X,"y":Y,"button":"right"}      - right-click
  {"cmd":"type","text":"TEXT"}                       - type a string
  {"cmd":"key","combo":"COMBO"}                      - press a key (e.g. "Return", "Ctrl+c", "Ctrl+a")
  {"cmd":"move","x":X,"y":Y}                        - move the mouse
  {"cmd":"scroll","x":X,"y":Y,"amount":N}           - scroll (positive = down, negative = up)
  {"cmd":"delay","ms":N}                            - wait N milliseconds

Respond ONLY with a JSON array of actions to execute next, or {"done":true,"result":"SUMMARY"} when the task is complete.
Example: [{"cmd":"click","x":100,"y":200},{"cmd":"type","text":"hello"},{"cmd":"key","combo":"Return"}]`;

/**
 * Build the user message that accompanies each screenshot.
 *
 * @param {string} task  The task description
 * @param {number} [step=1]  Current step number (shown from step 2 onward)
 * @returns {string}
 */
function buildTaskMessage(task, step = 1) {
  if (step === 1) {
    return `Task: ${task}\n\nLook at the screenshot and respond with the first actions to take.`;
  }
  return `Task: ${task}\n\nStep ${step}: Look at the current screenshot. Respond with the next actions, or {"done":true,"result":"SUMMARY"} if complete.`;
}

/**
 * Create a customised version of the default system prompt.
 *
 * @param {object}  [opts]
 * @param {string}  [opts.extraContext]  Additional context appended to the prompt
 * @param {string}  [opts.language]     Language for the result description (e.g. 'fr')
 * @returns {string}
 */
function createSystemPrompt(opts = {}) {
  let prompt = SYSTEM_PROMPT;
  if (opts.extraContext) {
    prompt += `\n\nContext: ${opts.extraContext}`;
  }
  if (opts.language && opts.language !== 'en') {
    prompt += `\n\nRespond in: ${opts.language}`;
  }
  return prompt;
}

module.exports = { SYSTEM_PROMPT, buildTaskMessage, createSystemPrompt };
