# IVN

**A persistent memory layer for LLM-assisted development.**

IVN gives your AI tools a project memory that survives across conversations. The LLM captures decisions, links reversals, surfaces contradictions, and maintains the knowledge graph — the developer approves. Knowledge flows into the context window automatically through generated rule files and MCP resources, so the model starts with project-specific context instead of a blank slate.

## Project Links

- GitHub: [`boona13/ivn`](https://github.com/boona13/ivn)
- Contributing: [`CONTRIBUTING.md`](CONTRIBUTING.md)
- Security policy: [`SECURITY.md`](SECURITY.md)
- Code of conduct: [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md)

## The Problem

Every AI conversation starts with amnesia. The LLM doesn't know why you chose PostgreSQL, what the Stripe webhook gotcha is, or what you spent 3 hours debugging last Tuesday. You re-explain everything. Every. Single. Time.

IVN solves this by making the LLM the primary operator of the project's knowledge base:

**Benchmarks now run on real repositories only.** The built-in benchmark targets `honojs/hono`, and both benchmark entrypoints can load additional real-repo scenarios from a manifest instead of generating synthetic projects. This repo now ships a checked-in OpenClaw scenario manifest at `benchmark/scenarios.openclaw.json`.

*The benchmark still measures critical-fact presence in the bundled pre-edit context — i.e., what fraction of project-specific facts are present before the model generates code. Higher context coverage is a necessary condition for better output, though downstream code quality still depends on the model and task. Run `npx tsx benchmark/run.ts` to evaluate the built-in real-OSS scenario, or pass `--manifest <file>` to benchmark your own real repositories.*

For answer-level validation, there is also a judged benchmark harness that exports portable task packs, runs an external model wrapper, and scores the returned answers against task rubrics.

| Built-in real repo | Without IVN | Repo scan | With IVN |
| --- | ---: | ---: | ---: |
| `honojs/hono` (`--hono-last 200`) | 20% | 52% | 100% |
| `openclaw/openclaw` (`benchmark/scenarios.openclaw.json`) | 25% | 25% | 100% |

The multi-year `honojs/hono` run (`--hono-since 2023-03-21`) reaches the same `100%` coverage on the bundled task set while importing a larger real history window. The checked-in OpenClaw scenario also reaches `100%` while importing the full relevant history window for `README.md`, `src/browser`, `src/memory`, `src/plugin-sdk`, and `src/context-engine`.

### Benchmark Methodology

- **Without IVN** = `README.md` plus the single file being edited for that task.
- **Repo scan baseline** = the same baseline plus a keyword-guided scan that opens the top matching repo files while excluding IVN-generated artifacts. This approximates a reasonable manual search pass.
- **With IVN** = the same baseline plus generated `KNOWLEDGE.md` and any matching `.cursor/rules/*.mdc` files after `ivn init`, `ivn git-import`, `ivn accept --all --force`, and `ivn sync-rules --target cursor,generic`.
- **Score** = the fraction of predefined critical facts whose substrings appear in that bundled context. This is a context-coverage metric, not a claim of guaranteed task success.
- **Scenarios** = the benchmark harness now runs on real repositories only. It ships with a built-in `honojs/hono` scenario and can load additional real-repo manifests.
- **Large repos** = `git-import` now supports `--path <paths...>` so monorepos can import the full relevant history for the parts of the repo you actually care about instead of forcing the entire commit firehose through one run.
- **Output** = the CLI now reports all three context bundles: `no ivn`, `repo scan`, and `with ivn`.
- **Details** = see [`benchmark/README.md`](benchmark/README.md). The harness can also write a machine-readable summary with `npx tsx benchmark/run.ts --report-json benchmark-report.json`.

## How It Works

The LLM is the primary operator. It captures, classifies, links, and curates. The developer bootstraps and approves.

```
  LLM conversation                        Developer sees knowledge
        │                                  in every AI context window
        ▼                                          ▲
  ivn_remember ──→ auto-classify ──→ auto-sync ──→ .cursor/rules/ivn-*.mdc
  ivn_link         (heuristic +       (instant)    KNOWLEDGE.md
  ivn_contradictions  local ML)                    Claude/Codex/Copilot rules
  ivn_stale                                        MCP resources
        │
        ▼
  Developer approves via ivn review / ivn accept
```

1. **Capture** — The LLM calls `ivn_remember` during conversations when decisions are made, bugs found, or patterns established. Git hooks and imports also feed knowledge in.
2. **Classify** — Local heuristics plus a local zero-shot model auto-detect type (decision/pattern/gotcha/debug), generate summaries and tags.
3. **Link** — The LLM calls `ivn_link(supersedes)` when it notices a decision reversal, building a graph of relationships.
4. **Auto-sync** — Every write triggers `sync-rules`, generating scoped AI rule files instantly.
5. **Inject** — When the LLM opens a file, Cursor/Claude/Copilot loads the matching rule file. The knowledge is already there.
6. **Curate** — The LLM calls `ivn_contradictions` to surface conflicts, `ivn_stale` to flag aged entries, and `ivn_infer` to suggest missing links. The developer confirms.
7. **Prevent** — `ivn check` validates code against known gotchas before commit.

## Install

```bash
# One-off
npx ivn --help

# Global
npm install -g ivn
```

Supported runtime: Node `18+`.

Operational notes:
- If `better-sqlite3` falls back to a source build on your platform, install the local build tooling required for native Node addons and rerun the install.
- IVN uses `better-sqlite3`, but release gating now smoke-tests the packed CLI on `macOS`, `Linux`, and `Windows` across Node `18`, `20`, and `22` with source builds disabled.
- Outside that supported install matrix, native binary availability can still vary by OS, architecture, and Node ABI.
- The local dashboard binds to `127.0.0.1` and issues a session token for its API.
- `ivn serve --http` now requires an auth token for writes and any private-visibility reads. The CLI prints the token when the service starts.
- Conversation-derived captures default to the `private` lane until you explicitly promote or share them.
- Auto-classified writes use a local zero-shot model when the optional ML package is available. On first use, IVN caches the model locally, then falls back to heuristics if the ML package is unavailable, disabled, or model loading fails. This applies to `ivn remember` when `--type` is omitted, plus `git-import` and conversation-derived captures.
- Reference integration snippets live in [`examples/`](examples/README.md) in this repo and in the published npm package.

## Step-by-Step Guide

### Step 1 — Initialize IVN in your project

```bash
cd my-project
ivn init
```

This creates an `.ivn/` directory containing:

```
.ivn/
├── knowledge.db    # SQLite database (FTS5, WAL mode)
└── config.json     # Project metadata + schema version
```

Everything is local. No accounts, no cloud, no telemetry.

### Step 2 — Bootstrap existing knowledge

Seed the knowledge base so the LLM has context from day one.

**Import from git history** (extracts decisions, patterns, and gotchas from past commits):

```bash
ivn git-import
```

For large monorepos, scope the import to the areas you actually want bundled into context:

```bash
ivn git-import --since 2025-11-24 --path README.md src/browser src/memory src/plugin-sdk src/context-engine
```

`git-import` is intentionally conservative on vague histories: commits with clear subjects or explanatory bodies import best, while squash-heavy or "cleanup/update" style commits may stay in the noise bucket unless the body adds durable detail.

**Manually capture things the LLM needs to know** (architecture decisions, known gotchas, conventions):

```bash
ivn remember "We chose PostgreSQL over MySQL for JSONB support and row-level security"
ivn remember "The Stripe webhook endpoint has a 30-second timeout — always respond with 200 before processing"
ivn remember "All API routes must go through the auth middleware in src/middleware/auth.ts"
```

Type, tags, and summary are auto-classified. You can override with `--type gotcha`, `--tags stripe,webhook`, etc.

**Import from past AI transcripts** (if you have saved conversation logs):

```bash
ivn import-chat ./session.jsonl
```

**Promote imported entries to active memory:**

Git-imported and conversation-imported entries start in a `pending` queue. Promote them so the LLM can see them:

```bash
ivn review                # Browse pending entries
ivn accept --all --force  # Promote everything (or accept individually)
```

### Step 3 — Connect your AI tool

IVN supports two integration paths:

- **MCP (Model Context Protocol)** — real-time, bidirectional. The LLM reads *and writes* knowledge during conversations. Available for tools that support MCP servers.
- **Auto-synced rule files** — one-directional. IVN generates instruction files that the LLM reads automatically when opening files. Works with any AI tool.

Both paths can run simultaneously. Set up the one that matches your tool.

#### Cursor (MCP + rule files)

Add to `.cursor/mcp.json` (project-level) or `~/.cursor/mcp.json` (global):

```json
{
  "mcpServers": {
    "ivn": { "command": "ivn", "args": ["serve"] }
  }
}
```

Restart Cursor. IVN's MCP system prompt instructs the LLM to load context, capture decisions, link reversals, and surface contradictions automatically.

Rule files are also auto-synced to `.cursor/rules/`:

```
.cursor/rules/
├── ivn-knowledge.mdc   # Always-apply: all decisions, patterns, gotchas
├── ivn-api.mdc         # Activates when editing src/app/api/**
├── ivn-billing.mdc     # Activates when editing **/stripe/**, **/billing/**
├── ivn-database.mdc    # Activates when editing **/prisma/**, **/db/**
└── ...                 # One rule per knowledge topic
```

#### Claude Code (MCP + rule files)

```bash
claude mcp add ivn -- ivn serve
```

Or add to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "ivn": { "command": "ivn", "args": ["serve"] }
  }
}
```

IVN also auto-syncs a managed knowledge block into `CLAUDE.md` whenever knowledge changes.

#### Codex (rule files)

Codex reads `AGENTS.md`, which IVN auto-syncs:

```bash
ivn sync-rules --target codex
```

No MCP config needed — knowledge flows through the file.

#### GitHub Copilot (rule files)

Copilot reads `.github/copilot-instructions.md`, which IVN auto-syncs:

```bash
ivn sync-rules --target copilot
```

#### Windsurf (rule files)

Windsurf reads `.windsurfrules`, which IVN auto-syncs:

```bash
ivn sync-rules --target windsurf
```

#### Cline (rule files)

Cline reads `.clinerules`, which IVN auto-syncs:

```bash
ivn sync-rules --target cline
```

#### Any other AI tool (generic)

Point your agent at the auto-generated `KNOWLEDGE.md` file, or pipe context directly:

```bash
ivn context            # Dump all knowledge as AI-ready markdown
ivn context "auth"     # Dump knowledge matching a query
ivn focus src/api.ts   # Dump knowledge relevant to a specific file
```

### Step 4 — Generate rule files

```bash
ivn sync-rules
```

IVN auto-detects which AI tools are present (`.cursor/` directory, `CLAUDE.md`, `.github/`, etc.) and generates scoped rule files for each. To force-generate for every supported tool:

```bash
ivn sync-rules --target all
```

Rule files are regenerated automatically on every `ivn remember`, `ivn accept`, and `ivn git-import`. You rarely need to run this manually after initial setup.

### Step 5 — Install git hooks

```bash
ivn hook install --pre-commit
```

This installs two hooks:

- **pre-commit** — runs `ivn check` to validate staged files against known gotchas. Blocks the commit if violations are found.
- **post-commit** — auto-captures knowledge from the commit message and re-syncs rule files.

### Step 6 — Day-to-day workflow

Once set up, the LLM handles knowledge management during normal conversations. Here is what a typical session looks like:

**1. LLM loads context at conversation start**

The MCP system prompt instructs the LLM to call `ivn_context` (or read the passive `ivn://context` resource) at the beginning of every conversation. It also reads `ivn://changed` for files in the current diff and `ivn://warnings` for active gotchas.

