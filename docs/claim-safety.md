# Task claim safety — design investigation

Status: **not implemented; autonomous execution is disabled**. This is a proposed design and test plan, not evidence that Appwrite provides the required behavior.

## Requirements

Only one authorized worker may hold an active claim for an eligible task. A concurrent hold must prevent a new execution, and a stale worker must not be able to complete or perform effects after ownership changes. State transitions and audit records need consistent persistence. An ambiguous response must not cause a second claim or untracked work.

## What the documentation establishes

The current [Appwrite transaction guide](https://appwrite.io/docs/products/databases/tablesdb/transactions) describes staging database operations and committing them atomically, including conflict detection for rows changed outside a transaction. Schema operations are excluded. It does not by itself establish that a task eligibility read performed before staging is protected from intervening updates. It is current documentation, not a version-pinned specification for the self-hosted 2.6.2 server.

The [2.6.2 release notes](https://github.com/appwrite/appwrite/releases/tag/2.6.2) describe transaction-related permission hardening and a difference from later transaction models. The previously observed 2.7.1 SDK / 2.6.2 server mismatch requires compatibility testing; do not assume current SDK examples work unchanged.

## Candidate, not yet accepted

Route all task mutations through a trusted service. A create-only claim record with a deterministic task-derived identity may provide one contention point; transactional creation and audit writes may make ownership and history consistent. Duplicate creation or conflicts must be interpreted as failure, not proof of ownership. This proposal still needs a proven atomic eligibility/hold boundary: a unique record alone does not prevent a hold from racing a claim. Do not implement it as a client-side read followed by an unconditional update.

On an ambiguous commit response, reconcile using a unique request identity before retrying. Reassignment requires fencing: expiry alone cannot stop a previous worker from acting. Downstream effects also need their own idempotency or fencing.

## Acceptance tests before enabling execution

Run these against the actual authorized non-production server and applicable credentials, not just mocks:

- Concurrent claim attempts for the same task, repeated under contention: at most one succeeds.
- Eligibility change or hold races with acquisition: no execution may start after the effective hold; verify both interleavings.
- Duplicate creation and transaction rollback, including history consistency.
- Lost or ambiguous commit response, retry, and authoritative reconciliation.
- Expiry, reassignment, stale heartbeat/completion, and downstream side-effect fencing.
- Authentication, authorization, permissions and direct-write bypass attempts.
- Actual self-hosted 2.6.2 behavior, errors, API/SDK compatibility, and configured limits.

Until these gates pass, task rules in `src/task.js` are domain logic only, not an authorization boundary or safe claim mechanism.
