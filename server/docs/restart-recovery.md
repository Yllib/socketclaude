# Restart recovery

`scripts/restart-server.sh` compiles first, calls the authenticated loopback
`POST /internal/restart/prepare` endpoint, arms the service recovery guard,
and invokes the service manager from a detached worker. It checks readiness
and the new process ID through `GET /internal/restart/status`. The shell
does not choose idle sessions or submit continuation prompts.

The server owns `recovery/runs.json` in its configured data directory. Writes
use an atomic rename and fsync. A run is recorded before starting a known
session, or as soon as a newly created session has a persistent identity.
Completed and user-stopped runs are removed. During shutdown, recovery records
are retained while backend interruption, stream flushes, and plugin cleanup run.
Cleanup has a 15-second deadline.

On startup, records owned by the old process become pending. Recovery starts
after plugin initialization, with at most three simultaneous setup operations.
Setup has bounded timeouts and five attempts with exponential backoff. Each
session is reserved during setup, and a new user prompt cannot be replaced by
a recovery runner. Stop locks prevent automatic resumption. Scheduled tasks
retain their original run, and delegated children retain completion ownership.

Recovery resumes the existing conversation with an interruption notice. It
does not replay the original command or promise exactly-once external effects.
The agent is instructed to inspect actual state before repeating an action,
and to ask the user when an uncertain outcome cannot safely be checked.
Failures after a query has launched are reported rather than blindly retried.

The legacy `continue-session.js` helper accepts an optional third argument,
a stable request ID. Reuse that ID if an HTTP result is uncertain. The server
retains the latest 1,000 completed recovery/request IDs for duplicate detection.

Readiness timeout does not discard recovery records. They survive a worker
failure, service crash, and host reboot, provided the data disk survives and
the OS starts the SocketAgent service again. Recovery does not restore live
browser processes or an external tool's interrupted process memory.

The new script fails safely against older servers without the preparation
endpoint. First activation normally uses the idle auto-update path. For a
coordinated local Linux upgrade, `--bootstrap-session ID` accepts only that
single running caller and exclusively creates its recovery journal. It refuses
other active sessions or an existing journal. Do not send new work during this
one-time transition, since the old server cannot enforce a drain.
Sessions already running before this feature is loaded do not have its journal.

Tests use temporary journals, fake HTTP backends, and a fake service manager.
They never restart the installed service or submit real model prompts.
