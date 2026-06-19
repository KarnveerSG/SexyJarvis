/** Integration definitions — keys stored in ~/.quill/.env */

const INTEGRATIONS = [
  {
    id: "github",
    name: "GitHub",
    desc: "Manage repos, issues, and pull requests.",
    keys: [{ env: "GITHUB_TOKEN", label: "Personal access token", placeholder: "ghp_..." }],
  },
  {
    id: "stripe",
    name: "Stripe",
    desc: "Payments, customers, invoices, and subscriptions.",
    keys: [{ env: "STRIPE_SECRET_KEY", label: "Secret key", placeholder: "sk_live_..." }],
  },
  {
    id: "sentry",
    name: "Sentry",
    desc: "Track issues, errors, and releases.",
    keys: [
      { env: "SENTRY_AUTH_TOKEN", label: "Auth token", placeholder: "sntrys_..." },
      { env: "SENTRY_DSN", label: "DSN (optional)", placeholder: "https://...@sentry.io/..." },
    ],
  },
  {
    id: "cloudflare",
    name: "Cloudflare",
    desc: "DNS, Workers, and zones.",
    keys: [{ env: "CLOUDFLARE_API_TOKEN", label: "API token", placeholder: "..." }],
  },
  {
    id: "posthog",
    name: "PostHog",
    desc: "Product analytics and events.",
    keys: [{ env: "POSTHOG_API_KEY", label: "Project API key", placeholder: "phc_..." }],
  },
  {
    id: "semrush",
    name: "Semrush",
    desc: "SEO keywords, domain analytics, and competitor research.",
    keys: [{ env: "SEMRUSH_API_KEY", label: "API key", placeholder: "..." }],
  },
  {
    id: "aws",
    name: "Amazon Web Services",
    desc: "EC2, S3, Lambda, and more.",
    keys: [
      { env: "AWS_ACCESS_KEY_ID", label: "Access key ID", placeholder: "AKIA..." },
      { env: "AWS_SECRET_ACCESS_KEY", label: "Secret access key", placeholder: "..." },
      { env: "AWS_DEFAULT_REGION", label: "Region", placeholder: "us-east-1" },
    ],
  },
  {
    id: "azure",
    name: "Microsoft Azure",
    desc: "Resource groups, VMs, and Azure services.",
    keys: [
      { env: "AZURE_CLIENT_ID", label: "Client ID", placeholder: "..." },
      { env: "AZURE_CLIENT_SECRET", label: "Client secret", placeholder: "..." },
      { env: "AZURE_TENANT_ID", label: "Tenant ID", placeholder: "..." },
    ],
  },
  {
    id: "gcp",
    name: "Google Cloud",
    desc: "Compute, storage, and GCP services.",
    keys: [
      { env: "GOOGLE_APPLICATION_CREDENTIALS", label: "Credentials JSON path", placeholder: "C:\\path\\to\\key.json" },
      { env: "GCP_PROJECT_ID", label: "Project ID", placeholder: "my-project" },
    ],
  },
];

const SETTINGS_SECTIONS = [
  { id: "models", label: "Models", icon: "◆" },
  { id: "identity", label: "Identity", icon: "◎" },
  { id: "appearance", label: "Appearance", icon: "◐" },
  { id: "voice", label: "Voice", icon: "♪" },
  { id: "integrations", label: "Integrations", icon: "⚡" },
  { id: "mcp", label: "MCP", icon: "⬡" },
  { id: "skills", label: "MCP Skills", icon: "✦", comingSoon: true },
  { id: "remote", label: "Remote Integration", icon: "↗", comingSoon: true },
  { id: "terminal", label: "Terminal", icon: "▭" },
  { id: "about", label: "About", icon: "i" },
];

const CORE_ENV_KEYS = [
  { env: "CURSOR_API_KEY", label: "Cursor API key", placeholder: "crsr_..." },
  { env: "ANTHROPIC_API_KEY", label: "Anthropic API key", placeholder: "sk-ant-..." },
  { env: "QUILL_PROVIDER", label: "Provider", placeholder: "auto" },
  { env: "QUILL_CURSOR_MODEL", label: "Cursor model", placeholder: "auto" },
  { env: "LM_STUDIO_URL", label: "Local LLM URL", placeholder: "http://localhost:1234/v1" },
];

module.exports = { INTEGRATIONS, SETTINGS_SECTIONS, CORE_ENV_KEYS };
