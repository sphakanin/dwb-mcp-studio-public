# Distribution boundary

The release contains DWB's core source, compiled JavaScript, setup scripts, tests and documentation. DWB code is covered by the included MIT LICENSE.

Source ZIP releases do not contain Node.js, Desktop Commander, Desktop Commander Remote, OpenAI tunnel, other tunnel clients, third-party binaries or node_modules. The macOS DMG includes the official Node.js runtime (with npm and its upstream licenses under `Contents/Resources/node`) and production npm dependencies installed from the source lockfile, including their upstream license files. Desktop Commander and tunnel-client are downloaded separately during Setup. No release includes accounts, API keys or user runtime data. DWB is not an official release of those projects and does not grant access to their services.

When the user clicks Install in Setup, their machine downloads Desktop Commander 0.2.50 from npm and tunnel-client 0.0.11 from the [official OpenAI release](https://github.com/openai/tunnel-client/releases/tag/v0.0.11), into this DWB installation's `external` folder. These downloads are separate from the distributed ZIP. Their upstream licenses apply and are retained. See [sources and installation](docs/EXTERNAL.md).

The DWB Companion HTML bundle embeds `@modelcontextprotocol/ext-apps` UI SDK 2.0.3 and transitive client code. Complete license and any root NOTICE texts from the actual bundle inputs are included in [Companion third-party notices](assets/licenses/companion-THIRD-PARTY-NOTICES.txt) and embedded in an inert template inside `dist/companion-panel.html`. The build verifies these notices against installed dependencies and stops if they are missing or stale. After a deliberate dependency update, run `node scripts/build-companion.mjs --update-notices`, review the notice changes, and run `npm run build` and `npm run test:licenses`.

The current bundle includes MCP client/core 2.3.1 (declared Apache-2.0), ext-apps 2.0.3 (declared MIT), Zod 4.6.2 (MIT), and pkce-challenge 5.0.1 (MIT). The MCP packages retain their complete upstream license text, including transition notices and any MIT terms for earlier contributions. The original ext-apps license is also retained at `assets/licenses/ext-apps-LICENSE.txt`.

The package manifests also reference server-side MCP SDK libraries, Zod and development tools. npm downloads these packages on the user's machine during setup; their own licenses apply. Their installed directories are not included in DWB's ZIP; the Companion browser bundle described above is the exception containing bundled implementations. `npm ci --omit=dev` does not install Desktop Commander or a tunnel.

The DWB worker loader redirects the supported external worker's configuration-home expression in memory. It does not copy the external package into a release or alter the user's installed files. The test fixture under the DWB test script is an original minimal MCP test double.

## License inventory (2026-10-11)

| Component                 | Version reviewed       | License                                                                                                     | Delivery                                                         |
| ------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| DWB source and launcher   | 0.1.0-beta.16          | [MIT](LICENSE)                                                                                              | Included in this release candidate                               |
| Desktop Commander         | 0.2.50                 | [MIT, upstream license](https://raw.githubusercontent.com/wonderwhy-er/DesktopCommanderMCP/v0.2.50/LICENSE) | Downloaded by Setup from npm                                     |
| OpenAI tunnel-client      | 0.0.11                 | [Apache-2.0, upstream license](https://raw.githubusercontent.com/openai/tunnel-client/v0.0.11/LICENSE)      | Downloaded by Setup from the upstream release                    |
| MCP SDK / server / client | 1.32.1 / 2.3.1 / 2.3.1 | MIT / Apache-2.0 / Apache-2.0 declarations; retain complete upstream terms                                  | Downloaded by npm; browser client code also bundled in Companion |
| Zod                       | 4.6.2                  | MIT (installed package license and lockfile)                                                                | Downloaded by npm                                                |
| TypeScript                | 7.0.2                  | Apache-2.0 (installed package license and lockfile)                                                         | Downloaded by npm for source builds                              |

The reviewed lockfile declares MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause and ISC licenses across its 152 dependency entries. None has a missing license field. This is a metadata inventory, not an independent provenance audit of every dependency. Server JavaScript keeps dependency imports; browser implementations are bundled only in Companion HTML with the notices above.

Keep DWB's copyright and MIT license with copies of DWB. Keep upstream license and attribution files with downloaded components. If redistributing those components later, review their redistribution conditions separately, including any applicable Apache NOTICE files and notices for modified files. Do not redistribute a configured installation folder as a DWB release.

The DWB logo supplied by the project owner is used in the launcher and documentation. This review relies on the owner's rights to that asset and the DWB source; it does not independently establish their provenance. An open-source software license does not grant access to a hosted service or permission to imply endorsement by its operator. Users supply their own authorized service credentials.
