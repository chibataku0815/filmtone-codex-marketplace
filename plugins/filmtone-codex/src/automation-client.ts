import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import {
  assertAllowedKeys,
  assertPlainObject,
  FilmtoneMcpInputError,
  FilmtonePathPolicy,
  MCP_LIMITS,
  readOptionalBoolean,
  readOptionalNumber,
  readOptionalString,
  readRequiredId,
  readRequiredString,
  type PathPolicyOptions,
} from "./security.js";

export type ExportProfile = "social1080" | "archiveH264";

const supportedExportProfiles: ExportProfile[] = ["social1080", "archiveH264"];

export function validateBatchPlanRequest(request: unknown, policy = new FilmtonePathPolicy()): BatchPlanRequest {
  const payload = assertPlainObject(request, "planRequest");
  assertAllowedKeys(payload, [
    "paths",
    "recursive",
    "outputDirectory",
    "look",
    "strength",
    "profiles",
    "overwrite",
    "continueOnError",
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
    continueOnError: readOptionalBoolean(payload.continueOnError, "continueOnError"),
  };
}

function validateProfiles(profiles: unknown): ExportProfile[] | undefined {
  if (profiles === undefined) return undefined;
  if (!Array.isArray(profiles)) {
    throw new Error(
      "Export profiles must be an array. v1 supports social1080 and archiveH264 only. ProRes, HEVC, and cloud upload are not supported yet."
    );
  }
  if (profiles.length > MCP_LIMITS.maxProfiles) {
    throw new FilmtoneMcpInputError(`profiles contains ${profiles.length} entries; the limit is ${MCP_LIMITS.maxProfiles}.`);
  }
  const unsupported = profiles.filter((profile) => {
    return typeof profile !== "string"
      || !supportedExportProfiles.includes(profile as ExportProfile);
  });
  if (unsupported.length > 0) {
    throw new Error([
      `Unsupported export profile${unsupported.length === 1 ? "" : "s"}: ${unsupported.map(String).join(", ")}.`,
      "v1 supports social1080 and archiveH264 only.",
      "ProRes, HEVC, and cloud upload are not supported yet.",
    ].join(" "));
  }
  return Array.from(new Set(profiles as ExportProfile[]));
}

function helperSearchPaths(explicitPath?: string, overridePaths?: string[]): string[] {
  const defaults = [
    "/Applications/Filmtone.app/Contents/MacOS/FilmtoneAutomationCLI",
    "/Applications/Filmtone.app/Contents/Helpers/FilmtoneAutomationCLI",
    resolve(homedir(), "Applications/Filmtone.app/Contents/MacOS/FilmtoneAutomationCLI"),
    resolve(homedir(), "Applications/Filmtone.app/Contents/Helpers/FilmtoneAutomationCLI"),
  ];
  const candidates = [
    explicitPath,
    ...(overridePaths ?? defaults),
  ].filter(Boolean) as string[];
  return Array.from(new Set(candidates.map((candidate) => resolve(expandHome(candidate)))));
}

function helperSetupMessage(paths: string[]): string {
  return [
    "Filmtone helper CLI not found.",
    "",
    "Searched:",
    ...paths.map((path) => `  ${redactHome(path)}`),
    "",
    "To resolve:",
    "  1. Install Filmtone Desktop with the automation helper.",
    "  2. Or set FILMTONE_AUTOMATION_CLI to a local FilmtoneAutomationCLI build.",
    "",
    "This Codex plugin v0.1.0 detects helpers only; it does not bundle the Filmtone desktop binary or proprietary LUTs.",
  ].join("\n");
}

function inferLutRootFromHelper(helperPath: string): string | undefined {
  const marker = "/Contents/";
  const index = helperPath.lastIndexOf(marker);
  if (index < 0) return undefined;
  const contentsDir = helperPath.slice(0, index + marker.length - 1);
  const candidate = resolve(contentsDir, "Resources/CreativeLuts");
  return existsSync(candidate) ? candidate : undefined;
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return path;
}

function redactHome(path: string): string {
  const home = homedir();
  return path === home ? "~" : path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
}

export type InspectSourcesRequest = {
  paths: string[];
  recursive?: boolean;
};

export type AnswerContextRequest = {
  question: string;
  paths?: string[];
  recursive?: boolean;
};

export type BatchPlanRequest = {
  paths: string[];
  recursive?: boolean;
  outputDirectory?: string;
  look?: string;
  strength?: number;
  profiles?: ExportProfile[];
  overwrite?: boolean;
  continueOnError?: boolean;
};

export type BatchPlan = {
  createdAtIso: string;
  look: {
    requested?: string;
    label: string;
    presetName: string;
    presetStrength: number;
    lookSlug?: string;
  };
  profiles: ExportProfile[];
  options: {
    overwrite: boolean;
    continueOnError: boolean;
    recursive: boolean;
  };
  items: Array<{
    sourcePath: string;
    outputPath: string;
    profile: ExportProfile;
    status: "ready" | "skipped" | "blocked";
    reason?: string;
    sourceDisplaySize?: Dimensions;
    outputSize?: Dimensions;
    durationSeconds?: number;
    nominalFrameRate?: number;
    hasAudio?: boolean;
    warnings: string[];
  }>;
  warnings: string[];
  security?: BatchPlanSecurity;
};

type Dimensions = {
  width: number;
  height: number;
};

type BatchPlanSecurity = {
  schemaVersion: 1;
  issuer: "filmtone-codex-mcp";
  expiresAtIso: string;
  signature: string;
};

export type AutomationClientOptions = {
  cliPath?: string;
  helperSearchPaths?: string[];
  lutRoot?: string;
  pathPolicy?: FilmtonePathPolicy;
  pathPolicyOptions?: PathPolicyOptions;
  planSecret?: string;
};

type AutomationSuccess<T> = {
  ok: true;
  result: T;
};

type AutomationFailure = {
  ok: false;
  error: {
    code: string;
    message: string;
  };
};

type AutomationResponse<T> = AutomationSuccess<T> | AutomationFailure;

export class AutomationClient {
  readonly cliPath?: string;
  readonly lutRoot?: string;
  readonly pathPolicy: FilmtonePathPolicy;
  private readonly planSecret: string;
  private readonly checkedCliPaths: string[];

  constructor(options: AutomationClientOptions = {}) {
    const explicitCliPath = options.cliPath ?? process.env.FILMTONE_AUTOMATION_CLI;
    this.checkedCliPaths = helperSearchPaths(explicitCliPath, options.helperSearchPaths);
    this.cliPath = this.checkedCliPaths.find((candidate) => existsSync(candidate));
    this.lutRoot = options.lutRoot ?? process.env.FILMTONE_CREATIVE_LUT_ROOT;
    this.pathPolicy = options.pathPolicy ?? new FilmtonePathPolicy(options.pathPolicyOptions);
    this.planSecret = options.planSecret ?? randomBytes(32).toString("hex");
  }

  requireHelper(): string {
    const helperPath = this.cliPath ?? this.checkedCliPaths.find((candidate) => existsSync(candidate));
    if (helperPath) return helperPath;
    throw new Error(helperSetupMessage(this.checkedCliPaths));
  }

  inspectSources(request: unknown): unknown {
    const safeRequest = validateInspectSourcesRequest(request, this.pathPolicy);
    return this.runJSON("inspectSources", { inspectSources: safeRequest });
  }

  answerContext(request: unknown): unknown {
    const safeRequest = validateAnswerContextRequest(request, this.pathPolicy);
    return this.runJSON("answerContext", { answerContext: safeRequest });
  }

  previewBatch(request: unknown): { plan: BatchPlan; warnings: string[]; analysisLimits: unknown } {
    const safeRequest = validateBatchPlanRequest(request, this.pathPolicy);
    return this.runJSON("previewBatch", { previewBatch: safeRequest }) as {
      plan: BatchPlan;
      warnings: string[];
      analysisLimits: unknown;
    };
  }

  spawnRunBatch(plan: BatchPlan, overwrite?: boolean): ChildProcessWithoutNullStreams {
    const helperPath = this.requireHelper();
    this.validateSignedPlanForRun(plan);
    const child = spawn(helperPath, {
      cwd: dirname(helperPath),
      env: this.env(true, helperPath),
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin.end(JSON.stringify({
      command: "runBatch",
      runBatch: {
        plan,
        overwrite,
      },
    }));
    return child;
  }

  signPlan(plan: BatchPlan): BatchPlan {
    this.validatePlanPaths(plan);
    const security: BatchPlanSecurity = {
      schemaVersion: 1,
      issuer: "filmtone-codex-mcp",
      expiresAtIso: new Date(Date.now() + MCP_LIMITS.previewTtlMs).toISOString(),
      signature: "",
    };
    security.signature = signPlanPayload(plan, security, this.planSecret);
    return {
      ...plan,
      items: plan.items.map((item) => ({ ...item, warnings: [...item.warnings] })),
      warnings: [...plan.warnings],
      security,
    };
  }

  private runJSON(command: string, payload: Record<string, unknown>): unknown {
    const helperPath = this.requireHelper();
    const result = spawnSync(helperPath, {
      cwd: dirname(helperPath),
      input: JSON.stringify({ command, ...payload }),
      encoding: "utf8",
      env: this.env(false, helperPath),
      maxBuffer: MCP_LIMITS.maxStdoutBytes,
    });
    if (result.status !== 0 && !result.stdout.trim()) {
      throw new Error(result.stderr.trim() || `Filmtone automation command failed: ${command}`);
    }
    const parsed = JSON.parse(result.stdout) as AutomationResponse<unknown>;
    if (!parsed.ok) {
      throw new Error(parsed.error.message);
    }
    return parsed.result;
  }

  private validateSignedPlanForRun(plan: BatchPlan): void {
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
      signature: "",
    }, this.planSecret);
    if (expected !== plan.security.signature) {
      throw new Error("Batch plan security signature is invalid. Run preview_batch_job again.");
    }
  }

  private validatePlanPaths(plan: BatchPlan): void {
    for (const [index, item] of plan.items.entries()) {
      this.pathPolicy.validateSourcePaths([item.sourcePath], `plan.items[${index}].sourcePath`);
      this.pathPolicy.validateOutputPath(item.outputPath, `plan.items[${index}].outputPath`);
      if (!supportedExportProfiles.includes(item.profile)) {
        throw new Error(`Unsupported export profile in plan item ${index}: ${String(item.profile)}`);
      }
    }
  }

  private env(includePlanSecret: boolean, helperPath: string): NodeJS.ProcessEnv {
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
      "XCODE_DEVELOPER_DIR_PATH",
    ];
    const env: NodeJS.ProcessEnv = {};
    for (const key of allowedEnvKeys) {
      if (process.env[key] !== undefined) env[key] = process.env[key];
    }
    Object.assign(env, this.pathPolicy.env());
    const lutRoot = this.lutRoot ?? inferLutRootFromHelper(helperPath);
    if (lutRoot) env.FILMTONE_CREATIVE_LUT_ROOT = lutRoot;
    if (includePlanSecret) {
      env.FILMTONE_AUTOMATION_PLAN_SECRET = this.planSecret;
    }
    return env;
  }
}

