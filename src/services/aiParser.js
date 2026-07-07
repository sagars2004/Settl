// ---------------------------------------------------------------------------
// AI parser — Slack AI natural-language understanding for expenses.
// ---------------------------------------------------------------------------
// Turns messy free-form text ("eighty-four bucks for dinner, split three ways")
// into a structured intent + expense fields using an LLM with JSON-constrained
// output. Provider-agnostic: prefers NVIDIA build (NIM), then OpenAI, then
// Anthropic — whichever key is present — and returns null otherwise so the
// regex fallback keeps the pipeline working with zero configuration.
// ---------------------------------------------------------------------------

const REQUEST_TIMEOUT_MS = 8000;

/**
 * @typedef {Object} AIParseResult
 * @property {'log_expense'|'summary'|'settle'|'help'} intent
 * @property {number|null} amount
 * @property {string|null} currency  ISO 4217, uppercase.
 * @property {string|null} description
 * @property {number|null} waysCount  Explicit "N ways" count, if stated.
 */

const SYSTEM_PROMPT = [
  'You are the parsing layer for Settl, a Slack expense-splitting agent.',
  'Read the user message and return a single JSON object with EXACTLY these keys:',
  '- intent: one of "log_expense", "summary", "settle", "help" (use these exact lowercase values).',
  '    log_expense = recording money someone spent (e.g. "I paid $84 for dinner").',
  '    summary = wants the current tab / who owes what.',
  '    settle = wants to settle up or mark a debt paid.',
  '    help = greetings or anything unclear.',
  '- amount: the numeric total as a number, or null. Convert words to digits ("eighty-four" -> 84).',
  '- currency: 3-letter ISO code (USD, EUR, GBP, JPY...). Use "USD" for "$" or "bucks". null if no amount.',
  '- description: a short 2-4 word label for the expense, with no amounts or split words. null if none.',
  '- waysCount: integer ONLY if the user says "N ways"/"N people"/"between the N of us"; otherwise null.',
  'Return ONLY the JSON object — no prose, no markdown fences.',
  'Example input: "split $84 dinner 3 ways"',
  'Example output: {"intent":"log_expense","amount":84,"currency":"USD","description":"dinner","waysCount":3}',
].join('\n');

const JSON_SCHEMA = {
  type: 'object',
  properties: {
    intent: { type: 'string', enum: ['log_expense', 'summary', 'settle', 'help'] },
    amount: { type: ['number', 'null'] },
    currency: { type: ['string', 'null'] },
    description: { type: ['string', 'null'] },
    waysCount: { type: ['integer', 'null'] },
  },
  required: ['intent', 'amount', 'currency', 'description', 'waysCount'],
  additionalProperties: false,
};

/**
 * Parse a natural-language message with an LLM. Returns null when no provider
 * is configured or the call fails (caller should fall back to regex).
 * @param {string} text
 * @returns {Promise<AIParseResult|null>}
 */
export async function aiParseExpense(text) {
  if (!text || !text.trim()) return null;

  try {
    if (process.env.NVIDIA_API_KEY) {
      return await parseWithNvidia(text);
    }
    if (process.env.OPENAI_API_KEY) {
      return await parseWithOpenAI(text);
    }
    if (process.env.ANTHROPIC_API_KEY) {
      return await parseWithAnthropic(text);
    }
  } catch (error) {
    console.warn('[aiParser] LLM parse failed, falling back to regex:', error.message);
  }
  return null;
}

/** @returns {boolean} whether any AI provider key is configured. */
export function isAIParsingEnabled() {
  return Boolean(
    process.env.NVIDIA_API_KEY ||
      process.env.OPENAI_API_KEY ||
      process.env.ANTHROPIC_API_KEY,
  );
}

/**
 * NVIDIA build (build.nvidia.com / NIM) — OpenAI-compatible endpoint.
 * Uses JSON-object mode (broadly supported across NIM models) plus a
 * schema-in-prompt and resilient extraction, since not every model supports
 * strict json_schema.
 * @param {string} text
 * @returns {Promise<AIParseResult>}
 */
