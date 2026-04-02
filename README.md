# GitLab MCP Server

Token-optimized [Model Context Protocol](https://modelcontextprotocol.io/) server for **self-hosted GitLab** instances, designed for [Claude Code](https://claude.ai/claude-code).

## Features

- **Multi-profile PAT management** — switch between multiple GitLab instances
- **Compact text responses** — minimal token usage for LLM context
- **Project caching** — avoids redundant API calls (2min TTL)
- **Full GitLab workflow** — issues, merge requests, pipelines, notes
- **Env or config-file auth** — flexible credential management

## Setup

### 1. Install dependencies

```bash
bun install
```

### 2. Get a GitLab Personal Access Token

1. Go to your GitLab instance → **Settings** → **Access Tokens**
2. Create a token with scopes: `api`, `read_user`

### 3. Configure

**Option A: Environment variables**

```bash
export GITLAB_BASE_URL="https://gitlab.example.com"
export GITLAB_TOKEN="your-personal-access-token"
export GITLAB_DEFAULT_PROJECT="group/subgroup/repo"  # optional
```

**Option B: Use the `set_gitlab_pat` tool** at runtime — profiles are stored in `~/.config/gitlab-mcp-server/config.json` with `0600` permissions.

### 4. Add to Claude Code

Add to your `~/.claude/settings.json` or project `.claude/settings.json`:

```json
{
  "mcpServers": {
    "gitlab": {
      "command": "bun",
      "args": ["run", "/path/to/gitlab-mcp-server/index.ts"],
      "env": {
        "GITLAB_BASE_URL": "https://gitlab.example.com",
        "GITLAB_TOKEN": "your-personal-access-token",
        "GITLAB_DEFAULT_PROJECT": "group/subgroup/repo"
      }
    }
  }
}
```

## Available Tools

### Profile Management

| Tool | Description |
|------|-------------|
| `set_gitlab_pat` | Save or update a GitLab PAT profile |
| `list_gitlab_profiles` | List saved profiles (tokens masked) |
| `use_gitlab_profile` | Switch active profile |
| `delete_gitlab_profile` | Delete a saved profile |
| `get_authenticated_user` | Verify PAT and show current user |

### Projects

| Tool | Description |
|------|-------------|
| `get_projects` | List accessible projects (search, filter) |
| `get_project` | Get project details by ID or path |

### Issues

| Tool | Description |
|------|-------------|
| `get_issues` | List issues with filters (state, labels, assignee) |
| `get_issue` | Full issue details with recent notes |
| `create_issue` | Create a new issue |
| `add_issue_note` | Add a comment to an issue |

### Merge Requests

| Tool | Description |
|------|-------------|
| `get_merge_requests` | List MRs with filters (state, assignee) |
| `get_merge_request` | Full MR details with recent notes |
| `create_merge_request` | Create a new merge request |
| `add_merge_request_note` | Add a comment to a merge request |

### Pipelines

| Tool | Description |
|------|-------------|
| `get_pipelines` | List recent pipelines (filter by ref, status) |
| `get_pipeline` | Pipeline details with job breakdown |
| `retry_pipeline` | Retry all failed jobs in a pipeline |
| `cancel_pipeline` | Cancel a running pipeline |

## Multi-Instance Support

All tools use the active profile. Switch between GitLab instances:

```
# Save profiles
set_gitlab_pat(name: "work", baseUrl: "https://gitlab.company.com", token: "...")
set_gitlab_pat(name: "oss", baseUrl: "https://gitlab.com", token: "...")

# Switch
use_gitlab_profile(name: "work")
```

Projects can be referenced by ID or path:

```
projectId: "123"
projectPath: "group/subgroup/repo"
```

If `defaultProject` is set in the profile, it's used when neither is provided.

## License

MIT
