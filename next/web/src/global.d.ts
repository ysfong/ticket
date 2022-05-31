/// <reference types="vite/client" />

interface ImportMetaEnv {
  VITE_LC_APP_ID: string;
  VITE_LC_APP_KEY: string;
  VITE_LEANCLOUD_API_HOST: string;
  VITE_SENTRY_WEB_DSN: string;
  VITE_ENABLE_LEANCLOUD_INTEGRATION: string;
  VITE_ALGOLIA_API_KEY: string;
}

declare function docsearch(...args: any[]);
