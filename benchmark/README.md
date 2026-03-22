# Benchmark Methodology

The benchmark answers one narrow question on real repositories:

**Before the model writes code, how much task-relevant project knowledge is already present in the bundled context?**

For answer-level evaluation, this repo now also includes a judged harness that exports benchmark cases, runs an external model wrapper, and scores the returned answers against task rubrics.

## Metric

- **Name:** critical-fact presence
- **Unit:** percentage of predefined critical facts found in the bundled context for each task
- **Matcher:** case-insensitive substring match
- **What it does not measure:** model reasoning quality, end-to-end task success, latency, or the value of manual repo exploration

## Context Definitions

### Without IVN

- `README.md`
- The single file being edited for the task

### Repo Scan Baseline

- The same baseline as above
- Up to five additional repo files selected by keyword overlap with the task title, edited path, and predefined critical facts
- IVN-generated artifacts are excluded from this scan (`.ivn/`, generated rule files, generated knowledge files)

### With IVN

- The same baseline as above
- Generated `KNOWLEDGE.md`
- Matching `.cursor/rules/*.mdc` files for that task's edited file

For the generated context path, the harness runs:

```bash
ivn init
ivn git-import
ivn accept --all --force
ivn sync-rules --target cursor,generic
```

## Scenarios

- **Built-in:** `honojs/hono`, imported directly from git history
- **Checked-in manifest:** `benchmark/scenarios.openclaw.json` for `openclaw/openclaw`
- **User-supplied:** additional real repositories loaded from `--manifest <file>`

## Reproducibility

```bash
npx tsx benchmark/run.ts
npx tsx benchmark/run.ts --hono-since 2023-03-21
npx tsx benchmark/run.ts --manifest benchmark/scenarios.openclaw.json --scenario openclaw-full
npx tsx benchmark/run.ts --manifest benchmark/scenarios.example.json
npx tsx benchmark/run.ts --report-json benchmark-report.json
```

## Judged Answer Harness

Use the judged harness when you want to test whether stronger context produces better task answers, not just better pre-edit coverage.

```bash
npx tsx benchmark/judged.ts --emit-dir benchmark-cases
npx tsx benchmark/judged.ts --answer-command "node scripts/benchmark-answer-fixture.mjs"
npx tsx benchmark/judged.ts --answer-command "<your model wrapper>" --manifest benchmark/scenarios.example.json --report-json judged-report.json
```

The answer command receives:

- `IVN_BENCH_CASE_FILE` — JSON case payload with task, rubric, prompt, and context
- `IVN_BENCH_PROMPT_FILE` — full prompt text
- `IVN_BENCH_CONTEXT_FILE` — raw bundled context
- `IVN_BENCH_OUTPUT_FILE` — optional file path if your wrapper prefers writing instead of stdout

Judging rules:

- Each task has required repo-specific facts derived from the benchmark checklist
- Some tasks add `any-of` groups so equivalent phrasing can still pass
- Some tasks add forbidden contradictory phrases to catch grounded-but-wrong answers
- Pass/fail is judged at the answer level rather than the bundled-context level

Useful flags:

- `--hono-last <n>` limits the OSS scenario to the most recent commits
- `--hono-since <date>` imports a multi-year history window
- `--manifest <path>` adds more real-repo scenarios
- `--report-json <path>` writes a machine-readable summary of all scenario results
- `IVN_BENCH_COMMAND="<custom ivn wrapper>"` overrides the default repo-local CLI used by the benchmark harnesses
- Manifest scenarios can also declare `importPaths` to scope `git-import` to the relevant parts of very large repositories

Manifest shape:

```json
[
  {
    "key": "ivn-local",
    "name": "IVN (local repo)",
    "localPath": "..",
    "importLast": 200,
    "importPaths": ["src", "README.md"],
    "tasks": [
      {
        "id": 1,
        "title": "Audit git-import provenance handling",
        "fileBeingEdited": "src/git.ts",
        "criticalFacts": ["source_ref", "git-import", "vague histories"]
      }
    ]
  }
]
```

## Reading The Results

- A high score means the benchmark's predefined facts are already present in the context bundle before code generation.
- The repo-scan baseline estimates what happens if a developer does a quick manual keyword search and opens a few likely files.
- A low score means the model would need more repo exploration, search, or conversation history to recover those facts.
- A perfect score means all benchmark facts for that task were present in the bundled context. It does **not** mean the model will always solve the task correctly.
