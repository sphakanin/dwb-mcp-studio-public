# DWB MCP Studio public source

This repository contains the DWB program, its installers, tests, documentation,
and DWB assets. Keep other projects in their own workspace outside this repository.

Do not create research labs, training datasets or weights, video compositions,
recording plans, or credentials for other services here. Configure DWB to use the
target project's directory as its workspace when working on that project.

Local dependencies, builds, logs, runtime state, and releases use their existing
ignored directories. User settings and tunnel credentials belong in DWB's data
directory, outside the distributed source.

The exact release file list is in scripts/distribution-files.json. Update it
deliberately when adding a DWB source file, installer, test, or document.
The developmentFiles list must remain empty for public releases. Keep internal engineering
evidence in the ignored engineering/ directory and audit logs in logs/.

Before packaging, run npm run test:distribution and inspect git diff. Both release
builders and npm prepack enforce the distribution boundary.
