#!/usr/bin/env bun

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const CONFIG_DIR = join(homedir(), ".config", "gitlab-mcp-server");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");
const DESC_MAX = 300;
const NOTE_MAX = 200;
const CACHE_TTL = 120_000;
const PAGE_SIZE = 20;
const SERVER_NAME = "gitlab";
const SERVER_VERSION = "1.0.0";
const GITLAB_API_PATH = "/api/v4";

interface GitLabProfile {
  name: string;
  baseUrl: string;
  token: string;
  defaultProject?: string;
}

interface GitLabConfig {
  activeProfile?: string;
  profiles: GitLabProfile[];
}

interface GitLabUser {
  id: number;
  username: string;
  name: string;
  web_url?: string;
}

interface GitLabNamespace {
  full_path?: string;
}

interface GitLabProject {
  id: number;
  name: string;
  path_with_namespace: string;
  description: string | null;
  web_url: string;
  default_branch: string | null;
  visibility: string;
  archived: boolean;
  namespace?: GitLabNamespace;
}

interface GitLabIssue {
  id: number;
  iid: number;
  title: string;
  description: string | null;
  state: string;
  labels: string[];
  web_url: string;
  author?: { name: string; username: string };
  assignees?: Array<{ name: string; username: string }>;
  milestone?: { title: string } | null;
  created_at: string;
  updated_at: string;
}

interface GitLabNote {
  id: number;
  body: string;
  created_at: string;
  system: boolean;
  author?: { name: string; username: string };
}

interface GitLabMergeRequest {
  id: number;
  iid: number;
  title: string;
  description: string | null;
  state: string;
  web_url: string;
  source_branch: string;
  target_branch: string;
  author?: { name: string; username: string };
  assignees?: Array<{ name: string; username: string }>;
  reviewers?: Array<{ name: string; username: string }>;
  created_at: string;
  updated_at: string;
}

interface ProjectCacheEntry {
  expiresAt: number;
  project: GitLabProject;
}

const projectCache = new Map<string, ProjectCacheEntry>();

function okText(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function truncate(value: string | null | undefined, max: number): string {
  if (!value) return "";
  return value.length <= max ? value : `${value.slice(0, max)}...`;
}

function compactText(value: string | null | undefined, max: number): string {
  return truncate((value ?? "").replace(/\s+/g, " ").trim(), max);
}

function maskToken(token: string): string {
  if (!token) return "(empty)";
  if (token.length <= 10) return `${token.slice(0, 2)}***${token.slice(-2)}`;
  return `${token.slice(0, 5)}***${token.slice(-4)}`;
}

function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  if (!trimmed) throw new Error("baseUrl is required");
  const normalized = trimmed.startsWith("http://") || trimmed.startsWith("https://")
    ? trimmed
    : `https://${trimmed}`;
  return normalized.replace(/\/+$/, "");
}

function buildApiBaseUrl(baseUrl: string): string {
  return `${normalizeBaseUrl(baseUrl)}${GITLAB_API_PATH}`;
}

function formatDate(value: string | null | undefined): string {
  return value ? value.slice(0, 16).replace("T", " ") : "-";
}

function formatPeople(people: Array<{ name: string; username: string }> | undefined): string {
  if (!people?.length) return "none";
  return people.map((person) => `${person.name} (@${person.username})`).join(", ");
}

function formatProjectLine(project: GitLabProject): string {
  const defaultBranch = project.default_branch ? ` | branch: ${project.default_branch}` : "";
  const archived = project.archived ? " | ARCHIVED" : "";
  return `${project.id} | ${project.path_with_namespace} | ${project.visibility}${defaultBranch}${archived}`;
}

function formatProjectDetails(project: GitLabProject): string {
  const description = compactText(project.description, DESC_MAX) || "(empty)";
  return [
    `Project: ${project.name}`,
    `ID: ${project.id}`,
    `Path: ${project.path_with_namespace}`,
    `Visibility: ${project.visibility}`,
    `Default branch: ${project.default_branch ?? "(none)"}`,
    `Archived: ${project.archived ? "yes" : "no"}`,
    `URL: ${project.web_url}`,
    "",
    "Description:",
    description,
  ].join("\n");
}

