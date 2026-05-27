# 📜 Team Coding Standards & Review Guidelines

This Markdown file defines the **mandatory coding standards** that the AI Reviewer Agent will use to perform its first level of code review across all Pull Requests. Edit this file to customize the rules according to your team or project requirements.

---

## 🔒 Security Standards

- **Never accept hardcoded credentials, API keys, JWT tokens, or database passwords** in source code.
- All user inputs must be **validated and sanitized** to prevent SQL/NoSQL injection.
- Authentication endpoints must enforce **rate limiting** and **brute-force protection**.
- Sensitive data (passwords, tokens) must be **encrypted at rest** and **only transmitted via TLS/HTTPS**.
- Avoid using `eval()`, `exec()`, or dynamic code execution without strict input validation.
- All external API calls must include explicit **timeout handling** and **retry logic with exponential backoff**.

---

## ⚡ Performance Standards

- Avoid **N+1 database query patterns**. Use eager loading, batch fetching, or join queries.
- Memoize expensive pure functions and avoid recomputing identical operations inside loops.
- For React/Vue components, prevent **unnecessary re-renders** by leveraging memoization (`React.memo`, `useMemo`, `useCallback`).
- Profile any function exceeding **100ms execution time** and optimize hot paths.
- Avoid blocking the main event loop with synchronous I/O operations.
- Use efficient data structures (`Set`, `Map`) for lookups instead of nested array `.find()` calls.

---

## 🧹 Code Quality & Cleanliness

- **Single Responsibility Principle**: Each function should do exactly one thing well.
- Functions exceeding **30 lines** should be refactored into smaller composable units.
- Naming must be **explicit and intention-revealing** (no abbreviations like `tmp`, `usr`, `cfg`).
- Eliminate code duplication; if a block of code appears more than twice, extract it.
- Prefer **early returns** over deeply nested `if/else` blocks.
- Strictly avoid **magic numbers and magic strings** — define them as named constants.
- Use **type hints** in Python and explicit **TypeScript types** in JavaScript/TypeScript.

---

## 🧪 Testing Standards

- Every new function or class should have **at least one unit test** covering the happy path.
- **Edge cases** (empty inputs, null values, boundary conditions) must be explicitly tested.
- New API endpoints must have **integration tests** validating success and error responses.
- Maintain a minimum **code coverage of 80%** for all new contributions.
- Use **fixtures or factories** instead of duplicating test data.

---

## 📚 Documentation Standards

- Public functions and classes must include **docstrings** explaining their purpose, parameters, and return values.
- Complex business logic must include **inline comments** explaining the "why," not just the "what."
- Add **type signatures** for all function parameters and return types.
- Update **API documentation** whenever endpoints are added, removed, or modified.

---

## 🔄 Git & Pull Request Hygiene

- Commit messages must follow **Conventional Commits** style (`feat:`, `fix:`, `chore:`, `refactor:`, etc.).
- PR titles must be **descriptive and concise**, summarizing the change in one clear sentence.
- Each PR should focus on **a single feature or fix** — split unrelated changes into separate PRs.
- All PRs must include a **clear description** explaining the motivation and approach.

---

## ❌ Forbidden Patterns

- Use of `console.log()` or `print()` statements left in production code.
- Empty `catch` blocks that silently swallow errors.
- Use of `var` (use `let` or `const` instead in JavaScript).
- Mutation of function parameters.
- Hardcoded paths or environment-specific configuration in source files (use environment variables).

---

## 💡 Review Severity Levels

When the AI reviewer flags issues, it should classify them using this severity matrix:

- **🔴 Error** — Critical defects that will likely cause runtime failures, security breaches, or data corruption. Must be fixed before merge.
- **🟡 Warning** — Significant issues that violate standards or could cause future problems. Strongly recommended to fix.
- **🔵 Info** — Stylistic observations or minor improvements that improve clarity but are not blocking.
- **💡 Suggestion** — Optional refactoring ideas to enhance maintainability or performance.

---

*Edit this Markdown file freely to tailor the AI reviewer to your specific team or organizational needs!*
