# ADR 0007: Text-and-web-first MVP scope

- **Status:** Accepted
- **Date:** 2026-10-10

## Context

Sofi currently has a working text-response pipeline through the internal AI Router and OpenRouter. The original product documents also mentioned image input, but the implementation does not support vision, multi-turn history is not persisted, web search is not implemented, and application-level aggregate spending controls are not enforced. The current delivery lifecycle can lose a generated reply if outbound Viber delivery fails after the database job is completed.

Before sharing Sofi with external users, the product needs a small, explicit scope and release gates that cover conversation continuity and operational safety.

## Decision

The first external MVP is a **text-first Viber assistant with bounded multi-turn context and web search**.

Before enabling external users, the MVP must also include:

- durable user/assistant turn history, context isolation, bounded history, and a documented retention/reset behavior;
- durable reply/delivery state and bounded recovery for transient failures;
- configurable `cheap_text` and `web` routes with tested route-compatible fallback behavior;
- application-level user/request limits, per-request cost guards, atomic budget reservation/reconciliation, and global spending ceilings covering model and search costs;
- runtime error reporting, sanitized operational logs, spend visibility, and minimal product analytics;
- verified provider/search privacy configuration, appropriate user disclosure, production end-to-end testing, and a documented disable/rollback procedure.

Images, audio, video, document processing, long-term personal memory, AI intent classification, extra infrastructure, and a custom admin dashboard are not part of this MVP. They may be reconsidered after the pilot based on evidence.

PostgreSQL remains the persistence and job foundation. New services such as Redis, separate workers, or a dedicated analytics platform are not introduced without a concrete need.

## Consequences

- The product and architecture documentation must describe text + web as the first-release scope; image input is future scope, not a launch promise.
- Multi-turn context, cost protection, and delivery recovery must be designed around shared persistence/lifecycle contracts to avoid overlapping implementations.
- Web-search model/tool behavior and privacy requirements must be verified before implementation and user traffic.
- External rollout is gated on the checklist in `docs/roadmap.md`, not merely on successful basic OpenRouter responses.
- Feature specifications must be created before implementing each work package.
