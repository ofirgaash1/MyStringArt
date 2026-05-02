# Agent Run Notes

The shell runner does not stream arbitrary live stdout/stderr back to the agent while a command is still running. For long jobs, use the built-in heartbeat logging in the scripts so progress shows up periodically.

## E2E

- `E2E_TIMEOUT_MS`: default timeout for Playwright waits and page actions.
- `E2E_SERVER_TIMEOUT_MS`: max time to wait for the Vite dev server.
- `E2E_ENABLED_TIMEOUT_MS`: max time to wait for a control to become enabled.
- `E2E_HEARTBEAT_MS`: interval for progress logs during long waits.

## Golden

- `GOLDEN_TIMEOUT_MS`: default timeout for Playwright waits and page actions.
- `GOLDEN_SERVER_TIMEOUT_MS`: max time to wait for the preview server.
- `GOLDEN_HEARTBEAT_MS`: interval for progress logs during long waits.
- `GOLDEN_PROGRESS_POLL_MS`: how often to sample page progress.
- `GOLDEN_STALL_TIMEOUT_MS`: how long to allow without line-count progress before failing.
- `golden:shared-loop:capture:*` runs headed by default so you can watch the browser during capture.

If a run looks stalled, set the relevant heartbeat to `10000` or lower and reduce the timeout for faster failure.