async function parseWithNvidia(text) {
  const baseUrl = (process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1').replace(/\/$/, '');
  const model = process.env.NVIDIA_MODEL || 'meta/llama-3.1-8b-instruct';
  return callOpenAICompatible({
    url: `${baseUrl}/chat/completions`,
    apiKey: process.env.NVIDIA_API_KEY,
    model,
    provider: 'NVIDIA',
    jsonObjectMode: true,
  }, text);
}

/**
 * @param {string} text
 * @returns {Promise<AIParseResult>}
 */
async function parseWithOpenAI(text) {
  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: text },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'settl_expense', strict: true, schema: JSON_SCHEMA },
      },
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`OpenAI ${response.status}`);
  }
  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;
  return normalize(JSON.parse(content));
}

/**
 * Shared caller for OpenAI-compatible chat-completions APIs (OpenAI, NVIDIA).
 * @param {{ url: string, apiKey: string, model: string, provider: string, jsonObjectMode?: boolean }} opts
 * @param {string} text
 * @returns {Promise<AIParseResult>}
 */
async function callOpenAICompatible(opts, text) {
  const body = {
    model: opts.model,
    temperature: 0,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: text },
    ],
  };
  if (opts.jsonObjectMode) {
    body.response_format = { type: 'json_object' };
  }

  const response = await fetch(opts.url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`${opts.provider} ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
  }
  const data = await response.json();
  const content = data.choices?.[0]?.message?.content ?? '';
  return normalize(extractJson(content));
}

/**
 * Extract a JSON object from a model response that may wrap it in prose or
 * markdown code fences.
 * @param {string} content
 * @returns {object}
 */
function extractJson(content) {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : content;
  try {
    return JSON.parse(candidate.trim());
  } catch {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start !== -1 && end > start) {
      return JSON.parse(candidate.slice(start, end + 1));
    }
    throw new Error('No JSON object in model response');
  }
}

/**
 * @param {string} text
 * @returns {Promise<AIParseResult>}
 */
async function parseWithAnthropic(text) {
  const model = process.env.ANTHROPIC_MODEL || 'claude-3-5-haiku-latest';
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 512,
      system: SYSTEM_PROMPT,
      tools: [
        {
          name: 'record_expense',
          description: 'Record the parsed intent and expense fields.',
          input_schema: JSON_SCHEMA,
        },
      ],
      tool_choice: { type: 'tool', name: 'record_expense' },
      messages: [{ role: 'user', content: text }],
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Anthropic ${response.status}`);
  }
  const data = await response.json();
  const toolUse = data.content?.find((part) => part.type === 'tool_use');
  if (!toolUse) throw new Error('No tool_use in Anthropic response');
  return normalize(toolUse.input);
}

/**
 * Coerce raw LLM output into a clean AIParseResult.
 * @param {object} raw
 * @returns {AIParseResult}
 */
function normalize(raw) {
  const amount =
    typeof raw?.amount === 'number' && Number.isFinite(raw.amount)
      ? raw.amount
      : typeof raw?.amount === 'string' && raw.amount.trim() && !Number.isNaN(Number(raw.amount))
        ? Number(raw.amount)
        : null;
  const currency =
    typeof raw?.currency === 'string' && raw.currency.trim()
      ? raw.currency.trim().toUpperCase().slice(0, 3)
      : null;
  const description =
    typeof raw?.description === 'string' && raw.description.trim()
      ? raw.description.trim().slice(0, 80)
      : null;
  const waysCount =
    typeof raw?.waysCount === 'number' && raw.waysCount > 0
      ? Math.floor(raw.waysCount)
      : null;

  return { intent: normalizeIntent(raw?.intent, amount), amount, currency, description, waysCount };
}

/**
 * Map possibly-noisy intent labels (e.g. "EXPENSE", "Log Expense") to canonical
 * values, inferring log_expense when an amount is present but intent is unclear.
 * @param {unknown} value
 * @param {number|null} amount
 * @returns {'log_expense'|'summary'|'settle'|'help'}
 */
function normalizeIntent(value, amount) {
  const label = String(value ?? '').toLowerCase();
  if (['log_expense', 'summary', 'settle', 'help'].includes(label)) return label;
  if (/expense|log|paid|spent|cost|split|bought/.test(label)) return 'log_expense';
  if (/summary|tab|balance|owe/.test(label)) return 'summary';
  if (/settle|pay|square/.test(label)) return 'settle';
  return amount != null ? 'log_expense' : 'help';
}
