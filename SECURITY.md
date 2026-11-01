# Security Notes

- API tokens are encrypted in the Electron main process with `safeStorage`; renderer code never receives the stored token.
- Do not commit tokens, userData files, SQLite files, or local logs.
- The renderer uses context isolation, sandboxing, disabled Node integration, and a restrictive Content Security Policy.
- The app only calls the documented HUMKT HTTPS API endpoints.
- Auto-buy is disabled by default and requires an explicit risk acknowledgement.
- An ambiguous order result is locked for manual reconciliation; no automatic retry is allowed for the non-idempotent product order endpoint.