function formatIssueCompact(issue: GitLabIssue): string {
  const labels = issue.labels.length ? ` [${issue.labels.join(", ")}]` : "";
  const assignees = issue.assignees?.length ? ` | assignees: ${issue.assignees.map((item) => item.username).join(",")}` : "";
  return `#${issue.iid} | ${issue.state} | ${issue.title}${labels}${assignees}`;
}

function formatIssueDetails(issue: GitLabIssue, notes: GitLabNote[]): string {
  const description = issue.description || "(empty)";
  const parts = [
    `Issue: ${issue.title}`,
    `IID: ${issue.iid}`,
    `State: ${issue.state}`,
    `Author: ${issue.author ? `${issue.author.name} (@${issue.author.username})` : "unknown"}`,
    `Assignees: ${formatPeople(issue.assignees)}`,
    `Milestone: ${issue.milestone?.title ?? "none"}`,
    `Labels: ${issue.labels.length ? issue.labels.join(", ") : "none"}`,
    `Created: ${formatDate(issue.created_at)}`,
    `Updated: ${formatDate(issue.updated_at)}`,
    `URL: ${issue.web_url}`,
    "",
    "Description:",
    description,
  ];

  if (notes.length) {
    parts.push("", "Recent notes:");
    for (const note of notes) {
      const author = note.author ? `${note.author.name} (@${note.author.username})` : "unknown";
      const badge = note.system ? " [system]" : "";
      parts.push(`  ${formatDate(note.created_at)} | ${author}${badge} | ${compactText(note.body, NOTE_MAX)}`);
    }
  }

  return parts.join("\n");
}

function formatMergeRequestCompact(mergeRequest: GitLabMergeRequest): string {
  const reviewers = mergeRequest.reviewers?.length ? ` | reviewers: ${mergeRequest.reviewers.map((item) => item.username).join(",")}` : "";
  return `!${mergeRequest.iid} | ${mergeRequest.state} | ${mergeRequest.title} | ${mergeRequest.source_branch} -> ${mergeRequest.target_branch}${reviewers}`;
}

function formatMergeRequestDetails(mergeRequest: GitLabMergeRequest, notes: GitLabNote[]): string {
  const description = mergeRequest.description || "(empty)";
  const parts = [
    `Merge request: ${mergeRequest.title}`,
    `IID: ${mergeRequest.iid}`,
    `State: ${mergeRequest.state}`,
    `Author: ${mergeRequest.author ? `${mergeRequest.author.name} (@${mergeRequest.author.username})` : "unknown"}`,
    `Assignees: ${formatPeople(mergeRequest.assignees)}`,
    `Reviewers: ${formatPeople(mergeRequest.reviewers)}`,
    `Branches: ${mergeRequest.source_branch} -> ${mergeRequest.target_branch}`,
    `Created: ${formatDate(mergeRequest.created_at)}`,
    `Updated: ${formatDate(mergeRequest.updated_at)}`,
    `URL: ${mergeRequest.web_url}`,
    "",
    "Description:",
    description,
  ];

  if (notes.length) {
    parts.push("", "Recent notes:");
    for (const note of notes) {
      const author = note.author ? `${note.author.name} (@${note.author.username})` : "unknown";
      const badge = note.system ? " [system]" : "";
      parts.push(`  ${formatDate(note.created_at)} | ${author}${badge} | ${compactText(note.body, NOTE_MAX)}`);
    }
  }

  return parts.join("\n");
}

async function ensureConfigDir(): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
}

