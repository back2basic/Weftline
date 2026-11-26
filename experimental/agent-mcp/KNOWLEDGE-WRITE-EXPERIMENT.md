# Experimental MCP knowledge writes

This is separately opt-in from task writes and knowledge reads. It requires the listener setting `WEFTLINE_REVIEW_KNOWLEDGE_AGENT_SCOPED_WRITE=1`, versioned knowledge composition (`WEFTLINE_REVIEW_KNOWLEDGE_VERSIONED=1`), and a trusted HTTPS ingress, CA, local runtime and owner-only journal directory. It is experimental; synthetic provider tests do not establish real provider permissions, deployed ingress, database isolation or capacity.

Append this complete option group to the existing MCP server arguments:

```
--enable-knowledge-write --knowledge-journal /absolute/private/empty/directory \
--knowledge-write-endpoint https://provider.example.test/v1 \
--knowledge-write-project PROJECT --knowledge-write-database DATABASE \
--knowledge-write-table TABLE --knowledge-write-team TEAM
```

Use the actual configured receiver scope; the existing `--board`, `--actor`, `--endpoint` and `--ca` arguments and `WEFTLINE_AGENT_SESSION` select the trusted receiver and actor. The journal directory must already exist, be owned by the process user and have mode `0700`; it must be distinct from the task journal. Do not use example values as real configuration. The receiver independently authenticates and compares its actual scope. Configuration and CA are snapshotted; the server passes no caller-selected actor, session, scope or operation ID to the receiver.

The tools are `knowledge_create` (documentId, title, html), `knowledge_edit` (documentId, previousGeneration, title, html), `knowledge_reconcile` (no arguments), and `knowledge_ack` (the exact original operationId, operation, documentId, previousGeneration, title and html; use -1 for a create). A confirmed response contains only status, operationId, operation, documentId and resulting generation, never title or HTML. Retain the original content securely before dispatch. Compare the returned metadata to your original request and submit the entire exact original intent to acknowledge it. If original content is lost, remain blocked and require offline recovery; an opaque ID is insufficient. The comparison occurs inside the journal lock. Wrong inputs remain blocked. A lost acknowledgment can be repeated with the same exact intent while that operation remains current. If a confirmation response is lost, after restart `knowledge_reconcile` recovers locally confirmed metadata without a provider call; for a pending intent it checks the scoped receiver with the saved intent. There is no automatic cancellation or retry. The journal contains private plaintext: protect the directory and backups. Sessions and keys are not journaled.

Equality checks at the trusted local MCP boundary can act as an oracle for guesses about the saved intent. Restrict access to that boundary; these checks do not authenticate the server or response path. A confirmation is only a trusted receiver's confirmation of that exact operation, not evidence of the current document head.

The scoped-write flag fences unscoped knowledge routes only on this listener. Removing `WEFTLINE_REVIEW_KNOWLEDGE_AGENT_SCOPED_WRITE=1` while versioned composition remains enabled re-enables those unscoped routes on that listener; rollback must account for that explicitly. Other listeners and privileged clients are not fenced by this setting.

See `../knowledge-write-journal.md` for the journal's durability, lock, rollback and loss limitations. It requires reliable local filesystem fsync/rename semantics and trusted directory ancestors. Loss of both journal marker and record is indistinguishable from first use; separate copies or restoring an old snapshot can permit duplicate operations. A stale lock requires offline investigation, not automatic removal. A trusted receiver and its response path are essential: strict JSON confirmation cannot authenticate a compromised ingress. No claim is made about actual provider row size or transactional semantics, cross-host coordination, atomic revocation, timeout cancellation, production access or immunity to a privileged writer.