**2. LLM captures knowledge as it emerges**

When you make a decision, find a bug, or establish a pattern, the LLM calls `ivn_remember`:

> *You:* "Let's switch from REST to GraphQL for the mobile API."
>
> *LLM calls:* `ivn_remember("Switched mobile API from REST to GraphQL for reduced payload size and flexible field selection", type: "decision", tags: ["api", "graphql", "mobile"])`

**3. LLM links reversals**

When a new decision contradicts an earlier one, the LLM calls `ivn_link` with `supersedes`:

> *LLM calls:* `ivn_link(new_id, old_rest_decision_id, "supersedes")`

This builds the knowledge graph and allows contradiction detection.

**4. LLM checks before editing**

Before modifying a file, the LLM calls `ivn_warn` or `ivn_focus` to surface relevant gotchas and constraints:

> *LLM calls:* `ivn_warn(files: ["src/api/mobile.ts"])`
>
> *IVN returns:* "The Stripe webhook endpoint has a 30-second timeout — always respond with 200 before processing"

**5. LLM surfaces stale knowledge and contradictions**

The LLM periodically calls `ivn_stale` to flag knowledge older than 90 days, and `ivn_contradictions` when guidance looks inconsistent. You confirm or dismiss.

### Step 7 — Review and approve

Auto-captured knowledge (from git hooks, MCP, conversation imports) enters a `pending` queue. Nothing reaches active memory without your approval.