async function readConfig(): Promise<GitLabConfig> {
  try {
    const raw = await readFile(CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<GitLabConfig>;
    return {
      activeProfile: parsed.activeProfile,
      profiles: Array.isArray(parsed.profiles)
        ? parsed.profiles.filter(isValidProfile)
        : [],
    };
  } catch (error) {
    if (isMissingFileError(error)) {
      return { profiles: [] };
    }
    throw new Error(`Failed to read config: ${getErrorMessage(error)}`);
  }
}

function isValidProfile(value: unknown): value is GitLabProfile {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<GitLabProfile>;
  return Boolean(candidate.name && candidate.baseUrl && candidate.token);
}

async function writeConfig(config: GitLabConfig): Promise<void> {
  await ensureConfigDir();
  const serialized = `${JSON.stringify(config, null, 2)}\n`;
  await writeFile(CONFIG_PATH, serialized, { mode: 0o600 });
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT");
}

function getProfileFromEnv(): GitLabProfile | null {
  const token = process.env.GITLAB_TOKEN?.trim();
  const baseUrl = process.env.GITLAB_BASE_URL?.trim();
  if (!token || !baseUrl) return null;
  return {
    name: process.env.GITLAB_PROFILE?.trim() || "env",
    baseUrl: normalizeBaseUrl(baseUrl),
    token,
    defaultProject: process.env.GITLAB_DEFAULT_PROJECT?.trim() || undefined,
  };
}

async function getActiveProfile(): Promise<GitLabProfile> {
  const envProfile = getProfileFromEnv();
  if (envProfile) return envProfile;

  const config = await readConfig();
  if (!config.profiles.length) {
    throw new Error(
      `No GitLab profile configured. Use set_gitlab_pat first. Config path: ${CONFIG_PATH}`,
    );
  }

  const activeName = config.activeProfile ?? config.profiles[0]?.name;
  const profile = config.profiles.find((item) => item.name === activeName);
  if (!profile) {
    throw new Error("Active GitLab profile is missing. Use list_gitlab_profiles or set_gitlab_pat.");
  }
  return profile;
}

async function saveProfile(input: GitLabProfile, makeActive: boolean): Promise<GitLabConfig> {
  const config = await readConfig();
  const normalizedProfile: GitLabProfile = {
    ...input,
    name: input.name.trim(),
    baseUrl: normalizeBaseUrl(input.baseUrl),
    token: input.token.trim(),
    defaultProject: input.defaultProject?.trim() || undefined,
  };

  const profiles = config.profiles.filter((item) => item.name !== normalizedProfile.name);
  profiles.push(normalizedProfile);
  profiles.sort((left, right) => left.name.localeCompare(right.name));

  const nextConfig: GitLabConfig = {
    activeProfile: makeActive || !config.activeProfile ? normalizedProfile.name : config.activeProfile,
    profiles,
  };

  await writeConfig(nextConfig);
  return nextConfig;
}

async function selectProfile(name: string): Promise<GitLabProfile> {
  const config = await readConfig();
  const profile = config.profiles.find((item) => item.name === name);
  if (!profile) throw new Error(`Profile not found: ${name}`);

  const nextConfig: GitLabConfig = {
    ...config,
    activeProfile: profile.name,
  };
  await writeConfig(nextConfig);
  return profile;
}

async function deleteProfile(name: string): Promise<GitLabConfig> {
  const config = await readConfig();
  const profiles = config.profiles.filter((item) => item.name !== name);
  if (profiles.length === config.profiles.length) {
    throw new Error(`Profile not found: ${name}`);
  }

  const nextConfig: GitLabConfig = {
    activeProfile: config.activeProfile === name ? profiles[0]?.name : config.activeProfile,
    profiles,
  };
  await writeConfig(nextConfig);
  return nextConfig;
}

function encodeProjectRef(projectRef: string): string {
  if (!projectRef.trim()) throw new Error("projectId or projectPath is required");
  return encodeURIComponent(projectRef.trim());
}

function projectCacheKey(baseUrl: string, projectRef: string): string {
  return `${normalizeBaseUrl(baseUrl)}::${projectRef}`;
}

async function gitlab<T>(
  profile: GitLabProfile,
  method: string,
  path: string,
  options: {
    query?: Record<string, string | number | boolean | undefined>;
    body?: Record<string, unknown>;
  } = {},
): Promise<T> {
  const url = new URL(`${buildApiBaseUrl(profile.baseUrl)}${path}`);

  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value === undefined || value === "") continue;
    url.searchParams.set(key, String(value));
  }

  const init: RequestInit = {
    method,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "PRIVATE-TOKEN": profile.token,
    },
  };

  if (options.body && method !== "GET") {
    init.body = JSON.stringify(options.body);
  }

  const response = await fetch(url, init);
  if (!response.ok) {
    const text = await response.text().catch(() => "unknown");
    throw new Error(`GitLab ${method} ${path} -> ${response.status}: ${text}`);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
}

