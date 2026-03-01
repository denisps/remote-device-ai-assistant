'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const CONFIG_DIR  = path.join(os.homedir(), '.config', 'remote-device-assistant');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

/**
 * Load the saved configuration, or return null if none exists.
 * @returns {Promise<object|null>}
 */
async function loadConfig() {
  try {
    const raw = await fs.promises.readFile(CONFIG_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

/**
 * Save configuration to disk.
 * @param {object} config
 */
async function saveConfig(config) {
  await fs.promises.mkdir(CONFIG_DIR, { recursive: true });
  await fs.promises.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
}

module.exports = { loadConfig, saveConfig, CONFIG_FILE, CONFIG_DIR };
