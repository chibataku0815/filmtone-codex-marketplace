import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { pathToFileURL } from "node:url";
import {
  AutomationClient,
  BatchJobManager,
  validateJobIdRequest,
  validateStartBatchJobRequest,
} from "./automation-client.js";
import { MCP_LIMITS } from "./security.js";

const jsonObjectSchema = {
  type: "object",
  additionalProperties: true,
} as const;

export const filmtoneTools: Tool[] = [
  {
    name: "inspect_sources",
    description: "Inspect media paths or folders for Filmtone batch/Q&A context. Returns metadata only; it does not analyze frame content.",
    inputSchema: {
      type: "object",
      required: ["paths"],
      properties: {
        paths: {
          type: "array",
          minItems: 1,
          maxItems: MCP_LIMITS.maxPaths,
          items: { type: "string", maxLength: MCP_LIMITS.maxPathLength },
        },
        recursive: { type: "boolean" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "prepare_filmtone_answer_context",
    description: "Prepare facts and limits for Codex to answer abstract Filmtone state/export questions. The tool does not call an LLM.",
    inputSchema: {
      type: "object",
      required: ["question"],
      properties: {
        question: { type: "string", minLength: 1, maxLength: MCP_LIMITS.maxQuestionLength },
        paths: {
          type: "array",
          minItems: 1,
          maxItems: MCP_LIMITS.maxPaths,
          items: { type: "string", maxLength: MCP_LIMITS.maxPathLength },
        },
        recursive: { type: "boolean" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "preview_batch_job",
    description: "Dry-run a Filmtone video batch export plan. Must be called before start_batch_job.",
    inputSchema: {
      type: "object",
      required: ["paths"],
      properties: {
        paths: {
          type: "array",
          minItems: 1,
          maxItems: MCP_LIMITS.maxPaths,
          items: { type: "string", maxLength: MCP_LIMITS.maxPathLength },
        },
        recursive: { type: "boolean" },
        outputDirectory: { type: "string", maxLength: MCP_LIMITS.maxPathLength },
        look: { type: "string", maxLength: MCP_LIMITS.maxLookLength },
        strength: { type: "number", minimum: 0, maximum: 1 },
        profiles: {
          description: "v1 supports social1080 and archiveH264 only. ProRes, HEVC, and cloud upload are not supported yet.",
          type: "array",
          maxItems: MCP_LIMITS.maxProfiles,
          items: { type: "string", enum: ["social1080", "archiveH264"] },
        },
        overwrite: { type: "boolean" },
        continueOnError: { type: "boolean" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "start_batch_job",
    description: "Start a previously previewed Filmtone video batch export job.",
    inputSchema: {
      type: "object",
      required: ["previewId"],
      properties: {
        previewId: { type: "string", maxLength: MCP_LIMITS.maxIdLength },
        overwrite: { type: "boolean" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_batch_job_status",
    description: "Return the current status and events for a running or completed Filmtone batch job.",
    inputSchema: {
      type: "object",
      required: ["jobId"],
      properties: {
        jobId: { type: "string", maxLength: MCP_LIMITS.maxIdLength },
      },
      additionalProperties: false,
    },
  },
  {
    name: "cancel_batch_job",
    description: "Cancel a running Filmtone batch export job.",
    inputSchema: {
      type: "object",
      required: ["jobId"],
      properties: {
        jobId: { type: "string", maxLength: MCP_LIMITS.maxIdLength },
      },
      additionalProperties: false,
    },
  },
  {
    name: "summarize_batch_job",
    description: "Summarize a Filmtone batch job for Codex after completion or failure.",
    inputSchema: {
      type: "object",
      required: ["jobId"],
      properties: {
        jobId: { type: "string", maxLength: MCP_LIMITS.maxIdLength },
      },
      additionalProperties: false,
    },
  },
];

export function createFilmtoneMcpServer(
  manager = new BatchJobManager(new AutomationClient())
): Server {
  const server = new Server(
    {
      name: "filmtone-codex-mcp",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: filmtoneTools,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    try {
      switch (name) {
        case "inspect_sources":
          return jsonResult(manager.client.inspectSources(args));
        case "prepare_filmtone_answer_context":
          return jsonResult(manager.client.answerContext(args));
        case "preview_batch_job":
          return jsonResult(manager.createPreview(args));
        case "start_batch_job": {
          const payload = validateStartBatchJobRequest(args);
          return jsonResult(manager.start(payload.previewId, payload.overwrite));
        }
        case "get_batch_job_status": {
          return jsonResult(manager.status(validateJobIdRequest(args, "jobId")));
        }
        case "cancel_batch_job": {
          return jsonResult(manager.cancel(validateJobIdRequest(args, "jobId")));
        }
        case "summarize_batch_job": {
          return jsonResult(manager.summarize(validateJobIdRequest(args, "jobId")));
        }
        default:
          throw new Error(`Unknown Filmtone MCP tool: ${name}`);
      }
    } catch (error) {
      return jsonResult({
        error: error instanceof Error ? error.message : String(error),
      }, true);
    }
  });

  return server;
}

function jsonResult(value: unknown, isError = false): CallToolResult {
  return {
    isError,
    content: [
      {
        type: "text",
        text: JSON.stringify(value ?? jsonObjectSchema, null, 2),
      },
    ],
  };
}

function isMainModule(): boolean {
  const entryPath = process.argv[1];
  return entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href;
}

if (isMainModule()) {
  const server = createFilmtoneMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
