# Harness Tools

Shared drivers for Cloudflare API access, bounded deployment, metering, bundle preparation and
resource cleanup. These modules support the [experiment harnesses](../README.md).

Credentials are read from the selected account environment and never written to sanitized
evidence. Raw resource snapshots and deployment logs remain in ignored run directories.
Local and deployed tests cover these helpers in `tests/unit/` and `tests/integration/`.
