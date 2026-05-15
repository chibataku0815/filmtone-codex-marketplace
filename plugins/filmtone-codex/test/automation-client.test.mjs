import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { AutomationClient, BatchJobManager } from "../dist/automation-client.js";
import { filmtoneTools } from "../dist/index.js";

const tempDirs = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

test("tools expose workflow operations only", () => {
  const names = filmtoneTools.map((tool) => tool.name);
  assert.deepEqual(names, [
    "inspect_sources",
    "prepare_filmtone_answer_context",
    "preview_batch_job",
    "start_batch_job",
    "get_batch_job_status",
    "cancel_batch_job",
    "summarize_batch_job",
  ]);
  assert.equal(names.some((name) => name.includes("set_control")), false);
});

test("missing helper returns actionable setup error without build or download", () => {
  const dir = makeTempDir();
  const missing = join(dir, "FilmtoneAutomationCLI");
  const client = new AutomationClient({
    cliPath: missing,
    helperSearchPaths: [],
    pathPolicyOptions: {
      sourceRoots: [dir],
      outputRoots: [dir],
    },
  });

  assert.throws(
    () => client.inspectSources({ paths: [dir] }),
    (error) => {
      assert.match(error.message, /Filmtone helper CLI not found/);
      assert.match(error.message, /Searched:/);
      assert.match(error.message, /FILMTONE_AUTOMATION_CLI/);
      assert.match(error.message, /does not bundle the Filmtone desktop binary or proprietary LUTs/);
      assert.equal(existsSync(missing), false);
      return true;
    }
  );
});

test("start requires a preview id", () => {
  const manager = new BatchJobManager(new AutomationClient({ helperSearchPaths: [] }));
  assert.throws(() => manager.start("missing-preview"), /previewId is required/);
});

test("unsupported export profiles return a user-facing error before helper lookup", () => {
  const dir = makeTempDir();
  const client = new AutomationClient({
    helperSearchPaths: [],
    pathPolicyOptions: {
      sourceRoots: [dir],
      outputRoots: [dir],
    },
  });

  assert.throws(
    () => client.previewBatch({
      paths: [dir],
      profiles: ["proRes422"],
    }),
    /ProRes, HEVC, and cloud upload are not supported yet/
  );
});

test("path policy rejects sources outside allowed roots before launching helper", () => {
  const allowed = makeTempDir();
  const outside = makeTempDir();
  const client = new AutomationClient({
    helperSearchPaths: [],
    pathPolicyOptions: {
      sourceRoots: [allowed],
      outputRoots: [allowed],
    },
  });

  assert.throws(
    () => client.inspectSources({ paths: [outside] }),
    /outside Filmtone MCP's allowed source roots/
  );
});

test("path policy rejects output directories outside allowed roots before launching helper", () => {
  const allowed = makeTempDir();
  const outside = makeTempDir();
  const client = new AutomationClient({
    helperSearchPaths: [],
    pathPolicyOptions: {
      sourceRoots: [allowed],
      outputRoots: [allowed],
    },
  });

  assert.throws(
    () => client.previewBatch({
      paths: [allowed],
      outputDirectory: outside,
    }),
    /outside Filmtone MCP's allowed output roots/
  );
});

test("runtime validation rejects excessive path arrays before launching helper", () => {
  const dir = makeTempDir();
  const client = new AutomationClient({
    helperSearchPaths: [],
    pathPolicyOptions: {
      sourceRoots: [dir],
      outputRoots: [dir],
    },
  });

  assert.throws(
    () => client.inspectSources({
      paths: Array.from({ length: 129 }, () => dir),
    }),
    /the limit is 128/
  );
});

