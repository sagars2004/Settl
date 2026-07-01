# Settl

> A native Slack agent for shared expense tracking and settlement — for roommates splitting rent and teams reconciling an offsite alike.

Settl turns any Slack message into a tracked, actionable expense. Log costs in plain English with `@Settl`, track a running tab per group or channel, and settle up in one command. It’s powered by **Slack AI** (natural-language parsing), the **Splitwise MCP** (bidirectional sync), the **Real-Time Search API** (live FX rates), and **Slack Datastores** (serverless persistence) — all built on **Bolt for JavaScript**.

---

## Features (MVP)

| Feature | Trigger |
|---|---|
| Log expense (natural language) | `@Settl grabbed dinner, $94, split 4 ways` or `/settl add` |
| View balance summary | `/settl summary` |
| Settle a balance | `/settl settle @user` |
| Create a group | `/settl create [name] @a @b` |
| List members | `/settl members` |
| Connect Splitwise | `/settl connect splitwise` |
| Currency conversion | auto on non-USD amounts |
| Proactive nudge | `/settl remind [frequency]` |

---

## Repository structure

```
settl/
├── .slack/config.json          # Slack CLI config
├── manifest.json               # Slack app manifest (scopes, commands, events)
├── .env.example                # Template for environment variables
├── package.json
├── src/
│   ├── index.js                # App entry point, Bolt initialization
│   ├── listeners/
│   │   ├── mentions.js         # @Settl mention + DM handler
│   │   ├── commands.js         # /settl slash command router
│   │   └── actions.js          # Block Kit button action handlers
│   ├── services/
│   │   ├── expenseParser.js    # Slack AI NLP integration
│   │   ├── splitwiseMCP.js     # Splitwise MCP client
│   │   ├── currencyService.js  # RTS API FX rate fetching
│   │   └── datastoreService.js # Slack Datastore CRUD helpers
│   ├── utils/
│   │   ├── balanceCalculator.js
│   │   ├── formatter.js        # Block Kit message builders
│   │   └── venmoLink.js        # Venmo deep link generator
│   └── agents/
│       └── nudgeAgent.js       # Proactive nudge scheduler
├── datastores/
│   └── schema.js               # Datastore schema definitions
└── README.md
```

> **Note:** This repo is currently scaffolding — functions are stubbed and wired together, but business logic is not yet implemented.

---

## Prerequisites

- **Node.js** LTS (v20+)
- **Slack CLI** — `npm install -g @slack/cli`
- **Slack Developer Program** account (for sandbox access)
- **ngrok** — only needed if running in HTTP mode instead of Socket Mode
- **Splitwise developer account** — for MCP OAuth credentials
- A running **Splitwise MCP server** (e.g. [`tarunn2799/splitwise-mcp`](https://github.com/tarunn2799/splitwise-mcp))

---

## Local setup

```bash
# 1. Clone and enter the project
git clone https://github.com/YOUR_USERNAME/settl.git
cd settl

# 2. Initialize the Slack CLI in this directory (links the manifest)
slack create .

# 3. Install dependencies
npm install

# 4. Configure environment variables
cp .env.example .env
# Fill in .env with your Slack + Splitwise credentials (see below)

# 5. Start local dev with hot reload
slack run
```

### Running without the Slack CLI

The app also boots directly with Node:

```bash
npm run dev    # node --watch src/index.js
# or
npm start      # node src/index.js
```

Socket Mode is enabled by default (`SLACK_SOCKET_MODE=true`), so no public URL
is required. To run in HTTP mode instead, set `SLACK_SOCKET_MODE=false`, expose
your local port with ngrok, and set the resulting URL as your app’s Request URL:

```bash
ngrok http 3000
```

---

## Environment variables

Copy `.env.example` to `.env` and fill in:

| Variable | Description |
|---|---|
| `SLACK_BOT_TOKEN` | Bot User OAuth token (`xoxb-…`) |
| `SLACK_APP_TOKEN` | App-level token (`xapp-…`), required for Socket Mode |
| `SLACK_SIGNING_SECRET` | Verifies inbound Slack requests |
| `SPLITWISE_CONSUMER_KEY` | Splitwise OAuth app key |
| `SPLITWISE_CONSUMER_SECRET` | Splitwise OAuth app secret |
| `SPLITWISE_MCP_URL` | URL of the running Splitwise MCP server |
| `RTS_API_KEY` | Real-Time Search API key (FX rates) |
| `SLACK_SOCKET_MODE` | `true` (default) or `false` for HTTP mode |
| `PORT` | HTTP port when Socket Mode is disabled |
| `DEFAULT_BASE_CURRENCY` | Fallback currency (e.g. `USD`) |
| `LOG_LEVEL` | `debug` \| `info` \| `warn` \| `error` |

---

## Scripts

| Script | Purpose |
|---|---|
| `npm start` | Run the app |
| `npm run dev` | Run with file-watch hot reload |
| `npm run lint` | Lint with ESLint |
| `npm run format` | Format with Prettier |

---

## Architecture at a glance

```
Slack (mention / slash / action)
   → Bolt listener
      → Slack AI parse  →  RTS FX convert
      → Slack Datastore (ledger)
      → Splitwise MCP (if linked)
   → Block Kit confirmation
```

See the [PRD](./) for the full feature specification, user flows, and data model.

---

## License

MIT — see [LICENSE](./LICENSE).