export type JobStatus = "running" | "completed" | "failed" | "cancelled";

export type BatchJobRecord = {
  id: string;
  status: JobStatus;
  startedAtIso: string;
  finishedAtIso?: string;
  events: unknown[];
  droppedEvents: number;
  stderr: string;
  stderrTruncated: boolean;
  process?: ChildProcessWithoutNullStreams;
  timeout?: ReturnType<typeof setTimeout>;
};

export class BatchJobManager {
  private readonly previews = new Map<string, { plan: BatchPlan; createdAtMs: number }>();
  private readonly jobs = new Map<string, BatchJobRecord>();

  constructor(readonly client: AutomationClient) {}

  createPreview(request: unknown): { previewId: string; preview: unknown } {
    this.prune();
    const preview = this.client.previewBatch(request);
    preview.plan = this.client.signPlan(preview.plan);
    const previewId = randomUUID();
    this.previews.set(previewId, { plan: preview.plan, createdAtMs: Date.now() });
    this.prune();
    return {
      previewId,
      preview,
    };
  }

  start(previewId: string, overwrite?: boolean): { jobId: string; status: JobStatus } {
    this.prune();
    const preview = this.previews.get(previewId);
    if (!preview) {
      throw new Error("previewId is required and must come from preview_batch_job.");
    }
    if (this.runningJobCount() >= MCP_LIMITS.maxRunningJobs) {
      throw new Error(`Too many Filmtone batch jobs are running; the limit is ${MCP_LIMITS.maxRunningJobs}.`);
    }
    const jobId = randomUUID();
    const record: BatchJobRecord = {
      id: jobId,
      status: "running",
      startedAtIso: new Date().toISOString(),
      events: [],
      droppedEvents: 0,
      stderr: "",
      stderrTruncated: false,
    };
    const child = this.client.spawnRunBatch(preview.plan, overwrite);
    record.process = child;
    record.timeout = setTimeout(() => {
      if (record.status === "running") {
        record.status = "failed";
        record.finishedAtIso = new Date().toISOString();
        appendStderr(record, "Filmtone batch job timed out.\n");
        child.kill("SIGTERM");
      }
    }, MCP_LIMITS.jobTimeoutMs);
    record.timeout.unref?.();
    this.jobs.set(jobId, record);
    this.prune();

    let stdoutBuffer = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString("utf8");
      if (Buffer.byteLength(stdoutBuffer, "utf8") > MCP_LIMITS.maxStdoutBytes) {
        appendJobEvent(record, { event: "error", message: "Filmtone automation output exceeded the MCP safety limit." });
        record.status = "failed";
        record.finishedAtIso = new Date().toISOString();
        child.kill("SIGTERM");
        stdoutBuffer = "";
        return;
      }
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line) as { event?: string };
          appendJobEvent(record, event);
          if (event.event === "jobFinished") {
            record.status = "completed";
          }
        } catch {
          appendJobEvent(record, { event: "unparsed", line });
        }
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      appendStderr(record, chunk.toString("utf8"));
    });
    child.on("close", (code) => {
      record.finishedAtIso = new Date().toISOString();
      if (record.timeout) clearTimeout(record.timeout);
      if (record.status === "cancelled") return;
      if (record.status !== "completed" || code !== 0) {
        record.status = "failed";
      }
    });
    return { jobId, status: record.status };
  }

  status(jobId: string): BatchJobRecord {
    this.prune();
    const record = this.jobs.get(jobId);
    if (!record) throw new Error(`Unknown batch job: ${jobId}`);
    return sanitizeJob(record);
  }

  cancel(jobId: string): BatchJobRecord {
    this.prune();
    const record = this.jobs.get(jobId);
    if (!record) throw new Error(`Unknown batch job: ${jobId}`);
    if (record.status === "running") {
      record.status = "cancelled";
      record.finishedAtIso = new Date().toISOString();
      if (record.timeout) clearTimeout(record.timeout);
      record.process?.kill("SIGTERM");
    }
    return sanitizeJob(record);
  }

  summarize(jobId: string): unknown {
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
      stderrTruncated: record.stderrTruncated,
    };
  }

  private prune(): void {
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

  private runningJobCount(): number {
    return [...this.jobs.values()].filter((job) => job.status === "running").length;
  }
}

