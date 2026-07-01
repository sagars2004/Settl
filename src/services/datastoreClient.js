// ---------------------------------------------------------------------------
// Datastore client — local JSON persistence for Bolt apps.
// ---------------------------------------------------------------------------
// Slack Datastores only work for Slack-hosted workflow apps (invalid_app_type on
// Bolt + slack run). We persist to .data/*.json locally using the same API
// shape as apps.datastore.* so datastoreService.js stays unchanged.
// Swap this module for Slack API calls after `slack deploy` if needed.
// ---------------------------------------------------------------------------

import fs from 'node:fs/promises';
import path from 'node:path';

import { DATASTORES } from '../../datastores/schema.js';

const PRIMARY_KEYS = {
  [DATASTORES.GROUPS]: 'group_id',
  [DATASTORES.EXPENSES]: 'expense_id',
  [DATASTORES.USER_TOKENS]: 'user_id',
};

const DATA_DIR = path.resolve(process.cwd(), process.env.DATASTORE_DIR || '.data');

/** @type {Map<string, Promise<void>>} */
const writeQueues = new Map();

/**
 * Reserved for a future Slack Datastore backend. No-op for local JSON storage.
 * @param {import('@slack/web-api').WebClient} _client
 */
export function bindDatastoreClient(_client) {
  // Intentionally empty — local file store does not need a WebClient.
}

async function ensureDataDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

function filePath(datastore) {
  return path.join(DATA_DIR, `${datastore}.json`);
}

async function readStore(datastore) {
  await ensureDataDir();
  try {
    const raw = await fs.readFile(filePath(datastore), 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') {
      return {};
    }
    throw error;
  }
}

async function writeStore(datastore, store) {
  const run = async () => {
    await ensureDataDir();
    await fs.writeFile(filePath(datastore), JSON.stringify(store, null, 2));
  };

  const previous = writeQueues.get(datastore) ?? Promise.resolve();
  const next = previous.then(run, run);
  writeQueues.set(datastore, next);
  await next;
}

function primaryKeyFor(datastore) {
  const key = PRIMARY_KEYS[datastore];
  if (!key) throw new Error(`Unknown datastore: ${datastore}`);
  return key;
}

/**
 * Create or replace a datastore item.
 * @param {string} datastore
 * @param {Record<string, unknown>} item
 */
export async function putItem(datastore, item) {
  const pk = primaryKeyFor(datastore);
  const id = item[pk];
  if (!id) throw new Error(`Missing primary key "${pk}" for ${datastore}`);

  const store = await readStore(datastore);
  store[String(id)] = item;
  await writeStore(datastore, store);
  return { ok: true, item };
}

/**
 * Fetch a single item by primary key.
 * @param {string} datastore
 * @param {string} id
 */
export async function getItem(datastore, id) {
  const store = await readStore(datastore);
  return store[id] ?? null;
}

/**
 * Query items. Supports the equality expressions used by datastoreService.
 * @param {string} datastore
 * @param {object} query
 */
export async function queryItems(datastore, query) {
  const store = await readStore(datastore);
  let items = Object.values(store);

  const { expression, expression_attributes: attrs, expression_values: values } = query;
  if (expression && attrs && values) {
    const match = expression.match(/#(\w+)\s*=\s*:(\w+)/);
    if (match) {
      const field = attrs[`#${match[1]}`];
      const expected = values[`:${match[2]}`];
      items = items.filter((item) => item[field] === expected);
    }
  }

  return items;
}

/**
 * Delete a single item by primary key.
 * @param {string} datastore
 * @param {string} id
 */
export async function deleteItem(datastore, id) {
  const store = await readStore(datastore);
  delete store[id];
  await writeStore(datastore, store);
  return { ok: true };
}