async function resolveProject(profile: GitLabProfile, input: {
  projectId?: string;
  projectPath?: string;
}): Promise<GitLabProject> {
  const projectRef = input.projectId?.trim() || input.projectPath?.trim() || profile.defaultProject?.trim();
  if (!projectRef) {
    throw new Error("projectId or projectPath is required, or set defaultProject in the active profile");
  }

  const cacheKey = projectCacheKey(profile.baseUrl, projectRef);
  const cached = projectCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.project;
  }

  const project = await gitlab<GitLabProject>(
    profile,
    "GET",
    `/projects/${encodeProjectRef(projectRef)}`,
  );

  projectCache.set(cacheKey, {
    project,
    expiresAt: Date.now() + CACHE_TTL,
  });
  return project;
}

const ProfileInputSchema = {
  name: z.string().min(1).describe("Profile name"),
  baseUrl: z.string().min(1).describe("Self-hosted GitLab base URL"),
  token: z.string().min(1).describe("GitLab personal access token"),
  defaultProject: z.string().optional().describe("Default project ID or group/subgroup/project path"),
  makeActive: z.boolean().optional().default(true).describe("Set as active profile"),
};

const ProjectSelectorSchema = {
  projectId: z.string().optional().describe("GitLab project ID"),
  projectPath: z.string().optional().describe("GitLab project path like group/subgroup/repo"),
};

const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

server.tool(
  "set_gitlab_pat",
  "Save or update a self-hosted GitLab PAT profile in local config storage.",
  ProfileInputSchema,
  async ({ name, baseUrl, token, defaultProject, makeActive }) => {
    const config = await saveProfile({ name, baseUrl, token, defaultProject }, makeActive);
    const profile = config.profiles.find((item) => item.name === name);
    if (!profile) throw new Error(`Failed to save profile: ${name}`);

    const text = [
      `Saved GitLab profile: ${profile.name}`,
      `Base URL: ${profile.baseUrl}`,
      `Token: ${maskToken(profile.token)}`,
      `Default project: ${profile.defaultProject ?? "(none)"}`,
      `Active profile: ${config.activeProfile ?? "(none)"}`,
      `Config path: ${CONFIG_PATH}`,
    ].join("\n");

    return okText(text);
  },
);

server.tool(
  "list_gitlab_profiles",
  "List saved GitLab profiles and show which one is active. Tokens are masked.",
  {},
  async () => {
    const envProfile = getProfileFromEnv();
    const config = await readConfig();

    const lines: string[] = [];
    if (envProfile) {
      lines.push(`ENV OVERRIDE | ${envProfile.name} | ${envProfile.baseUrl} | token: ${maskToken(envProfile.token)} | default project: ${envProfile.defaultProject ?? "(none)"}`);
      lines.push("");
    }

    if (!config.profiles.length) {
      lines.push(`No saved profiles. Use set_gitlab_pat. Config path: ${CONFIG_PATH}`);
      return okText(lines.join("\n"));
    }

    lines.push(`Active profile: ${config.activeProfile ?? "(none)"}`);
    lines.push(`Config path: ${CONFIG_PATH}`);
    lines.push("");

    for (const profile of config.profiles) {
      const activeBadge = profile.name === config.activeProfile ? " [active]" : "";
      lines.push(`${profile.name}${activeBadge}`);
      lines.push(`  base: ${profile.baseUrl}`);
      lines.push(`  token: ${maskToken(profile.token)}`);
      lines.push(`  default project: ${profile.defaultProject ?? "(none)"}`);
    }

    return okText(lines.join("\n"));
  },
);

server.tool(
  "use_gitlab_profile",
  "Switch the active saved GitLab profile.",
  { name: z.string().min(1).describe("Saved profile name") },
  async ({ name }) => {
    const profile = await selectProfile(name);
    return okText(`Active GitLab profile: ${profile.name}\nBase URL: ${profile.baseUrl}`);
  },
);

server.tool(
  "delete_gitlab_profile",
  "Delete a saved GitLab profile from local config storage.",
  { name: z.string().min(1).describe("Saved profile name") },
  async ({ name }) => {
    const config = await deleteProfile(name);
    return okText(`Deleted GitLab profile: ${name}\nActive profile: ${config.activeProfile ?? "(none)"}`);
  },
);

server.tool(
  "get_authenticated_user",
  "Verify the active PAT and show the authenticated GitLab user.",
  {},
  async () => {
    const profile = await getActiveProfile();
    const user = await gitlab<GitLabUser>(profile, "GET", "/user");
    return okText([
      `Profile: ${profile.name}`,
      `Base URL: ${profile.baseUrl}`,
      `User: ${user.name} (@${user.username})`,
      `ID: ${user.id}`,
      `URL: ${user.web_url ?? "(none)"}`,
    ].join("\n"));
  },
);