function sanitizeJob(record: BatchJobRecord): BatchJobRecord {
  const { process: _process, timeout: _timeout, ...rest } = record;
  return { ...rest };
}

function validateInspectSourcesRequest(request: unknown, policy: FilmtonePathPolicy): InspectSourcesRequest {
  const payload = assertPlainObject(request, "inspect_sources arguments");
  assertAllowedKeys(payload, ["paths", "recursive"], "inspect_sources arguments");
  return {
    paths: policy.validateSourcePaths(payload.paths),
    recursive: readOptionalBoolean(payload.recursive, "recursive"),
  };
}

function validateAnswerContextRequest(request: unknown, policy: FilmtonePathPolicy): AnswerContextRequest {
  const payload = assertPlainObject(request, "prepare_filmtone_answer_context arguments");
  assertAllowedKeys(payload, ["question", "paths", "recursive"], "prepare_filmtone_answer_context arguments");
  return {
    question: readRequiredString(payload.question, "question", MCP_LIMITS.maxQuestionLength),
    paths: policy.validateOptionalSourcePaths(payload.paths),
    recursive: readOptionalBoolean(payload.recursive, "recursive"),
  };
}

export function validateJobIdRequest(request: unknown, field: "previewId" | "jobId"): string {
  const payload = assertPlainObject(request, `${field} arguments`);
  assertAllowedKeys(payload, field === "previewId" ? ["previewId", "overwrite"] : [field], `${field} arguments`);
  return readRequiredId(payload[field], field);
}

