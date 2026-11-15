# Weftline

Weftline is an early-stage shared work board and knowledge system for people and agents.

## Current prototype

This repository includes an experimental personal human task list backed by a dedicated Appwrite development project. Its experimental task handler implements owner-scoped task creation and listing, but the HTTP board and sign-in are currently unavailable; it is not a shared board, production service, or agent integration. Agent execution stays disabled. Claims, holds, fencing, audit history, recovery, and task transitions are not implemented in the persistence path. Do not use it to dispatch real work or enforce security.

The HTTP server deliberately returns 503 for board data and task routes even when configured, and login POST is disabled. Logout remains available for existing sessions when configuration is valid: it attempts upstream revocation and only clears the secure cookie after confirmed success. This implementation is not yet verified against a real Appwrite session; failure returns 503 without claiming revocation. Login abuse controls remain unverified, so do not expose or use the board. A previous worker reported a real two-user row-isolation test, but independent reproduction and evidence are outstanding. Row security is a required deployment prerequisite, not established by local tests.

The server defaults to `HOST=127.0.0.1`; an explicit `HOST=0.0.0.0` can support a separate proxy container but exposes the listener on all container interfaces. The server does not terminate TLS. A trusted, access-controlled HTTPS reverse proxy and network isolation are required; no proxy, deployment, TLS boundary or public route has been verified here. Origin checking is not a replacement for network isolation or trusted proxy configuration. Login requires a client-scoped, effectively rate-limited flow that actually supplies a usable session securely, tested against the actual Appwrite version and proxy topology. Distributed and multi-replica abuse protection cannot be assumed from a per-process IP counter. The server-key login was disabled rather than treating Appwrite client limits as effective.

The current internal handler displays only the first page and warns that additional tasks may be missing; pagination is not implemented. Independent review of the exact final candidate remains required. No agent execution is enabled.

Run the tests with Node.js 22 or newer:

```sh
node --test
```

The rule models `ready → in_progress → review → done` with a `blocked` state. A held task cannot enter `in_progress`. These initial domain rules are subject to review and are not a substitute for server-side authorization or concurrency control.

## Next milestones

- Review and harden the authenticated Appwrite development integration before any exposure.
- Design and test atomic claims, holds, audit history, and recovery against the real persistence boundary before enabling any workers.
- Extend the personal list into a shared human board and permission-aware documents. Public indexing is undecided.

Do not deploy, expose services, migrate data, or retire VaultBridge without separate authorization and validation.