server.tool(
  "get_projects",
  "List accessible projects from the active self-hosted GitLab account.",
  {
    search: z.string().optional().describe("Filter by project name/path"),
    membership: z.boolean().optional().default(true).describe("Only projects you are a member of"),
    owned: z.boolean().optional().default(false).describe("Only projects you own"),
    archived: z.boolean().optional().describe("Include archived projects"),
    page: z.number().int().min(1).optional().default(1).describe("Page number"),
    perPage: z.number().int().min(1).max(100).optional().default(PAGE_SIZE).describe("Projects per page"),
  },
  async ({ search, membership, owned, archived, page, perPage }) => {
    const profile = await getActiveProfile();
    const projects = await gitlab<GitLabProject[]>(profile, "GET", "/projects", {
      query: {
        search,
        membership,
        owned,
        archived,
        page,
        per_page: perPage,
        simple: true,
        order_by: "last_activity_at",
        sort: "desc",
      },
    });

    if (!projects.length) {
      return okText("No projects found.");
    }

    const lines = projects.map(formatProjectLine);
    return okText(`Projects (${projects.length}):\n${lines.join("\n")}`);
  },
);

server.tool(
  "get_project",
  "Get project details by project ID or path. Uses defaultProject if configured.",
  ProjectSelectorSchema,
  async ({ projectId, projectPath }) => {
    const profile = await getActiveProfile();
    const project = await resolveProject(profile, { projectId, projectPath });
    return okText(formatProjectDetails(project));
  },
);

server.tool(
  "get_issues",
  "List issues for a project with compact summaries.",
  {
    ...ProjectSelectorSchema,
    state: z.enum(["opened", "closed", "all"]).optional().default("opened").describe("Issue state filter"),
    assigneeUsername: z.string().optional().describe("Filter by assignee username"),
    labels: z.string().optional().describe("Comma-separated labels"),
    search: z.string().optional().describe("Search in issue title/description"),
    page: z.number().int().min(1).optional().default(1).describe("Page number"),
    perPage: z.number().int().min(1).max(100).optional().default(PAGE_SIZE).describe("Issues per page"),
  },
  async ({ projectId, projectPath, state, assigneeUsername, labels, search, page, perPage }) => {
    const profile = await getActiveProfile();
    const project = await resolveProject(profile, { projectId, projectPath });
    const issues = await gitlab<GitLabIssue[]>(profile, "GET", `/projects/${project.id}/issues`, {
      query: {
        state,
        assignee_username: assigneeUsername,
        labels,
        search,
        page,
        per_page: perPage,
        order_by: "updated_at",
        sort: "desc",
      },
    });

    if (!issues.length) {
      return okText(`No issues found for ${project.path_with_namespace}.`);
    }

    const lines = issues.map((issue) => formatIssueCompact(issue));
    return okText(`${project.path_with_namespace} issues (${issues.length}):\n${lines.join("\n")}`);
  },
);

server.tool(
  "get_issue",
  "Get full issue details including recent notes.",
  {
    ...ProjectSelectorSchema,
    issueIid: z.number().int().min(1).describe("Issue IID within the project"),
  },
  async ({ projectId, projectPath, issueIid }) => {
    const profile = await getActiveProfile();
    const project = await resolveProject(profile, { projectId, projectPath });
    const [issue, notes] = await Promise.all([
      gitlab<GitLabIssue>(profile, "GET", `/projects/${project.id}/issues/${issueIid}`),
      gitlab<GitLabNote[]>(profile, "GET", `/projects/${project.id}/issues/${issueIid}/notes`, {
        query: {
          page: 1,
          per_page: 10,
          sort: "desc",
        },
      }),
    ]);

    return okText(formatIssueDetails(issue, notes));
  },
);

