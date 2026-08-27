# Security documentation

[`SECURITY.md`](SECURITY.md) contains the active security model and operational
guidance.

Point-in-time implementation verification was removed because it became stale
as soon as code and infrastructure changed. Security claims must be enforced by
tests, CI, reviewed deployment configuration, and the current production smoke;
open work belongs only in `docs/operations/todo.md`.
