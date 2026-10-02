# Cross-platform candidate validation — 2026-09-19

Development host: Windows x64, Node.js 24.11.1. No macOS host was available in this session.
The Mac native app, Keychain bridge and LaunchAgent code remain pending real Mac execution.

## Passed on Windows

- `npm test`: typecheck/build, request context, payload guard, worker circuit, session lifecycle, workspace binding, core hardening, public core and dashboard.
- `npm run test:integration`: all eight real Desktop Commander 0.2.50 suites: worker recovery, payload, multiple sessions, broker recovery, logical context, protocol negotiation, workspace shell/boundary and resume routing. The external install was unchanged.
- `npm run test:setup`, `test:tunnel`, `test:external`, `test:upgrade`, `test:runtime-upgrade`, `test:shell`, `test:preferences`: real Windows setup/tray/preferences plus upgrade/rollback and tunnel fixtures.
- `npm run test:platform`: HTTP authentication, Host/Origin validation, JSON/body limits, owned install paths, checksum rejection, environment isolation, command quoting, failed multi-file save rollback, competing SQLite leases and crash release, platform path/workspace checks. The Mac-only schema migration test is skipped on Windows.
- Browser check of the actual Mac HTML/JS against a simulated backend: Start changes Ready/session/button states; Stop restores the stopped state. This does not validate Swift/WebKit or a live tunnel.

## Pending on Mac

The `macOS candidate` GitHub Actions workflow covers `macos-15` (Apple Silicon) and `macos-15-intel`. It has been added locally, not run or published in this session.

It installs Node 22.16, runs core/platform tests, compiles the AppKit/WebKit app, checks an isolated Keychain entry, checks process-group cleanup, installs the pinned dependencies, runs real core recovery tests and builds the source ZIP.

Manual acceptance remains necessary for the native window/menu bar, folder chooser, macOS permissions, actual ChatGPT tunnel connection, login startup, sleep/wake and case-sensitive storage. A source-built ad-hoc app is not a Developer ID signed/notarized public binary release.

## Implementation boundaries

- Windows EXE, WPF, DPAPI and Registry behavior retain their original implementation.
- macOS uses a native Swift shell around a localhost control page, a stdin-based Security-framework Keychain helper and per-user LaunchAgent preferences.
- Tunnel archives are pinned to OpenAI v0.0.11 and SHA256 per architecture. Install staging is separate and worker replacement retains a backup.
- Mac HTTP commands require a random token and trusted Host/Origin. Keys never enter argv or profiles. Tunnel supervision uses owned child processes and EOF shutdown instead of trusting persisted PIDs.
- Mac data retains the earlier Preview directory to preserve any existing test settings. The workspace migration changes root collation only outside Windows; runtime identity checks preserve case outside Windows.

References: [OpenAI pinned assets](https://github.com/openai/tunnel-client/releases/expanded_assets/v0.0.11), [GitHub runner labels](https://docs.github.com/en/actions/reference/runners/github-hosted-runners), [Apple LaunchAgents](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html).