server.tool(
  "create_issue",
  "Create a GitLab issue in a project.",
  {
    ...ProjectSelectorSchema,
    title: z.string().min(1).describe("Issue title"),
    description: z.string().optional().describe("Issue description"),
    labels: z.string().optional().describe("Comma-separated labels"),
    assigneeIds: z.array(z.number().int()).optional().describe("GitLab assignee user IDs"),
  },
  async ({ projectId, projectPath, title, description, labels, assigneeIds }) => {
    const profile = await getActiveProfile();
    const project = await resolveProject(profile, { projectId, projectPath });
    const issue = await gitlab<GitLabIssue>(profile, "POST", `/projects/${project.id}/issues`, {
      body: {
        title,
        description,
        labels,
        assignee_ids: assigneeIds,
      },
    });

    return okText([
      `Created issue in ${project.path_with_namespace}`,
      `IID: ${issue.iid}`,
      `Title: ${issue.title}`,
      `URL: ${issue.web_url}`,
    ].join("\n"));
  },
);

server.tool(
  "add_issue_note",
  "Add a note/comment to a GitLab issue.",
  {
    ...ProjectSelectorSchema,
    issueIid: z.number().int().min(1).describe("Issue IID within the project"),
    body: z.string().min(1).describe("Comment text"),
  },
  async ({ projectId, projectPath, issueIid, body }) => {
    const profile = await getActiveProfile();
    const project = await resolveProject(profile, { projectId, projectPath });
    const note = await gitlab<GitLabNote>(profile, "POST", `/projects/${project.id}/issues/${issueIid}/notes`, {
      body: { body },
    });

    return okText(`Added note to issue #${issueIid} in ${project.path_with_namespace}\nNote ID: ${note.id}`);
  },
);

server.tool(
  "get_merge_requests",
  "List merge requests for a project with compact summaries.",
  {
    ...ProjectSelectorSchema,
    state: z.enum(["opened", "closed", "locked", "merged", "all"]).optional().default("opened").describe("Merge request state filter"),
    assigneeUsername: z.string().optional().describe("Filter by assignee username"),
    search: z.string().optional().describe("Search in merge request title/description"),
    page: z.number().int().min(1).optional().default(1).describe("Page number"),
    perPage: z.number().int().min(1).max(100).optional().default(PAGE_SIZE).describe("Merge requests per page"),
  },
  async ({ projectId, projectPath, state, assigneeUsername, search, page, perPage }) => {
    const profile = await getActiveProfile();
    const project = await resolveProject(profile, { projectId, projectPath });
    const mergeRequests = await gitlab<GitLabMergeRequest[]>(profile, "GET", `/projects/${project.id}/merge_requests`, {
      query: {
        state,
        assignee_username: assigneeUsername,
        search,
        page,
        per_page: perPage,
        order_by: "updated_at",
        sort: "desc",
      },
    });

    if (!mergeRequests.length) {
      return okText(`No merge requests found for ${project.path_with_namespace}.`);
    }

    const lines = mergeRequests.map((mergeRequest) => formatMergeRequestCompact(mergeRequest));
    return okText(`${project.path_with_namespace} merge requests (${mergeRequests.length}):\n${lines.join("\n")}`);
  },
);

server.tool(
  "get_merge_request",
  "Get full merge request details including recent notes.",
  {
    ...ProjectSelectorSchema,
    mergeRequestIid: z.number().int().min(1).describe("Merge request IID within the project"),
  },
  async ({ projectId, projectPath, mergeRequestIid }) => {
    const profile = await getActiveProfile();
    const project = await resolveProject(profile, { projectId, projectPath });
    const [mergeRequest, notes] = await Promise.all([
      gitlab<GitLabMergeRequest>(profile, "GET", `/projects/${project.id}/merge_requests/${mergeRequestIid}`),
      gitlab<GitLabNote[]>(profile, "GET", `/projects/${project.id}/merge_requests/${mergeRequestIid}/notes`, {
        query: {
          page: 1,
          per_page: 10,
          sort: "desc",
        },
      }),
    ]);

    return okText(formatMergeRequestDetails(mergeRequest, notes));
  },
);

server.tool(
  "add_merge_request_note",
  "Add a note/comment to a GitLab merge request.",
  {
    ...ProjectSelectorSchema,
    mergeRequestIid: z.number().int().min(1).describe("Merge request IID within the project"),
    body: z.string().min(1).describe("Comment text"),
  },
  async ({ projectId, projectPath, mergeRequestIid, body }) => {
    const profile = await getActiveProfile();
    const project = await resolveProject(profile, { projectId, projectPath });
    const note = await gitlab<GitLabNote>(profile, "POST", `/projects/${project.id}/merge_requests/${mergeRequestIid}/notes`, {
      body: { body },
    });

    return okText(`Added note to merge request !${mergeRequestIid} in ${project.path_with_namespace}\nNote ID: ${note.id}`);
  },
);

