# Model manifest

The [bundled manifest](../../apps/server/src/provider/model-manifest.json) allows
offline startup; fetching it from `main` lets model metadata change between
releases. Failed fetches or invalid data preserve the last usable manifest.
Remote data must pass both catalog-reference validation and the owning provider's
adapter validation before replacing the cache.

A newer bundle outranks the cached remote manifest by `updatedAt`, so a release can
correct model data before the next successful fetch. Bump `updatedAt` whenever the
file changes. Fetch time cannot establish which copy contains the newer edit.

Generic catalog data describes presentation and capabilities. Each provider owns
its adapter schema and dispatch mappings. Claude uses the manifest for its entire
built-in catalog. Adding a model with an existing capability profile is a JSON
edit; a new profile is needed only for a new capability combination. Codex still
gets its model list from its app server.

`currentModels.claudeAgent` is the current-model classification overlay for
releases that predate catalog discovery; it does not add models to their catalogs.
Catalog-aware releases use `providers.claudeAgent.models[].status` instead.
Codex uses `currentModels.codex` as a legacy-classification overlay for discovered
models.

`compatibility` declares which CLI versions a provider is known to work with. An
entry that has no characterized version must say so with `"uncharacterized": true`
and an empty `ranges`, which the schema requires and which suppresses the
advisory entirely. An empty `ranges` list without the marker does not: it resolves
to a permanent `unknown` advisory, which satisfies the "every built-in has a
policy" test while warning about nothing. Freebuff is the current example — its
TUI bridge is a screen-scraping integration whose behaviour has not been pinned to
version ranges.

Model data is schema-validated configuration. Tests should cover resolver, cache,
and adapter semantics with synthetic model names, so adding a model never requires
tests that repeat the configuration.