```bash
ivn review              # View the pending queue
ivn accept <id>         # Approve a single entry into active memory
ivn accept --all --force # Bulk-approve all pending entries after review
ivn reject <id>         # Reject an entry
ivn refresh <id>        # Re-confirm that existing knowledge is still valid
ivn diff                # Review recent changes to the knowledge base
```

### Step 8 — Explore the knowledge graph

**Search:**

```bash
ivn recall "stripe webhook"       # Full-text BM25 search
ivn status                        # Visual overview: counts, types, staleness
```

**Traverse relationships:**

```bash
ivn link a1b2c3d4 e5f6g7h8 --type caused_by   # Create a link
ivn trace a1b2c3d4                              # Walk all connections
ivn why a1b2c3d4                                # Walk upstream causes
ivn impact a1b2c3d4                             # Walk downstream effects
```

**Maintenance:**

```bash
ivn stale                  # Find knowledge needing re-confirmation (90+ days)
ivn contradictions         # Find conflicting active truths
ivn infer                  # Suggest missing graph links
```

### Step 9 — HTTP API and web dashboard

**Local REST API** (for CI pipelines, external scripts, or custom integrations):

```bash
ivn serve --http
```

The CLI prints an auth token on startup. Use it for writes and private reads:

```bash
TOKEN="<printed by ivn serve --http>"

curl -X POST http://127.0.0.1:3103/v1/knowledge \
  -H "Content-Type: application/json" \
  -H "X-Ivn-Token: $TOKEN" \
  -d '{"content":"Stripe webhook handlers must stay on Node.js runtime","type":"gotcha"}'
```

