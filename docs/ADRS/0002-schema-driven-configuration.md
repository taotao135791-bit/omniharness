# ADR-0002: Schema-driven configuration

Status: Accepted (2026-07-23)

## Context

Config validation, CLI flags, TUI forms, GUI pages, defaults, docs and migrations
drift when implemented four times.

## Decision

One `FieldDef[]` schema in `packages/config-schema` (`SETTINGS_SCHEMA`). Validation,
defaults, CLI parsing, form metadata and Markdown docs are generated from it.
Plugin manifests, model capabilities, skills and automations have structural
validators in the same package. No hand-maintained parallel config code anywhere.

## Consequences

- Adding a setting = adding one FieldDef; all surfaces update.
- The field system is intentionally small (6 types); exotic config uses `json` fields.
