import { existsSync, realpathSync } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, relative, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";

export const MCP_LIMITS = {
  maxPaths: 128,
  maxPathLength: 4096,
  maxQuestionLength: 4000,
  maxLookLength: 120,
  maxIdLength: 128,
  maxProfiles: 2,
  maxPreviewCount: 100,
  maxJobCount: 50,
  maxRunningJobs: 2,
  maxJobEvents: 1000,
  maxStderrBytes: 64 * 1024,
  maxStdoutBytes: 8 * 1024 * 1024,
  maxScanFiles: 500,
  previewTtlMs: 30 * 60 * 1000,
  jobTtlMs: 6 * 60 * 60 * 1000,
  jobTimeoutMs: 6 * 60 * 60 * 1000,
} as const;

const sensitiveComponents = new Set([
  ".aws",
  ".azure",
  ".config",
  ".docker",
  ".gnupg",
  ".kube",
  ".ssh",
  ".zsh_history",
  ".bash_history",
]);

export class FilmtoneMcpInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FilmtoneMcpInputError";
  }
}

export class FilmtoneMcpSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FilmtoneMcpSecurityError";
  }
}

export type PathPolicyOptions = {
  sourceRoots?: string[];
  outputRoots?: string[];
  maxPaths?: number;
  maxPathLength?: number;
  maxScanFiles?: number;
  allowAnyPath?: boolean;
};

export class FilmtonePathPolicy {
  readonly sourceRoots: string[];
  readonly outputRoots: string[];
  readonly maxPaths: number;
  readonly maxPathLength: number;
  readonly maxScanFiles: number;
  readonly allowAnyPath: boolean;

  constructor(options: PathPolicyOptions = {}, env: NodeJS.ProcessEnv = process.env) {
    this.maxPaths = options.maxPaths ?? MCP_LIMITS.maxPaths;
    this.maxPathLength = options.maxPathLength ?? MCP_LIMITS.maxPathLength;
    this.maxScanFiles = options.maxScanFiles
      ?? parsePositiveInt(env.FILMTONE_MCP_MAX_SCAN_FILES)
      ?? MCP_LIMITS.maxScanFiles;
    this.allowAnyPath = options.allowAnyPath ?? env.FILMTONE_MCP_ALLOW_ANY_PATH === "1";
    this.sourceRoots = canonicalRoots(
      options.sourceRoots
        ?? parsePathList(env.FILMTONE_MCP_ALLOWED_SOURCE_ROOTS)
        ?? defaultSourceRoots()
    );
    this.outputRoots = canonicalRoots(
      options.outputRoots
        ?? parsePathList(env.FILMTONE_MCP_ALLOWED_OUTPUT_ROOTS)
        ?? defaultOutputRoots()
    );
  }

  validateSourcePaths(paths: unknown, label = "paths"): string[] {
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

  validateOptionalSourcePaths(paths: unknown, label = "paths"): string[] | undefined {
    if (paths === undefined) return undefined;
    return this.validateSourcePaths(paths, label);
  }

  validateOutputDirectory(path: unknown): string | undefined {
    if (path === undefined) return undefined;
    if (typeof path !== "string") {
      throw new FilmtoneMcpInputError("outputDirectory must be a string path.");
    }
    return this.validatePath(path, "output", "outputDirectory");
  }

  validateOutputPath(path: unknown, label = "outputPath"): string {
    if (typeof path !== "string") {
      throw new FilmtoneMcpInputError(`${label} must be a string path.`);
    }
    const canonical = this.validatePath(path, "output", label);
    if (!canonical.toLowerCase().endsWith(".mp4")) {
      throw new FilmtoneMcpSecurityError(`${label} must be an .mp4 output path.`);
    }
    return canonical;
  }

  env(): Record<string, string> {
    return {
      FILMTONE_MCP_ALLOWED_SOURCE_ROOTS: this.sourceRoots.join(delimiter),
      FILMTONE_MCP_ALLOWED_OUTPUT_ROOTS: this.outputRoots.join(delimiter),
      FILMTONE_MCP_MAX_SCAN_FILES: String(this.maxScanFiles),
    };
  }

  private validatePath(input: string, kind: "source" | "output", label: string): string {
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
        `Set ${kind === "source" ? "FILMTONE_MCP_ALLOWED_SOURCE_ROOTS" : "FILMTONE_MCP_ALLOWED_OUTPUT_ROOTS"} to grant access explicitly.`,
      ].join(" "));
    }
    return canonical;
  }
}