**Local web dashboard** (card view + knowledge graph visualization):

```bash
ivn web
```

### Step 10 — Export, import, and sharing

```bash
ivn export                         # Portable JSON + Markdown bundles
ivn import <file>                  # Merge external knowledge
ivn import-chat <file>             # Extract knowledge from AI transcripts
ivn import-chat <file> --shared    # Import directly into the shared lane
ivn pack sync                      # Materialize a git-tracked knowledge pack
```

## MCP Tools (LLM Interface)

IVN exposes 14 tools and 4 passive resources via the Model Context Protocol. The MCP system prompt instructs the LLM to use these proactively during conversations:

| Tool | What the LLM does with it |
|------|---------------------------|
| `ivn_remember` | Store a decision, gotcha, pattern, or bug as it emerges in conversation |
| `ivn_recall` | Search project knowledge before starting work on a topic |
| `ivn_focus` | Load knowledge relevant to a specific file before editing it |
| `ivn_warn` | Surface gotchas and constraints before making changes |
| `ivn_link` | Connect related entries — especially `supersedes` when a decision is reversed |
| `ivn_contradictions` | Detect conflicting active truths (superseded entries, polarity conflicts) |
| `ivn_stale` | Flag knowledge that hasn't been confirmed in 90+ days |
| `ivn_infer` | Suggest missing graph links based on shared files, tags, and terms |
| `ivn_changed` | Load context for files in the current git diff |
| `ivn_context` | Load the full project knowledge dump at conversation start |
| `ivn_capture_suggest` | Analyze recent conversation turns and suggest durable captures |
| `ivn_capture_confirm` | Store user-approved captures from the suggestion flow |
| `ivn_log` | List recent knowledge entries |
| `ivn_status` | Get knowledge graph statistics |

