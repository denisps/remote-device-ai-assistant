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

COORDINATES: x and y are ALWAYS in the range 0-1000, where (0,0) is the top-left corner and (1000,1000) is the bottom-right corner of the screen, regardless of the image resolution.

Respond ONLY with a JSON array of actions, or {"done":true,"result":"SUMMARY"} when the task is complete.

IMPORTANT rules:
- Before deciding any action, identify what screen/app is currently visible in the screenshot.
- Only click on elements you can actually SEE and identify in the current screenshot. Never assume or guess coordinates for UI elements such as home buttons, back buttons, or navigation bars — locate them visually first.
- Every action must have a "reason" field that names the UI element you are targeting and why.
- If the previous step's screenshot looks the same as before (no visible change) you MUST try a DIFFERENT approach — do not repeat the same action.
- Never try to open an app or screen you are already on — if you are already there, proceed to the next part of the task directly.
- Be precise with coordinates: describe what element is at (x,y) in the "reason".
- Always end your action array with {"cmd":"screenshot","reason":"Verify result"} so you can confirm the outcome before deciding the next step. Only omit this when returning {"done":true,...}.
- Once you have completed the task objective, return {"done":true,"result":"..."} immediately. Do NOT keep performing more actions after the goal is achieved.

Example:
[{"cmd":"click","x":100,"y":200,"reason":"Open File menu in top menu bar"},{"cmd":"screenshot","reason":"Verify the menu opened"}]`;

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
    msg += '\nHistory of actions tried so far (oldest first):\n';
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
      if (entry.note) msg += `    Outcome: ${entry.note}\n`;
    }
    msg += '\nNow look at the CURRENT screenshot and reason:\n';
    msg += '  1. Where am I now? What screen/app is visible?\n';
    msg += '  2. Did the last step achieve its intended goal? If not, what went wrong?\n';
    msg += '  3. What is the best NEXT action to make progress — avoid repeating actions that already failed.\n';
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
