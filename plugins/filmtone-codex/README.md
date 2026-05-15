# Filmtone Codex

Filmtone Codex is a Codex MCP plugin for video folder inspection, abstract
state/export Q&A context, and tracked Filmtone batch export jobs.

## Tools

- `inspect_sources(paths, recursive?)`
- `prepare_filmtone_answer_context(question, paths?, recursive?)`
- `preview_batch_job(planRequest)`
- `start_batch_job(previewId, overwrite?)`
- `get_batch_job_status(jobId)`
- `cancel_batch_job(jobId)`
- `summarize_batch_job(jobId)`

## Requirements

The plugin requires a local Filmtone automation helper. It searches standard
Filmtone Desktop app locations first. Development builds can be selected with:

```bash
export FILMTONE_AUTOMATION_CLI=/absolute/path/to/FilmtoneAutomationCLI
export FILMTONE_CREATIVE_LUT_ROOT=/absolute/path/to/CreativeLuts
```

The plugin does not bundle or download native binaries. Without the helper, MCP
tools return a setup error that lists the searched paths.

## Limits

v0.1.0 is Phase A:

- Video batch workflows and state/export advice only.
- No visual frame analysis, mask detection, skin detection, or in-app chat.
- Export profiles are `social1080` and `archiveH264`.
- ProRes, HEVC, and cloud upload are not supported yet.