4 passive MCP resources (`ivn://context`, `ivn://changed`, `ivn://warnings`, `ivn://review/pending`) provide live context that the LLM reads at conversation start without explicit tool calls.

### Auto-synced Rule Files

`ivn sync-rules` generates scoped instruction files for Cursor (`.mdc`), Claude Code, Codex, Copilot, Windsurf, Cline, and a generic `KNOWLEDGE.md`. Auto-runs on every knowledge write when an AI tool directory is detected.

## CLI Commands (Developer Interface)

The CLI is for bootstrapping, oversight, and operations that don't happen inside an AI conversation.

| Command | What it does |
|---------|-------------|
| `ivn init` | Initialize `.ivn/` in the current directory |
| `ivn remember <content>` | Store knowledge directly (auto-classifies type, tags, summary) |
| `ivn recall <query>` | Search with full-text BM25 ranking |
| `ivn context [query]` | Export AI-ready markdown context |
| `ivn check` | Validate files against known gotchas and patterns |
| `ivn sync-rules` | Generate scoped AI rule files for all detected tools |
| `ivn status` | Visual overview of the knowledge graph |

### Review Workflow

Auto-captured knowledge (from git, MCP, conversation imports) enters a `pending` queue. The developer approves what becomes active memory.

```bash
ivn review          # View pending queue
ivn accept <id>     # Approve into active memory
ivn reject <id>     # Reject
ivn refresh <id>    # Re-confirm still-valid knowledge
ivn diff            # Review recent changes
```

### Active Prevention

```bash
ivn check --changed          # Validate files in current git diff against known gotchas
ivn check --file src/api.ts  # Validate a specific file
ivn hook install --pre-commit # Block commits that violate known gotchas
```

### Knowledge Graph

```bash
ivn link a1b2c3d4 e5f6g7h8 --type caused_by
ivn trace a1b2c3d4       # Traverse the graph
ivn why a1b2c3d4          # Walk upstream causes
ivn impact a1b2c3d4       # Walk downstream effects
```

### Working Set

```bash
ivn changed                  # Knowledge for files in the current git diff
ivn warn --file src/auth.ts  # Surface gotchas before editing
ivn stale                    # Find knowledge needing re-confirmation
ivn contradictions           # Find conflicting active truths
ivn infer                    # Suggest missing graph links
```

### Import & Sharing

```bash
ivn git-import          # Extract knowledge from commit history
ivn hook install        # Auto-capture + auto-sync on every commit
ivn export              # Portable JSON + Markdown bundles
ivn import <file>       # Merge external knowledge
ivn import-chat <file>  # Extract knowledge from AI transcripts
ivn pack sync           # Git-tracked knowledge pack
```

### HTTP & Web

```bash
ivn serve --http    # REST API: shared reads by default; writes/private reads require the printed auth token
ivn web             # Local dashboard with card + graph views
```

Conversation imports are conservative by default: `ivn import-chat` stores captured transcript knowledge in the private lane unless you explicitly opt into shared visibility.

Auto-classifier controls:
- `IVN_DISABLE_ML_IMPORTS=1` forces pure heuristic import classification.
- `IVN_ALLOW_REMOTE_MODELS=0` prevents model downloads and falls back to heuristics unless the model is already cached locally.
- `IVN_IMPORT_CLASSIFIER_MODEL=<model>` overrides the zero-shot model used for import classification.
- `IVN_MODEL_CACHE_DIR=<path>` changes where local model files are cached.

Example HTTP write with auth:

