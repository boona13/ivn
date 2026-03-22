# IVN Knowledge Spec

Version: `1.0.0`

The IVN Knowledge Spec defines the portable JSON formats that make project memory shareable across tools, repositories, and runtimes.

## Goals

- Keep the format stable enough for external tools to implement.
- Preserve project-memory semantics: provenance, validity, visibility, review state, graph links.
- Allow forward evolution through explicit spec versioning.

## Artifacts

### Export

File: `ivn-export.schema.json`

Purpose: portable snapshot of knowledge entries plus graph edges.

Top-level fields:

- `spec`: fixed string `ivn-knowledge-export`
- `spec_version`: spec version, currently `1.0.0`
- `version`: IVN CLI version that produced the export
- `exported_at`: ISO timestamp
- `project`: project name
- `entries`: array of knowledge entries
- `edges`: array of graph edges

### Pack Manifest

File: `ivn-pack-manifest.schema.json`

Purpose: metadata wrapper for tracked knowledge packs.

Top-level fields:

- `spec`: fixed string `ivn-knowledge-pack-manifest`
- `spec_version`: spec version, currently `1.0.0`
- `version`: IVN CLI version that produced the pack
- `exported_at`: ISO timestamp
- `project`: project name
- `visibility`: `shared`, `private`, or `all`
- `count`: entry count
- `merge_strategy`: implementation hint for consumers
- `files`: stable filenames for pack artifacts

### HTTP OpenAPI

File: `ivn-service.openapi.json`

Purpose: machine-readable contract for HTTP service mode (`ivn serve --http`).

Primary surfaces:

- health and spec discovery
- read APIs for recall, focus, changed context, warnings, contradictions, and status
- write APIs for knowledge ingestion and graph links

## Knowledge Entry Contract

Required fields:

- `id`
- `type`
- `content`
- `summary`
- `tags`
- `file_refs`
- `source`
- `source_kind`
- `confidence`
- `valid_from`
- `visibility`
- `review_status`
- `created_at`
- `updated_at`
- `archived`

Optional / nullable fields:

- `source_ref`
- `valid_to`
- `reviewed_at`
- `review_note`

## Compatibility

- `1.x` readers must accept any `1.x` document.
- A reader may reject a document with a different major version.
- Legacy exports without `spec_version` may still be imported as pre-spec documents.

## Notes

- The local SQLite schema is an implementation detail. The spec is the portable contract.
- Rule files, MCP tools, and future HTTP adapters should map back to these same spec-level concepts.