export function validateStartBatchJobRequest(request: unknown): { previewId: string; overwrite?: boolean } {
  const payload = assertPlainObject(request, "start_batch_job arguments");
  assertAllowedKeys(payload, ["previewId", "overwrite"], "start_batch_job arguments");
  return {
    previewId: readRequiredId(payload.previewId, "previewId"),
    overwrite: readOptionalBoolean(payload.overwrite, "overwrite"),
  };
}

function appendJobEvent(record: BatchJobRecord, event: unknown): void {
  if (record.events.length >= MCP_LIMITS.maxJobEvents) {
    record.events.shift();
    record.droppedEvents += 1;
  }
  record.events.push(event);
}

function appendStderr(record: BatchJobRecord, text: string): void {
  record.stderr += text;
  const bytes = Buffer.byteLength(record.stderr, "utf8");
  if (bytes <= MCP_LIMITS.maxStderrBytes) return;
  record.stderr = record.stderr.slice(-MCP_LIMITS.maxStderrBytes);
  record.stderrTruncated = true;
}

function signPlanPayload(plan: BatchPlan, security: BatchPlanSecurity, secret: string): string {
  return createHmac("sha256", secret)
    .update(planSignaturePayload(plan, security))
    .digest("hex");
}

function planSignaturePayload(plan: BatchPlan, security: BatchPlanSecurity): string {
  const parts: string[] = [];
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
    pushPart(parts, item.durationSeconds === undefined ? "" : formatNumber(item.durationSeconds));
    pushPart(parts, item.nominalFrameRate === undefined ? "" : formatNumber(item.nominalFrameRate));
    pushPart(parts, item.hasAudio === undefined ? "" : String(item.hasAudio));
    pushPart(parts, String(item.warnings.length));
    for (const warning of item.warnings) pushPart(parts, warning);
  }
  pushPart(parts, String(plan.warnings.length));
  for (const warning of plan.warnings) pushPart(parts, warning);
  return parts.join("|");
}

function pushDimensions(parts: string[], dimensions: Dimensions | undefined): void {
  pushPart(parts, dimensions ? String(dimensions.width) : "");
  pushPart(parts, dimensions ? String(dimensions.height) : "");
}

function pushPart(parts: string[], value: string): void {
  parts.push(`${Buffer.byteLength(value, "utf8")}:${value}`);
}

function formatNumber(value: number): string {
  return Number.isFinite(value) ? value.toFixed(6) : "";
}