```bash
TOKEN="<printed by ivn serve --http>"

curl -X POST http://127.0.0.1:3103/v1/knowledge \
  -H "Content-Type: application/json" \
  -H "X-Ivn-Token: $TOKEN" \
  -d '{"content":"Stripe webhook handlers must stay on Node.js runtime","type":"gotcha"}'
```

Example transcript import into the shared lane:

```bash
ivn import-chat ./session.jsonl --shared
```

## Architecture

```
.ivn/
├── knowledge.db    # SQLite with FTS5, WAL mode
└── config.json     # Project metadata + schema version

.cursor/rules/
├── ivn-knowledge.mdc   # Always-apply global rules
├── ivn-api.mdc         # Scoped: activates for API files
├── ivn-billing.mdc     # Scoped: activates for billing files
└── ...                 # One rule per knowledge topic
```

**Storage:** SQLite with WAL mode. FTS5 full-text search with BM25 ranking. Versioned schema migrations.

**Data model:** 7 knowledge types (decision, pattern, gotcha, debug, context, dependency, todo) connected by 5 edge types. Entries carry provenance, validity windows, visibility (shared/private), and review status.

**Auto-sync:** Every `remember`, `accept`, and `git-import` triggers rule regeneration. Scoped rules use tag-to-glob mapping so knowledge activates for relevant files only. Custom mappings can be added via `tag_globs` in `.ivn/config.json`.

**Active prevention:** `ivn check` extracts anti-patterns from gotchas (e.g., "never use Edge runtime" → detects `runtime = 'edge'`) and blocks commits via pre-commit hook.

**Heuristics:** Local scoring-based classification, auto-summarization, tag extraction. No external API calls.

**Dependencies:** 4 required runtime — `commander`, `better-sqlite3`, `chalk`, `@modelcontextprotocol/sdk`; plus optional local ML acceleration via `@huggingface/transformers`.

**Production defaults:** Shared knowledge is the default public surface for HTTP and MCP reads. Private knowledge requires explicit visibility selection plus an auth token outside the local CLI flow.

## Design Principles

1. **LLM-operated, human-approved** — The LLM captures, links, and curates knowledge. The developer reviews and approves. Curation is not a human chore — it's the LLM's job.
2. **Active, not passive** — In the common path, knowledge flows to the LLM automatically instead of relying on manual queries.
3. **Local-first** — Your data never leaves your machine. No cloud, no accounts, no telemetry.
4. **Universal** — Works with any AI tool via rule files, MCP, or plain `ivn context`.
5. **Safe by default** — Auto-captured knowledge enters a pending queue. Unreviewed capture cannot become active memory until a human promotes it. The main failure mode is missing or stale approved knowledge, not silent auto-promotion.
6. **Lean** — 4 dependencies. Sub-second response times.

## Development

```bash
npm run check     # lint + typecheck + test
npm run build     # compile TypeScript
npm test          # run test suite
npm run format    # apply Biome formatting
npm run release:check           # verify publish-ready artifacts and version alignment
npm pack --dry-run              # preview shipped tarball contents
npx tsx benchmark/run.ts              # run built-in real-repo benchmarks
npx tsx benchmark/run.ts --hono-since 2023-03-21  # run the hono benchmark over a multi-year history window
npx tsx benchmark/run.ts --manifest benchmark/scenarios.example.json  # add your own real-repo scenarios
npx tsx benchmark/run.ts --report-json benchmark-report.json  # save a machine-readable benchmark summary
npx tsx benchmark/judged.ts --emit-dir benchmark-cases  # export judged task packs for real repos
npx tsx benchmark/judged.ts --answer-command "<your model wrapper>" --manifest benchmark/scenarios.example.json --report-json judged-report.json  # score judged answers
```

Upgrade note: schema upgrades are automatic on open. For important environments, run `ivn backup` before upgrading the CLI so you have a local recovery snapshot of `.ivn/knowledge.db`.

## Project Health

- Contributions: see [`CONTRIBUTING.md`](CONTRIBUTING.md)
- Security reporting: see [`SECURITY.md`](SECURITY.md)
- Community expectations: see [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md)

## License

[MIT](LICENSE)
