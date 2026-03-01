'use strict';

/**
 * Default system prompt for the VNC-controlling agent.
 *
 * Kept intentionally concise so it works well with small local models.
 * Replace or extend via Agent's `systemPrompt` option.
 */
const SYSTEM_PROMPT = `You control a remote desktop via VNC. You see screenshots and respond with actions.

Available actions (JSON objects) — every action MUST include a "reason" field describing your intent:
  {"cmd":"screenshot","reason":"..."}
  {"cmd":"click","x":X,"y":Y,"reason":"..."}
  {"cmd":"click","x":X,"y":Y,"button":"right","reason":"..."}
  {"cmd":"type","text":"TEXT","reason":"..."}
  {"cmd":"key","combo":"COMBO","reason":"..."}        - e.g. "Return", "Ctrl+c", "ctrl+a"
  {"cmd":"move","x":X,"y":Y,"reason":"..."}
  {"cmd":"scroll","x":X,"y":Y,"amount":N,"reason":"..."}   - positive = down
  {"cmd":"delay","ms":N,"reason":"..."}

Respond ONLY with a JSON array of actions, or {"done":true,"result":"SUMMARY"} when the task is complete.

IMPORTANT rules:
- Every action must have a "reason" field that names the UI element you are targeting and why.
- If the previous step's screenshot looks the same as before (no visible change) you MUST try a DIFFERENT approach — do not repeat the same action.
- Be precise with coordinates: describe what element is at (x,y) in the "reason".

Example:
[{"cmd":"click","x":100,"y":200,"reason":"Open File menu in top menu bar"},{"cmd":"screenshot","reason":"Check result"}]`;

/**
 * Build the user message that accompanies each screenshot.
 *
 * @param {string}   task          The task description
 * @param {number}   [step=1]      Current step number
 * @param {Array}    [history=[]]  List of {step, actions, note} from previous steps
 * @returns {string}
 */
function buildTaskMessage(task, step = 1, history = []) {
  let msg = `Task: ${task}\n`;

  if (history.length > 0) {
    msg += '\nActions taken so far:\n';
    for (const entry of history) {
      const actSummary = entry.actions
        .map(a => {
          const coords = (a.x !== undefined && a.y !== undefined) ? ` at (${a.x},${a.y})` : '';
          const text   = a.text ? ` "${a.text}"` : (a.combo ? ` "${a.combo}"` : '');
          const reason = a.reason ? ` — ${a.reason}` : '';
          return `    ${a.cmd}${coords}${text}${reason}`;
        })
        .join('\n');
      msg += `  Step ${entry.step}:\n${actSummary}\n`;
      if (entry.note) msg += `    → ${entry.note}\n`;
    }
    msg += '\nLook at the CURRENT screenshot. If previous actions had no visible effect, try a DIFFERENT approach.\n';
  } else {
    msg += '\nLook at the screenshot and respond with the first actions to take.\n';
  }

  if (step === 1) {
    msg += '\nRespond with the first actions to take.';
  } else {
    msg += `\nStep ${step}: Respond with the next actions, or {"done":true,"result":"SUMMARY"} if the task is complete.`;
  }
  return msg;
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
