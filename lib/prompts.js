'use strict';

/**
 * System prompt that tells the model to think out loud before acting.
 *
 * The model writes free-form reasoning with embedded JSON action blocks.
 * The runtime extracts and executes the JSON; the reasoning text becomes
 * the history entry the model's "future self" reads on the next step.
 */
const SYSTEM_PROMPT = `You control a remote desktop via VNC. You see a screenshot and must work toward completing the user's task.

COMMAND FORMAT: json object with the command itself in the "cmd" field, and any arguments as additional fields. You can also send an array of the objects to execute in sequence.
EXAMPLE: [{"cmd":"move","x":500,"y":300},{"cmd":"click"}]
EXAMPLE: {"cmd":"type","text":"hello"}

SUPPORTED COMMANDS:
Command "click" - click at the current mouse pointer. Use move/dmove first to reposition if needed.
  Optional argument: button ("left"|"right"|"middle", default "left").
Command "move" - move mouse to absolute position (animated).
  Arguments: x, y (numbers, 0-1000 normalised or pixels depending on coord system).
Command "dmove" - move mouse by relative delta (animated).
  Arguments: dx, dy (numbers, positive or negative change).
Command "type" - type text at current cursor position.
  Argument: text (string).
Command "key" - send keyboard shortcut or special key.
  Argument: combo (string, e.g. "Return", "Ctrl+c").
Command "scroll" - scroll relative at current mouse pointer position.
  Arguments: "h", "v" (horizontal and/or vertical deltas). Both default to 0.
Command "delay" - wait before continuing.
  Argument: ms (number, milliseconds).
  Optional: minChange (float number 0-1, hint for expected screen change as a fraction of total pixels).

TASK COMPLETION:
When the task is complete, respond with ONLY: {"done":true,"result":"one-sentence summary"}

JSON FORMAT:
Embed actions as valid JSON objects or array of objects in your response text. Examples:
  Single action: {"cmd":"click"}
  Multiple actions: [{"cmd":"move","x":100,"y":100},{"cmd":"click"}]

HOW TO RESPOND — think step by step, then embed actions:

1. OBSERVE: Briefly describe what you see on the screen. Note the mouse cursor position if relevant.
2. ASSESS: If this is not the first step, state whether the previous action achieved its goal. If not, explain what went wrong.
3. PLAN: State what you will do next and why. If a previous attempt failed, you MUST try a different element or approach.
4. TARGET: For each UI element you intend to interact with, describe:
   - What it looks like (icon, text label, colour, shape)
   - Where it is on screen (e.g. "top-right corner", "centre of the list")
   - Approximate bounding box in 0-1000 coords: [left, top, right, bottom]
5. ACT: Embed the JSON action(s) inline in your text.
6. EXPECT: Describe what you expect to see after the action.

RULES:
- The white mouse cursor is rendered on the screenshot showing current position
- Only interact with elements you can SEE in the current screenshot. Never guess positions.
- Never repeat an action that already failed — try a different element or route.
- Keep your reasoning concise (2-5 sentences per section).
- Don't guess UI element positions. If you can't find a reliable target, try a different approach (e.g. keyboard shortcuts, context menu).
- When the task objective is met, immediately return the done signal. Do not keep acting.

Example response:
OBSERVE: I see the Android home screen with several app icons. The mouse cursor is at the top-left. The Settings gear icon is in the app drawer at the bottom.
PLAN: I will move to and tap the Settings gear icon to open system settings.
TARGET: Settings gear icon — grey cog shape, centre of bottom row, bbox [900,900,940,940].
ACT: {"cmd":"move","x":920,"y":920} {"cmd":"click"}
EXPECT: The Settings app should open showing the main settings menu.`;

/*
For later implementation
COORDINATES: x and y use a 0-1000 normalised range. (0,0) = top-left, (1000,1000) = bottom-right.
- Prefer known key combos to clicking on dubious UI elements (e.g. use {"cmd":"key","combo":"home"} instead of clicking random squares).
*/

/**
 * Build the user message that accompanies each screenshot.
 *
 * @param {string} task          The task description
 * @param {number} [step=1]     Current step number
 * @param {Array}  [history=[]] List of {step, reasoning, note} from previous steps
 * @returns {string}
 */
function buildTaskMessage(task, step = 1, history = []) {
  let msg = `Task: ${task}\n`;

  if (history.length > 0) {
    msg += '\n--- HISTORY (your previous reasoning and outcomes) ---\n';
    for (const entry of history) {
      msg += `\nStep ${entry.step}:\n${entry.reasoning}\n`;
      if (entry.note) msg += `OUTCOME: ${entry.note}\n`;
    }
    msg += '\n--- END HISTORY ---\n';
  }

  if (step === 1) {
    msg += '\nThis is the first step. Look at the screenshot and begin.\n';
  } else {
    msg += `\nStep ${step}: Look at the CURRENT screenshot and continue. Follow the OBSERVE → ASSESS → PLAN → TARGET → ACT → EXPECT format.\n`;
    msg += 'If the task is complete, respond with ONLY: {"done":true,"result":"summary"}\n';
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

/**
 * Build the messages array for an AI summarization request (text-only, no image).
 * The summary replaces old history so the model doesn't lose context but the
 * prompt doesn't grow unboundedly.
 *
 * @param {string} task      The original task description
 * @param {Array}  history   Full history array to summarise
 * @returns {Array}          Messages array ready for ai.chat()
 */
function buildSummaryRequest(task, history) {
  const transcript = history
    .map(e => `Step ${e.step}:\n${e.reasoning}${e.note ? '\n' + e.note : ''}`)
    .join('\n\n');

  return [
    {
      role: 'system',
      content: 'You are summarising a session log. Be concise but keep all important facts: what screens were visited, what was tried, what worked, what failed, and where the task currently stands.',
    },
    {
      role: 'user',
      content: `Original task: ${task}\n\nSession so far:\n${transcript}\n\n` +
        'Write a compact summary (200 words max) that a future agent can read to continue the task without repeating failed steps.',
    },
  ];
}

module.exports = { SYSTEM_PROMPT, buildTaskMessage, buildSummaryRequest, createSystemPrompt };
