---
'@nestvexa/live': patch
---

Reject conflicting Live registrations consistently across Express and Fastify. Route mounts to the owning registration, retain request context across modules, and reject work after shutdown. Renderer initialization and disposal remain explicitly host-owned.
