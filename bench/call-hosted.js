// bench/call-hosted.js
// Hosted-model adapter for the bench: OpenAI-compatible chat/completions
// client standing in for the local Ollama callModel. Credentials come from
// bench/.api-env.json (gitignored) -- the key is never hardcoded anywhere
// tracked. Exported as a direct callModel drop-in for suite-runner/bake-off,
// plus loadApiEnv() so callers can resolve the model identity for cache tags
// and fail cleanly (with instructions) when the env file is missing.
//
//   { provider, endpoint, model, apiKey }
//
// Retry policy: one retry on 429/5xx with a 2s backoff. Any other failure
// propagates to the caller (LlmQuery.parse degrades to the deterministic
// fallback rather than aborting a run).

const fs = require('fs');
const path = require('path');

const ENV_FILE = path.join(__dirname, '.api-env.json');
const DEFAULT_TIMEOUT_MS = 30000;
// LlmQuery passes its local-model budget (45s); the hosted reasoning model
// measured 27-72s/call under load, so the adapter enforces its own floor.
const HOSTED_TIMEOUT_FLOOR_MS = 120000;
const RETRY_BACKOFF_MS = 2000;

const MISSING_ENV_INSTRUCTIONS = [
  'bench/.api-env.json is missing or unreadable. Hosted mode needs an',
  'OpenAI-compatible endpoint. Create bench/.api-env.json (gitignored):',
  '',
  '  {',
  '    "provider": "openai-compatible",',
  '    "endpoint": "https://api.b.ai/v1/chat/completions",',
  '    "model": "glm-5.3-flash",',
  '    "apiKey": "<your key>"',
  '  }',
  '',
  'NEVER commit this file or hardcode the key anywhere tracked.'
].join('\n');

function loadApiEnv() {
  let env;
  try {
    // stripBOM: editors on Windows frequently write a UTF-8 BOM; JSON.parse
    // rejects it and a BOM must not look like a missing-credentials failure.
    env = JSON.parse(fs.readFileSync(ENV_FILE, 'utf8').replace(/^\uFEFF/, ''));
  } catch (e) {
    throw new Error(MISSING_ENV_INSTRUCTIONS + `\n\n(read failed: ${e.message})`);
  }
  for (const k of ['endpoint', 'model', 'apiKey']) {
    if (!env || typeof env[k] !== 'string' || !env[k].trim()) {
      throw new Error(`${MISSING_ENV_INSTRUCTIONS}\n\n(missing required field "${k}")`);
    }
  }
  return env;
}

async function chatOnce(env, system, prompt, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(env.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${env.apiKey}`
      },
      body: JSON.stringify({
        model: env.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: prompt }
        ],
        stream: false,
        // glm-5.3-flash reasons before answering: the full LlmQuery SYSTEM
        // prompt measured ~900 reasoning tokens (finish=length, content:""
        // at 400). 2048 lets every observed parse reach finish=stop.
        max_tokens: 2048,
        temperature: 0
      }),
      signal: ctrl.signal
    });
    if (res.status === 429 || res.status >= 500) {
      const err = new Error(`hosted endpoint HTTP ${res.status}`);
      err.retryable = true;
      throw err;
    }
    if (!res.ok) throw new Error(`hosted endpoint HTTP ${res.status}`);
    const data = await res.json();
    const content = data && data.choices && data.choices[0] &&
      data.choices[0].message && data.choices[0].message.content;
    // Empty content happens under load (observed on this endpoint: valid
    // HTTP 200 with content:""). Treat it like a 5xx -- retryable -- rather
    // than letting it degrade the parse to fallback.
    if (typeof content !== 'string' || !content.trim()) {
      const err = new Error('hosted endpoint returned empty choices[0].message.content');
      err.retryable = true;
      throw err;
    }
    return content;
  } finally {
    clearTimeout(timer);
  }
}

async function callHostedModel(system, prompt, timeoutMs) {
  const env = loadApiEnv();
  const timeout = Number.isFinite(timeoutMs) ? timeoutMs : DEFAULT_TIMEOUT_MS;
  try {
    return await chatOnce(env, system, prompt, timeout);
  } catch (e) {
    if (!e.retryable) throw e;
    await new Promise(r => setTimeout(r, RETRY_BACKOFF_MS));
    return chatOnce(env, system, prompt, timeout);
  }
}

module.exports = callHostedModel;
module.exports.loadApiEnv = loadApiEnv;
