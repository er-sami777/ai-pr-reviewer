# 🤖 AI PR Reviewer Agent (GitHub + Groq API)

An enterprise-grade, highly scalable Pull Request Reviewer built with **React**, **Vite**, **Tailwind CSS**, and powered by the **Groq API** utilizing Alibaba's elite **`qwen/qwen3-32b`** and Meta's **`llama-3.3-70b-versatile`** models.

---

## 🌟 Features

- **Blazing Fast Reviews**: Powered by Groq's LPU inference engine for near-instantaneous code review feedback.
- **Smart Token Optimization**: Built-in diff filters remove binary assets and unoptimized lockfiles (`package-lock.json`, `yarn.lock`), and automatically truncate massive diffs to prevent `413 Request too large` errors on the Groq Free Tier.
- **Dual Execution Workflows**:
  - **Option A**: A glassmorphic interactive Web UI allowing developers to explore file diffs, curate feedback, append custom user findings, and chat conversationally with the AI about the PR.
  - **Option B**: A self-contained, fully autonomous Node.js script designed for local CLI runner testing, headless servers, and native **GitHub Actions CI/CD** integration.
- **Unified Configuration**: Fully supports a local `.env` configuration file for persistent API keys and global review guidelines, which can be dynamically overridden inside the Web UI.

---

## 🏗️ Architecture & Workflows

### **Option B: Autonomous Reviewer Script & GitHub Actions**
Designed specifically for teams looking for an automated workflow directly embedded in their development lifecycle.

#### **1. Standalone CLI Reviewer Script (`scripts/github_reviewer.js`)**
The application includes a fully written, self-contained Node.js execution runner that can be invoked natively from your terminal. It directly parses your local `.env` file for configuration and connects directly to the GitHub REST API.

**Local Usage:**
```bash
# 1. Define your API keys in the root .env file:
# VITE_GROQ_API_KEY=gsk_...
# VITE_GITHUB_TOKEN=ghp_...

# 2. Execute directly against any live GitHub Pull Request:
REPO_OWNER=facebook REPO_NAME=react PR_NUMBER=28900 node scripts/github_reviewer.js
```

#### **2. Native GitHub Actions Integration**
To automatically audit every single Pull Request submitted to your repositories, embed the reviewer script into a simple Actions workflow.

**Repository Secrets Setup:**
In your target repository, navigate to **Settings** > **Secrets and variables** > **Actions** and add `GROQ_API_KEY`.

**Workflow File (`.github/workflows/ai-pr-reviewer.yml`):**
```yaml
name: Autonomous AI Pull Request Reviewer

on:
  pull_request:
    types: [opened, synchronize, reopened]

jobs:
  autonomous-review:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    
    steps:
      - name: Checkout Repository
        uses: actions/checkout@v4

      - name: Setup Node.js Environment
        uses: actions/setup-node@v4
        with:
          node-version: 18

      - name: Install Groq SDK Dependency
        run: npm install groq-sdk

      - name: Execute Autonomous PR Review Runner
        env:
          GROQ_API_KEY: ${{ secrets.GROQ_API_KEY }}
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          DEFAULT_MODEL: "qwen/qwen3-32b"
          CUSTOM_GUIDELINES: "Demand clean code, explicit types, and strict security patterns."
          REPO_OWNER: ${{ github.repository_owner }}
          REPO_NAME: ${{ github.event.repository.name }}
          PR_NUMBER: ${{ github.event.pull_request.number }}
        run: |
          node scripts/github_reviewer.js
```

---

### **Option A: Interactive Web UI**
If you prefer a visual interface to curate your reviews before publishing them, the workspace includes a complete single-page application dashboard.

1. **Input**: Enter any PR Link or manually provide the Owner, Repo, and PR Number.
2. **Review Profiles**: Select specialized audit personas:
   - 🌟 **Comprehensive Audit**
   - 🔒 **Security Focus**
   - ⚡ **Performance Optimization**
   - 🧹 **Refactoring & Cleanliness**
3. **Curate Findings**: Toggle specific issues on/off, delete false positives, or append your own custom review findings natively.
4. **Chat with PR**: A fully conversational interface that allows you to ask targeted questions about the codebase context directly to the Qwen3-32B model.
5. **Publish**: Click **"Post Review to GitHub"** to securely append the complete curated Markdown report directly to the Pull Request.

---

## 🚀 Getting Started

### **Prerequisites**
- **Node.js** (v18+ recommended)
- **Groq API Key**: Obtain a free API key from the [Groq Cloud Console](https://console.groq.com/keys).
- **GitHub Token (PAT)**: Create a token at [GitHub Settings -> Tokens](https://github.com/settings/tokens) with the `repo` scope to enable seamless posting.

### **Installation**

1. **Clone the repository**:
   ```bash
   git clone https://github.com/your-username/ai-pr-reviewer.git
   cd ai-pr-reviewer
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Establish Configuration**:
   ```bash
   cp .env.example .env
   ```
   *Edit `.env` to supply your persistent defaults.*

4. **Start the local Web UI**:
   ```bash
   npm run dev
   ```
   Navigate to `http://localhost:5173`

---

## 🛡️ Security & Privacy

- **Client-Side Storage**: In Option A, your credentials reside exclusively inside your local browser storage (`localStorage`) or local `.env` variables and communicate directly with the official Groq/GitHub APIs.
- **Serverless Automation**: Option B operates completely serverless inside secure CI/CD runners without caching proprietary codebases.

---

## 📄 License

This project is open-source and licensed under the **MIT License**.
