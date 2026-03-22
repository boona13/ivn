# IVN — Development Phases

> Tracking the evolution from prototype toward the north star: zero-query knowledge delivery for AI-assisted development.

---

## Phase 1: Core Foundation ✅

The working prototype — CLI, storage, search, knowledge graph, and MCP integration.

- [x] TypeScript ESM scaffolding, SQLite with WAL mode, FTS5 full-text search
- [x] 7 knowledge types with heuristic auto-classification
- [x] CLI: `init`, `remember`, `recall`, `log`, `get`, `forget`, `status`, `context`, `focus`
- [x] Knowledge graph: `link`, `trace`, `why`, `impact` with typed edges
- [x] MCP server: 14 tools + 4 passive resources for Cursor/Claude/Copilot
- [x] Git integration: `git-import`, `hook install`, conventional commit parsing
- [x] Duplicate detection, auto-summarization, smart tagging
- [x] Schema migrations, `doctor` health check, `backup` recovery snapshots

---

## Phase 2: Trust & Review ✅

Make auto-captured knowledge reviewable before it becomes shared truth.

- [x] Append-only event log (`knowledge_events`) for reviewable change feeds
- [x] Review workflow: `review`, `accept`, `reject`, `refresh`
- [x] `diff` with terminal, JSON, markdown, and PR-summary output modes
- [x] `history` and `snapshot` for temporal knowledge inspection
- [x] Private vs shared visibility lanes
- [x] Provenance metadata: `source_kind`, `source_ref`, confidence, validity windows
- [x] Git-tracked knowledge packs: `pack sync`, `pack merge`

---

## Phase 3: Adaptive Context ✅

Make retrieval context-aware, not just searchable.

- [x] File-aware recall via stored `file_refs` and `focus` command
- [x] Git-diff aware context via `changed` command
- [x] Freshness decay: boost recently reviewed knowledge, demote stale entries
- [x] Proactive warnings: `warn` surfaces gotchas before edits
- [x] Contradiction detection between active truths
- [x] Inference engine for suggesting missing graph links
- [x] Conversation indexing: `import-chat` for AI transcript extraction
- [x] Live conversation capture: `capture_suggest` / `capture_confirm` MCP tools

---

## Phase 4: Ecosystem ✅

Multi-tool integration and portable knowledge formats.

- [x] Rule sync adapters: Cursor, Claude Code, Codex, Copilot, Windsurf, Cline, generic
- [x] Export/import with JSON and markdown formats
- [x] HTTP service mode with OpenAPI spec
- [x] Web dashboard with card and graph views
- [x] Knowledge templates: `init --template nextjs|express|django`

---

## Phase 5: Active Injection ✅

The architectural pivot — from passive retrieval to zero-query knowledge delivery.

- [x] Auto-sync: every `remember`, `accept`, and `git-import` triggers rule regeneration
- [x] Per-topic scoped Cursor rules with glob-based activation (`ivn-api.mdc`, `ivn-billing.mdc`, etc.)
- [x] Tag-to-glob mapping: knowledge tags automatically route to the right files (configurable via `tag_globs` in project config)
- [x] `debug` type entries included in sync output (past bugs prevent regressions)
- [x] `ivn check`: validate source files against known gotchas and patterns
- [x] Pre-commit hook: `ivn hook install --pre-commit` blocks commits violating gotchas
- [x] Post-commit hook auto-syncs AI rules after every commit
- [x] Benchmark: benchmark entrypoints now target real repositories only (built-in `honojs/hono`, checked-in `openclaw/openclaw` manifest, plus manifest-driven real-repo scenarios)
- [x] Judged benchmark harness: export portable answer cases, run an external model wrapper, and score answer grounding against task rubrics

---

## Phase 6: Hardening 🔲

**Status: NEXT**

Make the active injection loop reliable enough for daily production use.

- [ ] Git-import tuning: extract richer knowledge from squash-heavy commit histories (e.g. extract file_refs from diff stats for better scoped rule targeting)
- [ ] Classifier tuning with real-world corpus (not just heuristics)
- [ ] Embeddings-based semantic matching for better duplicate detection and file routing
- [ ] Integration tests for MCP tool round-trips
- [ ] Performance benchmarks for stores with 500+ entries
- [ ] Error recovery for corrupted FTS index
- [ ] `ivn doctor --fix` for automated repair

---

## Phase 7: Distribution 🔲

**Status: IN PROGRESS**

- [ ] Publish to npm: `npm install -g ivn`
- [x] CI/CD release pipeline with provenance
- [ ] VS Code extension: sidebar panel for knowledge management
- [ ] GitHub Action: auto-capture from CI/CD events
- [ ] Plugin system for community adapters

---

## North Star

IVN aims to become a standard layer between developers and their AI tools — like Git sits between developers and their code. Project knowledge should be portable, persistent, reviewable, and temporal. Local-first. No SaaS.
