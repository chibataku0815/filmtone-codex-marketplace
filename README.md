# Filmtone Codex Marketplace

This repository publishes the Filmtone Codex plugin marketplace source.

Install the marketplace:

```bash
codex plugin marketplace add chibataku0815/filmtone-codex-marketplace
```

Then install `filmtone/filmtone-codex` from the Codex plugin UI or any Codex
plugin install surface available in your Codex version.

## What It Provides

- Inspect Filmtone-ready video folders from Codex.
- Prepare state/export context for abstract Filmtone questions.
- Preview batch export plans before running them.
- Start, track, cancel, and summarize long Filmtone batch export jobs.

The plugin is a thin MCP wrapper. It does not bundle Filmtone Desktop,
`FilmtoneAutomationCLI`, proprietary LUTs, signing material, or media assets.

## Helper Requirement

The MCP server calls a local Filmtone automation helper. Phase A detects helpers
only. It searches:

- `/Applications/Filmtone.app/Contents/MacOS/FilmtoneAutomationCLI`
- `/Applications/Filmtone.app/Contents/Helpers/FilmtoneAutomationCLI`
- `~/Applications/Filmtone.app/Contents/MacOS/FilmtoneAutomationCLI`
- `~/Applications/Filmtone.app/Contents/Helpers/FilmtoneAutomationCLI`

For development, set:

```bash
export FILMTONE_AUTOMATION_CLI=/absolute/path/to/FilmtoneAutomationCLI
export FILMTONE_CREATIVE_LUT_ROOT=/absolute/path/to/CreativeLuts
```

If no helper is available, tools return an actionable setup error instead of
trying to download or build native code.

## Security Model

- The public repo contains only TypeScript/JavaScript MCP wrapper code and
  plugin metadata.
- Native Swift source, `.cube` LUTs, signing material, provisioning profiles,
  and local `.env` files are intentionally excluded.
- The wrapper validates tool input, restricts default file access to user media
  locations and `/Volumes`, caps job/event output, and requires a signed preview
  plan before starting an export.

## Development

```bash
cd plugins/filmtone-codex
npm install
npm test
```