test("helper override can inspect sources through mock CLI", () => {
  const dir = makeTempDir();
  const cliPath = join(dir, "mock-filmtone-cli.cjs");
  writeExecutable(cliPath, `#!/usr/bin/env node
const fs = require("node:fs");
const input = JSON.parse(fs.readFileSync(0, "utf8"));
if (input.command !== "inspectSources") process.exit(2);
console.log(JSON.stringify({ ok: true, result: {
  sources: [{ path: input.inspectSources.paths[0], kind: "folder" }],
  warnings: [],
  analysisLimits: { answerMode: "state-export-advice" }
}}));
`);
  const client = new AutomationClient({
    cliPath,
    helperSearchPaths: [],
    pathPolicyOptions: {
      sourceRoots: [dir],
      outputRoots: [dir],
    },
  });

  assert.deepEqual(client.inspectSources({ paths: [dir] }), {
    sources: [{ path: realpathSync.native(dir), kind: "folder" }],
    warnings: [],
    analysisLimits: {
      answerMode: "state-export-advice",
    },
  });
});

test("job manager parses JSONL batch progress", async () => {
  const dir = makeTempDir();
  const cliPath = join(dir, "mock-filmtone-cli.cjs");
  writeBatchMock(cliPath, dir, 2);
  const manager = new BatchJobManager(new AutomationClient({
    cliPath,
    helperSearchPaths: [],
    pathPolicyOptions: {
      sourceRoots: [dir],
      outputRoots: [dir],
    },
  }));

  const { previewId } = manager.createPreview({ paths: [dir] });
  const started = manager.start(previewId);
  assert.equal(started.status, "running");
  const summary = await waitForSummary(manager, started.jobId);
  assert.equal(summary.status, "completed");
  assert.equal(summary.eventCount, 4);
});

test("job manager caps retained JSONL progress events", async () => {
  const dir = makeTempDir();
  const cliPath = join(dir, "mock-filmtone-cli.cjs");
  writeBatchMock(cliPath, dir, 1005);
  const manager = new BatchJobManager(new AutomationClient({
    cliPath,
    helperSearchPaths: [],
    pathPolicyOptions: {
      sourceRoots: [dir],
      outputRoots: [dir],
    },
  }));

  const { previewId } = manager.createPreview({ paths: [dir] });
  const started = manager.start(previewId);
  const summary = await waitForSummary(manager, started.jobId);
  assert.equal(summary.status, "completed");
  assert.equal(summary.eventCount, 1000);
  assert.ok(summary.droppedEvents > 0);
});

function makeTempDir() {
  const dir = mkdtempSync(join(tmpdir(), "filmtone-mcp-test-"));
  tempDirs.push(dir);
  return dir;
}

function writeExecutable(path, body) {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

function writeBatchMock(path, dir, progressCount) {
  writeExecutable(path, `#!/usr/bin/env node
const fs = require("node:fs");
const input = JSON.parse(fs.readFileSync(0, "utf8"));
if (input.command === "previewBatch") {
  console.log(JSON.stringify({ ok: true, result: {
    plan: {
      createdAtIso: "2026-05-16T00:00:00.000Z",
      look: { label: "Stone", presetName: "reset", presetStrength: 1, lookSlug: "filmtone-creative-pack-01-stone" },
      profiles: ["social1080"],
      options: { overwrite: false, continueOnError: true, recursive: false },
      items: [{ sourcePath: "${dir}/in.mov", outputPath: "${dir}/out.mp4", profile: "social1080", status: "ready", warnings: [] }],
      warnings: []
    },
    warnings: [],
    analysisLimits: { answerMode: "state-export-advice" }
  }}));
} else if (input.command === "runBatch") {
  console.log(JSON.stringify({ event: "jobStarted", payload: { totalItems: 1, readyItems: 1 } }));
  for (let i = 0; i < ${progressCount}; i++) console.log(JSON.stringify({ event: "itemProgress", payload: { processedFrames: i } }));
  console.log(JSON.stringify({ event: "jobFinished", payload: { succeeded: 1, failed: 0, skipped: 0 } }));
}
`);
}

async function waitForSummary(manager, jobId) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const summary = manager.summarize(jobId);
    if (summary.status !== "running") return summary;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return manager.summarize(jobId);
}
