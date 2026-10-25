---
name: Feature request
about: Suggest an improvement that fits the local-only workbench scope
labels: ['enhancement']
---

**Problem to solve:** what task are you trying to do?

**Proposed behaviour:** what should RowLens do, concretely?

**Scope check:** RowLens is deliberately small (local-only, no accounts/AI/
telemetry/DB connections — see `docs/00-product-brief.md` non-goals). How does
this fit, and what simpler alternative did you consider?

**Data-correctness impact:** would this change parsing, cleaning or export
behaviour? `docs/03-data-processing-contracts.md` would need a matching update.