// ── Pipeline types ──────────────────────────────────────────────────
interface GitLabPipeline {
  id: number;
  iid: number;
  status: string;
  ref: string;
  sha: string;
  web_url: string;
  created_at: string;
  updated_at: string;
  duration: number | null;
  source: string;
}

interface GitLabJob {
  id: number;
  name: string;
  stage: string;
  status: string;
  web_url: string;
  duration: number | null;
  started_at: string | null;
  finished_at: string | null;
  failure_reason: string | null;
  runner?: { description: string } | null;
}

function formatPipelineCompact(pipeline: GitLabPipeline): string {
  const duration = pipeline.duration ? ` | ${Math.round(pipeline.duration)}s` : "";
  return `#${pipeline.id} | ${pipeline.status} | ${pipeline.ref} | ${pipeline.sha.slice(0, 8)} | ${formatDate(pipeline.updated_at)}${duration}`;
}

function formatJobCompact(job: GitLabJob): string {
  const duration = job.duration ? ` | ${Math.round(job.duration)}s` : "";
  const failure = job.failure_reason ? ` | reason: ${job.failure_reason}` : "";
  return `${job.id} | ${job.stage} | ${job.name} | ${job.status}${duration}${failure}`;
}

// ── create_merge_request ─────────────────────────────────────────────
server.tool(
  "create_merge_request",
  "Create a GitLab merge request.",
  {
    ...ProjectSelectorSchema,
    title: z.string().min(1).describe("Merge request title"),
    sourceBranch: z.string().min(1).describe("Source branch name"),
    targetBranch: z.string().min(1).describe("Target branch name"),
    description: z.string().optional().describe("Merge request description"),
    assigneeIds: z.array(z.number().int()).optional().describe("GitLab assignee user IDs"),
    reviewerIds: z.array(z.number().int()).optional().describe("GitLab reviewer user IDs"),
    removeSourceBranch: z.boolean().optional().default(false).describe("Delete source branch when merged"),
    squash: z.boolean().optional().default(false).describe("Squash commits when merging"),
  },
  async ({ projectId, projectPath, title, sourceBranch, targetBranch, description, assigneeIds, reviewerIds, removeSourceBranch, squash }) => {
    const profile = await getActiveProfile();
    const project = await resolveProject(profile, { projectId, projectPath });
    const mergeRequest = await gitlab<GitLabMergeRequest>(profile, "POST", `/projects/${project.id}/merge_requests`, {
      body: {
        title,
        source_branch: sourceBranch,
        target_branch: targetBranch,
        description,
        assignee_ids: assigneeIds,
        reviewer_ids: reviewerIds,
        remove_source_branch: removeSourceBranch,
        squash,
      },
    });

    return okText([
      `Created merge request in ${project.path_with_namespace}`,
      `IID: ${mergeRequest.iid}`,
      `Title: ${mergeRequest.title}`,
      `Branches: ${mergeRequest.source_branch} -> ${mergeRequest.target_branch}`,
      `State: ${mergeRequest.state}`,
      `URL: ${mergeRequest.web_url}`,
    ].join("\n"));
  },
);

// ── get_pipelines ────────────────────────────────────────────────────
server.tool(
  "get_pipelines",
  "List recent pipelines for a project or branch.",
  {
    ...ProjectSelectorSchema,
    ref: z.string().optional().describe("Branch, tag, or commit SHA to filter by"),
    status: z.enum(["created", "waiting_for_resource", "preparing", "pending", "running", "success", "failed", "canceled", "skipped", "manual", "scheduled"]).optional().describe("Pipeline status filter"),
    page: z.number().int().min(1).optional().default(1).describe("Page number"),
    perPage: z.number().int().min(1).max(100).optional().default(PAGE_SIZE).describe("Pipelines per page"),
  },
  async ({ projectId, projectPath, ref, status, page, perPage }) => {
    const profile = await getActiveProfile();
    const project = await resolveProject(profile, { projectId, projectPath });
    const pipelines = await gitlab<GitLabPipeline[]>(profile, "GET", `/projects/${project.id}/pipelines`, {
      query: {
        ref,
        status,
        page,
        per_page: perPage,
        order_by: "updated_at",
        sort: "desc",
      },
    });

    if (!pipelines.length) {
      return okText(`No pipelines found for ${project.path_with_namespace}.`);
    }

    const lines = pipelines.map(formatPipelineCompact);
    return okText(`${project.path_with_namespace} pipelines (${pipelines.length}):\n${lines.join("\n")}`);
  },
);

