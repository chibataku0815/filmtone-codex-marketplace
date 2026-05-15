// src/automation-client.ts
import { existsSync as existsSync2 } from "node:fs";
import { homedir as homedir2 } from "node:os";
import { dirname as dirname2, resolve as resolve2 } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createHmac, randomBytes, randomUUID } from "node:crypto";

// src/security.ts
import { existsSync, realpathSync } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, relative, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
var MCP_LIMITS = {
  maxPaths: 128,
  maxPathLength: 4096,
  maxQuestionLength: 4e3,
  maxLookLength: 120,
  maxIdLength: 128,
  maxProfiles: 2,
  maxPreviewCount: 100,
  maxJobCount: 50,
  maxRunningJobs: 2,
  maxJobEvents: 1e3,
  maxStderrBytes: 64 * 1024,
  maxStdoutBytes: 8 * 1024 * 1024,
  maxScanFiles: 500,
  previewTtlMs: 30 * 60 * 1e3,
  jobTtlMs: 6 * 60 * 60 * 1e3,
  jobTimeoutMs: 6 * 60 * 60 * 1e3
};
var sensitiveComponents = /* @__PURE__ */ new Set([
  ".aws",
  ".azure",
  ".config",
  ".docker",
  ".gnupg",
  ".kube",
  ".ssh",
  ".zsh_history",
  ".bash_history"
]);
var FilmtoneMcpInputError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "FilmtoneMcpInputError";
  }
};
var FilmtoneMcpSecurityError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "FilmtoneMcpSecurityError";
  }
};
var FilmtonePathPolicy = class {
  sourceRoots;
  outputRoots;
  maxPaths;
  maxPathLength;
  maxScanFiles;
  allowAnyPath;
  constructor(options = {}, env = process.env) {
    this.maxPaths = options.maxPaths ?? MCP_LIMITS.maxPaths;
    this.maxPathLength = options.maxPathLength ?? MCP_LIMITS.maxPathLength;
    this.maxScanFiles = options.maxScanFiles ?? parsePositiveInt(env.FILMTONE_MCP_MAX_SCAN_FILES) ?? MCP_LIMITS.maxScanFiles;
    this.allowAnyPath = options.allowAnyPath ?? env.FILMTONE_MCP_ALLOW_ANY_PATH === "1";
    this.sourceRoots = canonicalRoots(
      options.sourceRoots ?? parsePathList(env.FILMTONE_MCP_ALLOWED_SOURCE_ROOTS) ?? defaultSourceRoots()
    );
    this.outputRoots = canonicalRoots(
      options.outputRoots ?? parsePathList(env.FILMTONE_MCP_ALLOWED_OUTPUT_ROOTS) ?? defaultOutputRoots()
    );
  }
  validateSourcePaths(paths, label = "paths") {
    if (!Array.isArray(paths)) {
      throw new FilmtoneMcpInputError(`${label} must be an array of file or folder paths.`);
    }
    if (paths.length === 0) {
      throw new FilmtoneMcpInputError(`${label} must contain at least one path.`);
    }
    if (paths.length > this.maxPaths) {
      throw new FilmtoneMcpInputError(`${label} contains ${paths.length} paths; the limit is ${this.maxPaths}.`);
    }
    return paths.map((path, index) => {
      if (typeof path !== "string") {
        throw new FilmtoneMcpInputError(`${label}[${index}] must be a string path.`);
      }
      return this.validatePath(path, "source", `${label}[${index}]`);
    });
  }
  validateOptionalSourcePaths(paths, label = "paths") {
    if (paths === void 0) return void 0;
    return this.validateSourcePaths(paths, label);
  }
  validateOutputDirectory(path) {
    if (path === void 0) return void 0;
    if (typeof path !== "string") {
      throw new FilmtoneMcpInputError("outputDirectory must be a string path.");
    }
    return this.validatePath(path, "output", "outputDirectory");
  }
  validateOutputPath(path, label = "outputPath") {
    if (typeof path !== "string") {
      throw new FilmtoneMcpInputError(`${label} must be a string path.`);
    }
    const canonical = this.validatePath(path, "output", label);
    if (!canonical.toLowerCase().endsWith(".mp4")) {
      throw new FilmtoneMcpSecurityError(`${label} must be an .mp4 output path.`);
    }
    return canonical;
  }
  env() {
    return {
      FILMTONE_MCP_ALLOWED_SOURCE_ROOTS: this.sourceRoots.join(delimiter),
      FILMTONE_MCP_ALLOWED_OUTPUT_ROOTS: this.outputRoots.join(delimiter),
      FILMTONE_MCP_MAX_SCAN_FILES: String(this.maxScanFiles)
    };
  }
  validatePath(input, kind, label) {
    validatePathString(input, label, this.maxPathLength);
    const canonical = canonicalizePath(input);
    if (isSensitivePath(canonical)) {
      throw new FilmtoneMcpSecurityError(`${label} points to a sensitive path that Filmtone MCP will not access: ${redactHome(canonical)}`);
    }
    if (this.allowAnyPath) return canonical;
    const roots = kind === "source" ? this.sourceRoots : this.outputRoots;
    if (!roots.some((root) => isWithin(root, canonical))) {
      throw new FilmtoneMcpSecurityError([
        `${label} is outside Filmtone MCP's allowed ${kind} roots: ${redactHome(canonical)}.`,
        `Allowed roots: ${roots.map(redactHome).join(", ") || "(none)"}.`,
        `Set ${kind === "source" ? "FILMTONE_MCP_ALLOWED_SOURCE_ROOTS" : "FILMTONE_MCP_ALLOWED_OUTPUT_ROOTS"} to grant access explicitly.`
      ].join(" "));
    }
    return canonical;
  }
};
function assertPlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new FilmtoneMcpInputError(`${label} must be an object.`);
  }
  return value;
}
function assertAllowedKeys(value, allowed, label) {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) {
    throw new FilmtoneMcpInputError(`${label} contains unsupported field(s): ${unknown.join(", ")}.`);
  }
}
function readOptionalBoolean(value, label) {
  if (value === void 0) return void 0;
  if (typeof value !== "boolean") {
    throw new FilmtoneMcpInputError(`${label} must be a boolean.`);
  }
  return value;
}
function readRequiredString(value, label, maxLength) {
  if (typeof value !== "string") {
    throw new FilmtoneMcpInputError(`${label} must be a string.`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new FilmtoneMcpInputError(`${label} must not be empty.`);
  }
  if (Buffer.byteLength(trimmed, "utf8") > maxLength) {
    throw new FilmtoneMcpInputError(`${label} is too long; the limit is ${maxLength} bytes.`);
  }
  return trimmed;
}
function readOptionalString(value, label, maxLength) {
  if (value === void 0) return void 0;
  return readRequiredString(value, label, maxLength);
}
function readOptionalNumber(value, label, min, max) {
  if (value === void 0) return void 0;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new FilmtoneMcpInputError(`${label} must be a finite number.`);
  }
  if (value < min || value > max) {
    throw new FilmtoneMcpInputError(`${label} must be between ${min} and ${max}.`);
  }
  return value;
}
function readRequiredId(value, label) {
  const id = readRequiredString(value, label, MCP_LIMITS.maxIdLength);
  if (!/^[0-9a-fA-F-]{8,128}$/.test(id)) {
    throw new FilmtoneMcpInputError(`${label} must be a Filmtone MCP id returned by a previous tool call.`);
  }
  return id;
}
function defaultSourceRoots() {
  const home = homedir();
  return [
    process.cwd(),
    tmpdir(),
    "/tmp",
    resolve(home, "Movies"),
    resolve(home, "Pictures"),
    resolve(home, "Desktop"),
    resolve(home, "Downloads"),
    "/Volumes"
  ];
}
function defaultOutputRoots() {
  const home = homedir();
  return [
    process.cwd(),
    tmpdir(),
    "/tmp",
    resolve(home, "Movies"),
    resolve(home, "Pictures"),
    resolve(home, "Desktop"),
    resolve(home, "Downloads"),
    "/Volumes"
  ];
}
function parsePathList(value) {
  if (!value?.trim()) return void 0;
  const paths = value.split(new RegExp(`[\\n${escapeForCharClass(delimiter)}]`)).map((entry) => entry.trim()).filter(Boolean);
  return paths.length > 0 ? paths : void 0;
}
function parsePositiveInt(value) {
  if (!value) return void 0;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : void 0;
}
function canonicalRoots(paths) {
  return Array.from(new Set(paths.map(canonicalizePath))).sort();
}
function validatePathString(path, label, maxPathLength) {
  if (!path.trim()) {
    throw new FilmtoneMcpInputError(`${label} must not be empty.`);
  }
  if (path.includes("\0")) {
    throw new FilmtoneMcpInputError(`${label} must not contain NUL bytes.`);
  }
  if (Buffer.byteLength(path, "utf8") > maxPathLength) {
    throw new FilmtoneMcpInputError(`${label} is too long; the limit is ${maxPathLength} bytes.`);
  }
}
function canonicalizePath(path) {
  const absolute = resolve(expandHome(path));
  let probe = absolute;
  const missing = [];
  while (!existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) break;
    missing.unshift(basename(probe));
    probe = parent;
  }
  const base = existsSync(probe) ? realpathSync.native(probe) : probe;
  return resolve(base, ...missing);
}
function expandHome(path) {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return path;
}
function isWithin(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || !rel.startsWith("..") && !isAbsolute(rel);
}
function isSensitivePath(path) {
  const home = canonicalizePath(homedir());
  const sensitiveRoots = [
    "/",
    "/System",
    "/Library",
    "/private/etc",
    "/etc",
    "/usr",
    "/bin",
    "/sbin",
    "/var/db",
    "/private/var/db",
    resolve(home, "Library"),
    resolve(home, ".ssh"),
    resolve(home, ".gnupg"),
    resolve(home, ".aws"),
    resolve(home, ".config"),
    resolve(home, ".kube"),
    resolve(home, ".docker")
  ].map(canonicalizePath);
  if (sensitiveRoots.some((root) => path === root || root !== "/" && isWithin(root, path))) {
    return true;
  }
  return path.split("/").some((part) => sensitiveComponents.has(part));
}
function redactHome(path) {
  const home = homedir();
  return path === home ? "~" : path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
}
function escapeForCharClass(value) {
  return value.replace(/[\\\]\-^]/g, "\\$&");
}

