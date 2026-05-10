# ubik-mcp

Standalone MCP servers for UBIK fleet agents. Exposed as a single HTTP gateway on port 8902.

## Servers

| Server | Description |
|---|---|
| `github` | GitHub repos, PRs, issues |
| `linkedin` | Profile, posts, prospection |
| `google` | Gmail, Drive |
| `microsoft` | Outlook, OneDrive |
| `crawl` | Web scraping structuré |
| `review` | Code review AI-augmenté |
| `formation` | Automation UI écran |
| `skills` | Recherche skills UBIK |
| `system` | Status système UBIK |

## Usage

```bash
npm install
cp .env.example .env
npm start  # HTTP gateway on :8902
```
