/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_GROQ_API_KEY: string;
  readonly VITE_GITHUB_TOKEN: string;
  readonly VITE_DEFAULT_MODEL: string;
  readonly VITE_CUSTOM_GUIDELINES: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
