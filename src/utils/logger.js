'use strict';

/**
 * Minimal leveled logger with redaction.
 *
 * Every object passed to the logger goes through `redact()`, which:
 * - removes credential-looking keys (authorization, token, api key, secret...),
 * - masks token-looking strings ("Bearer ...", "pat-..."),
 * - masks e-mail addresses (personal data) down to their first character and domain.
 * So neither a token nor a full e-mail can reach the console through the logger,
 * even if someone logs an axios config object or a contact payload by accident.
 */

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

const SENSITIVE_KEY_PATTERN = /authorization|token|api[-_]?key|secret|password|cookie/i;
const SENSITIVE_VALUE_PATTERN = /(bearer\s+\S+|pat-[a-z0-9-]+)/gi;
const EMAIL_PATTERN = /([^\s@/:]{1})[^\s@/:]*@([^\s@/:]+\.[^\s@/:?&]+)/g;

let currentLevel = (process.env.LOG_LEVEL || 'info').toLowerCase();
if (!(currentLevel in LEVELS)) currentLevel = 'info';

function setLevel(level) {
  if (level in LEVELS) currentLevel = level;
}

function getLevel() {
  return currentLevel;
}

/** Masks tokens inside free text ("Bearer ...", "pat-..."). */
function maskSecrets(text) {
  if (typeof text !== 'string') return text;
  return text.replace(SENSITIVE_VALUE_PATTERN, '[REDACTED]');
}

/**
 * Masks tokens and e-mails inside free text: "jane.doe@example.com" -> "j***@example.com".
 * URL-encoded e-mails ("jane.doe%40example.com", as they appear in request paths) are masked too.
 */
function maskPersonalData(text) {
  if (typeof text !== 'string') return text;
  return maskSecrets(text).replace(/%40/gi, '@').replace(EMAIL_PATTERN, '$1***@$2');
}

/**
 * Deep-copies `value`, replacing sensitive keys with "[REDACTED]" and masking
 * token-looking strings and, by default, e-mails. Handles Error instances, arrays
 * and circular references.
 *
 * @param {*} value
 * @param {object} [options]
 * @param {boolean} [options.maskEmails=true]  false for operator-facing output (example scripts)
 */
function redact(value, options = {}, seen = new WeakSet()) {
  const maskText = options.maskEmails === false ? maskSecrets : maskPersonalData;
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') return maskText(value);

  if (typeof value !== 'object') return value;

  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  if (Array.isArray(value)) return value.map((item) => redact(item, options, seen));

  if (value instanceof Error) {
    const base = { name: value.name, message: maskText(value.message) };
    for (const key of Object.keys(value)) {
      base[key] = SENSITIVE_KEY_PATTERN.test(key) ? '[REDACTED]' : redact(value[key], options, seen);
    }
    return base;
  }

  const output = {};
  for (const [key, item] of Object.entries(value)) {
    output[key] = SENSITIVE_KEY_PATTERN.test(key) ? '[REDACTED]' : redact(item, options, seen);
  }
  return output;
}

function format(level, message, meta) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${level.toUpperCase().padEnd(5)} ${maskPersonalData(message)}`;
  if (meta === undefined) return line;
  const cleaned = redact(meta);
  if (cleaned && typeof cleaned === 'object' && !Array.isArray(cleaned)) {
    for (const key of Object.keys(cleaned)) if (cleaned[key] === undefined || cleaned[key] === null) delete cleaned[key];
    if (Object.keys(cleaned).length === 0) return line;
  }
  return `${line} ${JSON.stringify(cleaned)}`;
}

function log(level, message, meta) {
  if (LEVELS[level] > LEVELS[currentLevel]) return;
  const line = format(level, message, meta);
  if (level === 'error' || level === 'warn') {
    process.stderr.write(`${line}\n`);
  } else {
    process.stdout.write(`${line}\n`);
  }
}

module.exports = {
  error: (message, meta) => log('error', message, meta),
  warn: (message, meta) => log('warn', message, meta),
  info: (message, meta) => log('info', message, meta),
  debug: (message, meta) => log('debug', message, meta),
  redact,
  maskPersonalData,
  maskSecrets,
  setLevel,
  getLevel,
  LEVELS,
};
