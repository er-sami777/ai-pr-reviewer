# 🤖 AI PR Reviewer — FastAPI Backend

A headless, production-grade **Python FastAPI** service that performs **autonomous first-level code reviews** on GitHub Pull Requests using the **Groq AI API**. Operates entirely as a backend webhook receiver — no frontend required!

---

## 🌟 Features

- 🔌 **Native GitHub Webhook Receiver**: Subscribes to `pull_request` events and triggers AI reviews on `opened`, `reopened`, or `synchronize` actions.
- 🧠 **Groq AI Inference**: Leverages models like `qwen/qwen3-32b` or `llama-3.3-70b-versatile` for blazing-fast code analysis.
- 📜 **Customizable Coding Standards**: Define your team's exact coding rules in `coding_standards.md` — the AI strictly enforces them on every PR.
- 🔒 **HMAC Webhook Verification**: Validates all incoming webhook deliveries using SHA-256 signatures.
- 🔧 **Manual Trigger Endpoint**: REST endpoint for on-demand PR reviews via `POST /review`.
- ⚡ **Smart Token Optimization**: Auto-filters lockfiles, binary assets, and truncates massive diffs to fit Groq Free Tier limits.
- 🐳 **Container-Ready**: Includes Dockerfile and docker-compose.yml for instant deployment.

---

## 📐 Architecture

```
backend/
├── app/
│   ├── __init__.py
│   ├── main.py               # FastAPI app, endpoints, lifespan hooks
│   ├── config.py             # Pydantic settings + coding standards loader
│   ├── github_client.py      # GitHub REST API client (async)
│   ├── ai_reviewer.py        # Groq AI inference + diff optimization
│   ├── webhook_security.py   # HMAC signature verification
│   └── schemas.py            # Pydantic request/response models
├── coding_standards.md       # ✨ YOUR team coding standards (editable!)
├── requirements.txt
├── .env.example
├── Dockerfile
├── docker-compose.yml
└── README.md
```

### How First-Level AI Review Works
1. GitHub fires a `pull_request` webhook → `/webhook/github` endpoint.
2. Signature is validated against `GITHUB_WEBHOOK_SECRET`.
3. Background task fetches PR metadata and file patches from GitHub API.
4. Coding standards from `coding_standards.md` are injected into the Groq system prompt.
5. The AI model returns structured JSON containing issues, suggestions, and an overall assessment.
6. The review is formatted as beautiful Markdown and posted directly to the PR.

---

## 🚀 Quick Start

### 1. Clone & Install Dependencies

```bash
python -m venv venv
source venv/bin/activate          # On Windows: venv\Scripts\activate
pip install -r requirements.txt
```

### 2. Configure Environment

```bash
cp .env.example .env
```

Edit `.env` with your credentials:
```bash
GROQ_API_KEY=gsk_your_groq_api_key
GROQ_MODEL=qwen/qwen3-32b
GITHUB_TOKEN=ghp_your_github_token
GITHUB_WEBHOOK_SECRET=your_random_secret_here
```

### 3. Customize Your Coding Standards

Open `coding_standards.md` and tailor the rules to match your team's exact requirements. The AI agent will strictly enforce every rule defined here on every Pull Request!

### 4. Run the Service

**Development:**
```bash
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

**Production:**
```bash
python -m app.main
```

**With Docker:**
```bash
docker-compose up -d
```

The API will be live at `http://localhost:8000` with interactive docs at `http://localhost:8000/docs`.

---

## 🔌 GitHub Webhook Setup

1. Expose your server publicly (e.g., via [ngrok](https://ngrok.com/), Cloudflare Tunnel, or a deployed cloud host).

   ```bash
   ngrok http 8000
   ```

2. In your GitHub repository, go to **Settings → Webhooks → Add webhook**:
   - **Payload URL**: `https://your-public-url.com/webhook/github`
   - **Content type**: `application/json`
   - **Secret**: Match the value of `GITHUB_WEBHOOK_SECRET` in your `.env`
   - **Events**: Select **"Let me select individual events"** → check only **"Pull requests"**

3. Save the webhook and open a new PR — the AI agent will autonomously analyze it and post a structured first-level review!

---

## 🎯 API Endpoints

### `GET /`
Health check returning current configuration state.

**Response:**
```json
{
  "status": "healthy",
  "model": "qwen/qwen3-32b",
  "standards_loaded": true
}
```

---

### `GET /standards`
Returns the currently loaded coding standards Markdown.

---

### `POST /review`
Manually trigger an AI review for any Pull Request.

**Request Body:**
```json
{
  "owner": "facebook",
  "repo": "react",
  "pr_number": 28900,
  "auto_post": true
}
```

**Response:**
```json
{
  "summary": "Overall assessment of the PR...",
  "overallAssessment": "comment",
  "issues": [
    {
      "type": "warning",
      "file": "src/example.ts",
      "line": 42,
      "message": "Hardcoded API endpoint detected..."
    }
  ],
  "suggestions": ["Consider extracting the magic number into a constant..."],
  "was_truncated": false,
  "posted_to_github": true,
  "posted_comment_url": "https://github.com/facebook/react/pull/28900#issuecomment-..."
}
```

**Example with cURL:**
```bash
curl -X POST http://localhost:8000/review \
  -H "Content-Type: application/json" \
  -d '{
    "owner": "your-org",
    "repo": "your-repo",
    "pr_number": 42,
    "auto_post": true
  }'
```

---

### `POST /webhook/github`
GitHub webhook receiver — automatically invoked by GitHub on PR events.

**Headers Required:**
- `X-GitHub-Event: pull_request`
- `X-Hub-Signature-256: sha256=<signature>`

---

## 📜 Customizing Coding Standards

The `coding_standards.md` file is the heart of the AI reviewer's behavior. Edit it freely to enforce team-specific rules!

**Example sections you can customize:**
- Security requirements (e.g., mandatory input validation)
- Performance budgets (e.g., max function execution time)
- Naming conventions (e.g., kebab-case for files, PascalCase for components)
- Forbidden patterns (e.g., no `console.log`, no `eval()`)
- Testing requirements (e.g., min 80% code coverage)
- Documentation rules (e.g., required JSDoc on public APIs)

Each rule you define will be enforced strictly during every review.

---

## 🛡️ Security Notes

- **Always set `GITHUB_WEBHOOK_SECRET`** in production to prevent unauthorized review triggers.
- The `GITHUB_TOKEN` should be a fine-grained PAT with **only the necessary repository permissions** (`pull_requests:write`, `contents:read`).
- Never commit your `.env` file — it's already in `.gitignore`.
- Run the service behind HTTPS (use a reverse proxy like nginx or Traefik with TLS certificates).

---

## 🧠 Model Selection

The reviewer supports any Groq-compatible model. Adjust `GROQ_MODEL` in `.env`:

| Model | Speed | Token Capacity | Best For |
|---|---|---|---|
| `qwen/qwen3-32b` | Fast | Moderate | General-purpose reviews (default) |
| `llama-3.3-70b-versatile` | Medium | High | Large PRs with heavy diffs |
| `llama-3.1-8b-instant` | Ultra Fast | Low | Quick smoke checks |
| `deepseek-r1-distill-llama-70b` | Medium | High | Deep architectural reasoning |

---

## 🐳 Docker Deployment

```bash
docker-compose up -d --build
```

Logs:
```bash
docker-compose logs -f
```

Stop:
```bash
docker-compose down
```

---

## 📄 License

MIT License — free to use, modify, and redistribute.
