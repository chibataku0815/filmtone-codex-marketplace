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
export {
  FilmtoneMcpInputError,
  FilmtoneMcpSecurityError,
  FilmtonePathPolicy,
  MCP_LIMITS,
  assertAllowedKeys,
  assertPlainObject,
  readOptionalBoolean,
  readOptionalNumber,
  readOptionalString,
  readRequiredId,
  readRequiredString
};