// src/automation-client.ts
var supportedExportProfiles = ["social1080", "archiveH264"];
function validateBatchPlanRequest(request, policy = new FilmtonePathPolicy()) {
  const payload = assertPlainObject(request, "planRequest");
  assertAllowedKeys(payload, [
    "paths",
    "recursive",
    "outputDirectory",
    "look",
    "strength",
    "profiles",
    "overwrite",
    "continueOnError"
  ], "planRequest");
  const profiles = validateProfiles(payload.profiles);
  return {
    paths: policy.validateSourcePaths(payload.paths),
    recursive: readOptionalBoolean(payload.recursive, "recursive"),
    outputDirectory: policy.validateOutputDirectory(payload.outputDirectory),
    look: readOptionalString(payload.look, "look", MCP_LIMITS.maxLookLength),
    strength: readOptionalNumber(payload.strength, "strength", 0, 1),
    profiles,
    overwrite: readOptionalBoolean(payload.overwrite, "overwrite"),
    continueOnError: readOptionalBoolean(payload.continueOnError, "continueOnError")
  };
}
function validateProfiles(profiles) {
  if (profiles === void 0) return void 0;
  if (!Array.isArray(profiles)) {
    throw new Error(
      "Export profiles must be an array. v1 supports social1080 and archiveH264 only. ProRes, HEVC, and cloud upload are not supported yet."
    );
  }
  if (profiles.length > MCP_LIMITS.maxProfiles) {
    throw new FilmtoneMcpInputError(`profiles contains ${profiles.length} entries; the limit is ${MCP_LIMITS.maxProfiles}.`);
  }
  const unsupported = profiles.filter((profile) => {
    return typeof profile !== "string" || !supportedExportProfiles.includes(profile);
  });
  if (unsupported.length > 0) {
    throw new Error([
      `Unsupported export profile${unsupported.length === 1 ? "" : "s"}: ${unsupported.map(String).join(", ")}.`,
      "v1 supports social1080 and archiveH264 only.",
      "ProRes, HEVC, and cloud upload are not supported yet."
    ].join(" "));
  }
  return Array.from(new Set(profiles));
}
function helperSearchPaths(explicitPath, overridePaths) {
  const defaults = [
    "/Applications/Filmtone.app/Contents/MacOS/FilmtoneAutomationCLI",
    "/Applications/Filmtone.app/Contents/Helpers/FilmtoneAutomationCLI",
    resolve2(homedir2(), "Applications/Filmtone.app/Contents/MacOS/FilmtoneAutomationCLI"),
    resolve2(homedir2(), "Applications/Filmtone.app/Contents/Helpers/FilmtoneAutomationCLI")
  ];
  const candidates = [
    explicitPath,
    ...overridePaths ?? defaults
  ].filter(Boolean);
  return Array.from(new Set(candidates.map((candidate) => resolve2(expandHome2(candidate)))));
}
function helperSetupMessage(paths) {
  return [
    "Filmtone helper CLI not found.",
    "",
    "Searched:",
    ...paths.map((path) => `  ${redactHome2(path)}`),
    "",
    "To resolve:",
    "  1. Install Filmtone Desktop with the automation helper.",
    "  2. Or set FILMTONE_AUTOMATION_CLI to a local FilmtoneAutomationCLI build.",
    "",
    "This Codex plugin v0.1.0 detects helpers only; it does not bundle the Filmtone desktop binary or proprietary LUTs."
  ].join("\n");
}
function inferLutRootFromHelper(helperPath) {
  const marker = "/Contents/";
  const index = helperPath.lastIndexOf(marker);
  if (index < 0) return void 0;
  const contentsDir = helperPath.slice(0, index + marker.length - 1);
  const candidate = resolve2(contentsDir, "Resources/CreativeLuts");
  return existsSync2(candidate) ? candidate : void 0;
}
function expandHome2(path) {
  if (path === "~") return homedir2();
  if (path.startsWith("~/")) return resolve2(homedir2(), path.slice(2));
  return path;
}
function redactHome2(path) {
  const home = homedir2();
  return path === home ? "~" : path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
}
var AutomationClient = class {
  cliPath;
  lutRoot;
  pathPolicy;
  planSecret;
  checkedCliPaths;
  constructor(options = {}) {
    const explicitCliPath = options.cliPath ?? process.env.FILMTONE_AUTOMATION_CLI;
    this.checkedCliPaths = helperSearchPaths(explicitCliPath, options.helperSearchPaths);
    this.cliPath = this.checkedCliPaths.find((candidate) => existsSync2(candidate));
    this.lutRoot = options.lutRoot ?? process.env.FILMTONE_CREATIVE_LUT_ROOT;
    this.pathPolicy = options.pathPolicy ?? new FilmtonePathPolicy(options.pathPolicyOptions);
    this.planSecret = options.planSecret ?? randomBytes(32).toString("hex");
  }
  requireHelper() {
    const helperPath = this.cliPath ?? this.checkedCliPaths.find((candidate) => existsSync2(candidate));
    if (helperPath) return helperPath;
    throw new Error(helperSetupMessage(this.checkedCliPaths));
  }
  inspectSources(request) {
    const safeRequest = validateInspectSourcesRequest(request, this.pathPolicy);
    return this.runJSON("inspectSources", { inspectSources: safeRequest });
  }
  answerContext(request) {
    const safeRequest = validateAnswerContextRequest(request, this.pathPolicy);
    return this.runJSON("answerContext", { answerContext: safeRequest });
  }
  previewBatch(request) {
    const safeRequest = validateBatchPlanRequest(request, this.pathPolicy);
    return this.runJSON("previewBatch", { previewBatch: safeRequest });
  }
  spawnRunBatch(plan, overwrite) {
    const helperPath = this.requireHelper();
    this.validateSignedPlanForRun(plan);
    const child = spawn(helperPath, {
      cwd: dirname2(helperPath),
      env: this.env(true, helperPath),
      stdio: ["pipe", "pipe", "pipe"]
    });
    child.stdin.end(JSON.stringify({
      command: "runBatch",
      runBatch: {
        plan,
        overwrite
      }
    }));
    return child;
  }
  signPlan(plan) {
    this.validatePlanPaths(plan);
    const security = {
      schemaVersion: 1,
      issuer: "filmtone-codex-mcp",
      expiresAtIso: new Date(Date.now() + MCP_LIMITS.previewTtlMs).toISOString(),
      signature: ""
    };
    security.signature = signPlanPayload(plan, security, this.planSecret);
    return {
      ...plan,
      items: plan.items.map((item) => ({ ...item, warnings: [...item.warnings] })),
      warnings: [...plan.warnings],
      security
    };
  }
  runJSON(command, payload) {
    const helperPath = this.requireHelper();
    const result = spawnSync(helperPath, {
      cwd: dirname2(helperPath),
      input: JSON.stringify({ command, ...payload }),
      encoding: "utf8",
      env: this.env(false, helperPath),
      maxBuffer: MCP_LIMITS.maxStdoutBytes
    });
    if (result.status !== 0 && !result.stdout.trim()) {
      throw new Error(result.stderr.trim() || `Filmtone automation command failed: ${command}`);
    }
    const parsed = JSON.parse(result.stdout);
    if (!parsed.ok) {
      throw new Error(parsed.error.message);
    }
    return parsed.result;
  }
  validateSignedPlanForRun(plan) {
    this.validatePlanPaths(plan);
    if (!plan.security) {
      throw new Error("Batch plan is missing its Filmtone MCP security signature. Run preview_batch_job again.");
    }
    if (new Date(plan.security.expiresAtIso).getTime() <= Date.now()) {
      throw new Error("Batch plan security signature expired. Run preview_batch_job again.");
    }
    const expected = signPlanPayload(plan, {
      schemaVersion: plan.security.schemaVersion,
      issuer: plan.security.issuer,
      expiresAtIso: plan.security.expiresAtIso,
      signature: ""
    }, this.planSecret);
    if (expected !== plan.security.signature) {
      throw new Error("Batch plan security signature is invalid. Run preview_batch_job again.");
    }
  }
  validatePlanPaths(plan) {
    for (const [index, item] of plan.items.entries()) {
      this.pathPolicy.validateSourcePaths([item.sourcePath], `plan.items[${index}].sourcePath`);
      this.pathPolicy.validateOutputPath(item.outputPath, `plan.items[${index}].outputPath`);
      if (!supportedExportProfiles.includes(item.profile)) {
        throw new Error(`Unsupported export profile in plan item ${index}: ${String(item.profile)}`);
      }
    }
  }
  env(includePlanSecret, helperPath) {
    const allowedEnvKeys = [
      "HOME",
      "PATH",
      "TMPDIR",
      "USER",
      "LOGNAME",
      "LANG",
      "LC_ALL",
      "LC_CTYPE",
      "DEVELOPER_DIR",
      "SDKROOT",
      "XCODE_DEVELOPER_DIR_PATH"
    ];
    const env = {};
    for (const key of allowedEnvKeys) {
      if (process.env[key] !== void 0) env[key] = process.env[key];
    }
    Object.assign(env, this.pathPolicy.env());
    const lutRoot = this.lutRoot ?? inferLutRootFromHelper(helperPath);
    if (lutRoot) env.FILMTONE_CREATIVE_LUT_ROOT = lutRoot;
    if (includePlanSecret) {
      env.FILMTONE_AUTOMATION_PLAN_SECRET = this.planSecret;
    }
    return env;
  }
};
var BatchJobManager = class {
  constructor(client) {
    this.client = client;
  }
  client;
  previews = /* @__PURE__ */ new Map();
  jobs = /* @__PURE__ */ new Map();
  createPreview(request) {
    this.prune();
    const preview = this.client.previewBatch(request);
    preview.plan = this.client.signPlan(preview.plan);
    const previewId = randomUUID();
    this.previews.set(previewId, { plan: preview.plan, createdAtMs: Date.now() });
    this.prune();
    return {
      previewId,
      preview
    };
  }
  start(previewId, overwrite) {
    this.prune();
    const preview = this.previews.get(previewId);
    if (!preview) {
      throw new Error("previewId is required and must come from preview_batch_job.");
    }
    if (this.runningJobCount() >= MCP_LIMITS.maxRunningJobs) {
      throw new Error(`Too many Filmtone batch jobs are running; the limit is ${MCP_LIMITS.maxRunningJobs}.`);
    }
    const jobId = randomUUID();
    const record = {
      id: jobId,
      status: "running",
      startedAtIso: (/* @__PURE__ */ new Date()).toISOString(),
      events: [],
      droppedEvents: 0,
      stderr: "",
      stderrTruncated: false
    };
    const child = this.client.spawnRunBatch(preview.plan, overwrite);
    record.process = child;
    record.timeout = setTimeout(() => {
      if (record.status === "running") {
        record.status = "failed";
        record.finishedAtIso = (/* @__PURE__ */ new Date()).toISOString();
        appendStderr(record, "Filmtone batch job timed out.\n");
        child.kill("SIGTERM");
      }
    }, MCP_LIMITS.jobTimeoutMs);
    record.timeout.unref?.();
    this.jobs.set(jobId, record);
    this.prune();
    let stdoutBuffer = "";
    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk.toString("utf8");
      if (Buffer.byteLength(stdoutBuffer, "utf8") > MCP_LIMITS.maxStdoutBytes) {
        appendJobEvent(record, { event: "error", message: "Filmtone automation output exceeded the MCP safety limit." });
        record.status = "failed";
        record.finishedAtIso = (/* @__PURE__ */ new Date()).toISOString();
        child.kill("SIGTERM");
        stdoutBuffer = "";
        return;
      }
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          appendJobEvent(record, event);
          if (event.event === "jobFinished") {
            record.status = "completed";
          }
        } catch {
          appendJobEvent(record, { event: "unparsed", line });
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      appendStderr(record, chunk.toString("utf8"));
    });
    child.on("close", (code) => {
      record.finishedAtIso = (/* @__PURE__ */ new Date()).toISOString();
      if (record.timeout) clearTimeout(record.timeout);
      if (record.status === "cancelled") return;
      if (record.status !== "completed" || code !== 0) {
        record.status = "failed";
      }
    });
    return { jobId, status: record.status };
  }
  status(jobId) {
    this.prune();
    const record = this.jobs.get(jobId);
    if (!record) throw new Error(`Unknown batch job: ${jobId}`);
    return sanitizeJob(record);
  }
  cancel(jobId) {
    this.prune();
    const record = this.jobs.get(jobId);
    if (!record) throw new Error(`Unknown batch job: ${jobId}`);
    if (record.status === "running") {
      record.status = "cancelled";
      record.finishedAtIso = (/* @__PURE__ */ new Date()).toISOString();
      if (record.timeout) clearTimeout(record.timeout);
      record.process?.kill("SIGTERM");
    }
    return sanitizeJob(record);
  }
  summarize(jobId) {
    const record = this.status(jobId);
    const last = record.events.at(-1);
    return {
      jobId,
      status: record.status,
      startedAtIso: record.startedAtIso,
      finishedAtIso: record.finishedAtIso,
      eventCount: record.events.length,
      droppedEvents: record.droppedEvents,
      lastEvent: last,
      stderr: record.stderr.trim(),
      stderrTruncated: record.stderrTruncated
    };
  }
  prune() {
    const now = Date.now();
    for (const [previewId, preview] of this.previews) {
      if (now - preview.createdAtMs > MCP_LIMITS.previewTtlMs) this.previews.delete(previewId);
    }
    while (this.previews.size > MCP_LIMITS.maxPreviewCount) {
      const oldest = this.previews.keys().next().value;
      if (!oldest) break;
      this.previews.delete(oldest);
    }
    for (const [jobId, job] of this.jobs) {
      if (job.status !== "running" && job.finishedAtIso) {
        const finishedAt = new Date(job.finishedAtIso).getTime();
        if (Number.isFinite(finishedAt) && now - finishedAt > MCP_LIMITS.jobTtlMs) {
          this.jobs.delete(jobId);
        }
      }
    }
    while (this.jobs.size > MCP_LIMITS.maxJobCount) {
      const removable = [...this.jobs.entries()].find(([, job]) => job.status !== "running");
      if (!removable) break;
      this.jobs.delete(removable[0]);
    }
  }
  runningJobCount() {
    return [...this.jobs.values()].filter((job) => job.status === "running").length;
  }
};
function sanitizeJob(record) {
  const { process: _process, timeout: _timeout, ...rest } = record;
  return { ...rest };
}
function validateInspectSourcesRequest(request, policy) {
  const payload = assertPlainObject(request, "inspect_sources arguments");
  assertAllowedKeys(payload, ["paths", "recursive"], "inspect_sources arguments");
  return {
    paths: policy.validateSourcePaths(payload.paths),
    recursive: readOptionalBoolean(payload.recursive, "recursive")
  };
}
function validateAnswerContextRequest(request, policy) {
  const payload = assertPlainObject(request, "prepare_filmtone_answer_context arguments");
  assertAllowedKeys(payload, ["question", "paths", "recursive"], "prepare_filmtone_answer_context arguments");
  return {
    question: readRequiredString(payload.question, "question", MCP_LIMITS.maxQuestionLength),
    paths: policy.validateOptionalSourcePaths(payload.paths),
    recursive: readOptionalBoolean(payload.recursive, "recursive")
  };
}
function validateJobIdRequest(request, field) {
  const payload = assertPlainObject(request, `${field} arguments`);
  assertAllowedKeys(payload, field === "previewId" ? ["previewId", "overwrite"] : [field], `${field} arguments`);
  return readRequiredId(payload[field], field);
}
function validateStartBatchJobRequest(request) {
  const payload = assertPlainObject(request, "start_batch_job arguments");
  assertAllowedKeys(payload, ["previewId", "overwrite"], "start_batch_job arguments");
  return {
    previewId: readRequiredId(payload.previewId, "previewId"),
    overwrite: readOptionalBoolean(payload.overwrite, "overwrite")
  };
}
function appendJobEvent(record, event) {
  if (record.events.length >= MCP_LIMITS.maxJobEvents) {
    record.events.shift();
    record.droppedEvents += 1;
  }
  record.events.push(event);
}
function appendStderr(record, text) {
  record.stderr += text;
  const bytes = Buffer.byteLength(record.stderr, "utf8");
  if (bytes <= MCP_LIMITS.maxStderrBytes) return;
  record.stderr = record.stderr.slice(-MCP_LIMITS.maxStderrBytes);
  record.stderrTruncated = true;
}
function signPlanPayload(plan, security, secret) {
  return createHmac("sha256", secret).update(planSignaturePayload(plan, security)).digest("hex");
}
function planSignaturePayload(plan, security) {
  const parts = [];
  pushPart(parts, String(security.schemaVersion));
  pushPart(parts, security.issuer);
  pushPart(parts, security.expiresAtIso);
  pushPart(parts, plan.createdAtIso);
  pushPart(parts, plan.look.requested ?? "");
  pushPart(parts, plan.look.label);
  pushPart(parts, plan.look.presetName);
  pushPart(parts, formatNumber(plan.look.presetStrength));
  pushPart(parts, plan.look.lookSlug ?? "");
  pushPart(parts, String(plan.profiles.length));
  for (const profile of plan.profiles) pushPart(parts, profile);
  pushPart(parts, String(plan.options.overwrite));
  pushPart(parts, String(plan.options.continueOnError));
  pushPart(parts, String(plan.options.recursive));
  pushPart(parts, String(plan.items.length));
  for (const item of plan.items) {
    pushPart(parts, item.sourcePath);
    pushPart(parts, item.outputPath);
    pushPart(parts, item.profile);
    pushPart(parts, item.status);
    pushPart(parts, item.reason ?? "");
    pushDimensions(parts, item.sourceDisplaySize);
    pushDimensions(parts, item.outputSize);
    pushPart(parts, item.durationSeconds === void 0 ? "" : formatNumber(item.durationSeconds));
    pushPart(parts, item.nominalFrameRate === void 0 ? "" : formatNumber(item.nominalFrameRate));
    pushPart(parts, item.hasAudio === void 0 ? "" : String(item.hasAudio));
    pushPart(parts, String(item.warnings.length));
    for (const warning of item.warnings) pushPart(parts, warning);
  }
  pushPart(parts, String(plan.warnings.length));
  for (const warning of plan.warnings) pushPart(parts, warning);
  return parts.join("|");
}
function pushDimensions(parts, dimensions) {
  pushPart(parts, dimensions ? String(dimensions.width) : "");
  pushPart(parts, dimensions ? String(dimensions.height) : "");
}
function pushPart(parts, value) {
  parts.push(`${Buffer.byteLength(value, "utf8")}:${value}`);
}
function formatNumber(value) {
  return Number.isFinite(value) ? value.toFixed(6) : "";
}
export {
  AutomationClient,
  BatchJobManager,
  validateBatchPlanRequest,
  validateJobIdRequest,
  validateStartBatchJobRequest
};