export function assertPlainObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new FilmtoneMcpInputError(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

export function assertAllowedKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) {
    throw new FilmtoneMcpInputError(`${label} contains unsupported field(s): ${unknown.join(", ")}.`);
  }
}

export function readOptionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new FilmtoneMcpInputError(`${label} must be a boolean.`);
  }
  return value;
}

export function readRequiredString(value: unknown, label: string, maxLength: number): string {
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

export function readOptionalString(value: unknown, label: string, maxLength: number): string | undefined {
  if (value === undefined) return undefined;
  return readRequiredString(value, label, maxLength);
}

export function readOptionalNumber(value: unknown, label: string, min: number, max: number): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new FilmtoneMcpInputError(`${label} must be a finite number.`);
  }
  if (value < min || value > max) {
    throw new FilmtoneMcpInputError(`${label} must be between ${min} and ${max}.`);
  }
  return value;
}

export function readRequiredId(value: unknown, label: string): string {
  const id = readRequiredString(value, label, MCP_LIMITS.maxIdLength);
  if (!/^[0-9a-fA-F-]{8,128}$/.test(id)) {
    throw new FilmtoneMcpInputError(`${label} must be a Filmtone MCP id returned by a previous tool call.`);
  }
  return id;
}

function defaultSourceRoots(): string[] {
  const home = homedir();
  return [
    process.cwd(),
    tmpdir(),
    "/tmp",
    resolve(home, "Movies"),
    resolve(home, "Pictures"),
    resolve(home, "Desktop"),
    resolve(home, "Downloads"),
    "/Volumes",
  ];
}

function defaultOutputRoots(): string[] {
  const home = homedir();
  return [
    process.cwd(),
    tmpdir(),
    "/tmp",
    resolve(home, "Movies"),
    resolve(home, "Pictures"),
    resolve(home, "Desktop"),
    resolve(home, "Downloads"),
    "/Volumes",
  ];
}

function parsePathList(value: string | undefined): string[] | undefined {
  if (!value?.trim()) return undefined;
  const paths = value
    .split(new RegExp(`[\\n${escapeForCharClass(delimiter)}]`))
    .map((entry) => entry.trim())
    .filter(Boolean);
  return paths.length > 0 ? paths : undefined;
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function canonicalRoots(paths: string[]): string[] {
  return Array.from(new Set(paths.map(canonicalizePath))).sort();
}

function validatePathString(path: string, label: string, maxPathLength: number): void {
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

function canonicalizePath(path: string): string {
  const absolute = resolve(expandHome(path));
  let probe = absolute;
  const missing: string[] = [];
  while (!existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) break;
    missing.unshift(basename(probe));
    probe = parent;
  }
  const base = existsSync(probe) ? realpathSync.native(probe) : probe;
  return resolve(base, ...missing);
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return path;
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function isSensitivePath(path: string): boolean {
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
    resolve(home, ".docker"),
  ].map(canonicalizePath);

  if (sensitiveRoots.some((root) => path === root || (root !== "/" && isWithin(root, path)))) {
    return true;
  }
  return path.split("/").some((part) => sensitiveComponents.has(part));
}

function redactHome(path: string): string {
  const home = homedir();
  return path === home ? "~" : path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
}

function escapeForCharClass(value: string): string {
  return value.replace(/[\\\]\-^]/g, "\\$&");
}
