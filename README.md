# fieldpack

Three local-first tools for field engineering work, pinned together and verified as one suite.

Field engineering runs on three artifacts: the deck you present, the skill the agent used to produce it, and the evidence that says the pilot worked. I built one tool for each and kept them separate on purpose, so a customer can take deckforge without proofpack, and an agent can drive any of them alone. fieldpack is where the seams get tested. It pins the three as submodules and runs a verification suite across them: does a proofpack export import cleanly into deckforge and fit on every slide, does skillforge round-trip a deckforge skill folder byte for byte, do the browser UIs pass an axe accessibility audit at desktop and phone width, does each product still install from its packed tarball without its siblings.

| Tool | Does |
|---|---|
| [deckforge](https://github.com/ong6/deckforge) | Presentation studio with a measured headless preflight |
| [skillforge](https://github.com/ong6/skillforge) | Skill discovery, versioning and baseline-aware evaluation |
| [proofpack](https://github.com/ong6/proofpack) | Pilot criteria, evidence and customer-safe handovers |

All three share one shape: a CLI and an MCP server over a JSON workspace you initialise explicitly, revision-checked mutations, `--read-only` mode, and no model calls, uploads or telemetry.

## Quick start

Node 23 or newer.

```sh
git clone --recurse-submodules https://github.com/ong6/fieldpack.git
cd fieldpack
npm run doctor            # each submodule matches its pin, dependencies present
npm run setup             # npm ci in every product and in verification/
npm run browser:install   # Chromium for the headless and browser tests
npm run test:products     # the three product suites
npm test                  # doctor, then the 28-test cross-product verification suite
```

## What the verification covers

- Agent pipeline: skillforge, proofpack and deckforge driven end to end through their product APIs in one temp workspace.
- Contract: proofpack's deckforge export derives only from customer-visible records and never changes when private fields do.
- Exports: an offline HTML deck from a proofpack readout, measured for overflow.
- Browser: edit, persist, reorder, import, export, present and print in each UI, with axe audits and screenshots at desktop and mobile width.
- Packaging: every product installs from `npm pack` output with no sibling present.

## More from ong6

Forges make things, packs bundle them.

- [groundplane](https://github.com/ong6/groundplane) — fails the build when an agent asserts a fact its tools never produced
- [jobforge](https://github.com/ong6/jobforge) — grades the interview plan you say out loud, not the code you submit
- [skillforge](https://github.com/ong6/skillforge) — skill discovery, versioning and baseline-aware evaluation
- [deckforge](https://github.com/ong6/deckforge) — agent-first presentation studio with a measured preflight
- [proofpack](https://github.com/ong6/proofpack) — pilot evidence, review proposals and customer-safe handovers
- [skillpack](https://github.com/ong6/skillpack) — the Claude Code and Codex skills used across all of these