// ── get_pipeline ─────────────────────────────────────────────────────
server.tool(
  "get_pipeline",
  "Get details of a specific pipeline including its jobs.",
  {
    ...ProjectSelectorSchema,
    pipelineId: z.number().int().min(1).describe("Pipeline ID"),
  },
  async ({ projectId, projectPath, pipelineId }) => {
    const profile = await getActiveProfile();
    const project = await resolveProject(profile, { projectId, projectPath });
    const [pipeline, jobs] = await Promise.all([
      gitlab<GitLabPipeline>(profile, "GET", `/projects/${project.id}/pipelines/${pipelineId}`),
      gitlab<GitLabJob[]>(profile, "GET", `/projects/${project.id}/pipelines/${pipelineId}/jobs`, {
        query: { per_page: 50 },
      }),
    ]);

    const duration = pipeline.duration ? `${Math.round(pipeline.duration)}s` : "(running)";
    const parts = [
      `Pipeline: #${pipeline.id}`,
      `Status: ${pipeline.status}`,
      `Ref: ${pipeline.ref}`,
      `SHA: ${pipeline.sha.slice(0, 8)}`,
      `Source: ${pipeline.source}`,
      `Duration: ${duration}`,
      `Created: ${formatDate(pipeline.created_at)}`,
      `Updated: ${formatDate(pipeline.updated_at)}`,
      `URL: ${pipeline.web_url}`,
    ];

    if (jobs.length) {
      const failed = jobs.filter((job) => job.status === "failed");
      const running = jobs.filter((job) => job.status === "running");
      parts.push("", `Jobs (${jobs.length} total, ${failed.length} failed, ${running.length} running):`);

      const relevant = [
        ...failed,
        ...running,
        ...jobs.filter((job) => !["failed", "running"].includes(job.status)),
      ].slice(0, 20);

      for (const job of relevant) {
        parts.push(`  ${formatJobCompact(job)}`);
      }

      if (jobs.length > 20) {
        parts.push(`  ... and ${jobs.length - 20} more`);
      }
    }

    return okText(parts.join("\n"));
  },
);

// ── retry_pipeline ───────────────────────────────────────────────────
server.tool(
  "retry_pipeline",
  "Retry a failed pipeline (retries all failed jobs).",
  {
    ...ProjectSelectorSchema,
    pipelineId: z.number().int().min(1).describe("Pipeline ID to retry"),
  },
  async ({ projectId, projectPath, pipelineId }) => {
    const profile = await getActiveProfile();
    const project = await resolveProject(profile, { projectId, projectPath });
    const pipeline = await gitlab<GitLabPipeline>(profile, "POST", `/projects/${project.id}/pipelines/${pipelineId}/retry`);

    return okText([
      `Retried pipeline #${pipelineId} in ${project.path_with_namespace}`,
      `New status: ${pipeline.status}`,
      `URL: ${pipeline.web_url}`,
    ].join("\n"));
  },
);

// ── cancel_pipeline ──────────────────────────────────────────────────
server.tool(
  "cancel_pipeline",
  "Cancel a running pipeline.",
  {
    ...ProjectSelectorSchema,
    pipelineId: z.number().int().min(1).describe("Pipeline ID to cancel"),
  },
  async ({ projectId, projectPath, pipelineId }) => {
    const profile = await getActiveProfile();
    const project = await resolveProject(profile, { projectId, projectPath });
    const pipeline = await gitlab<GitLabPipeline>(profile, "POST", `/projects/${project.id}/pipelines/${pipelineId}/cancel`);

    return okText([
      `Cancelled pipeline #${pipelineId} in ${project.path_with_namespace}`,
      `Status: ${pipeline.status}`,
      `URL: ${pipeline.web_url}`,
    ].join("\n"));
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
