"""Integration registry — env keys the agent can use via MCP/tools."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class IntegrationKey:
    env: str
    label: str


@dataclass(frozen=True)
class Integration:
    id: str
    name: str
    description: str
    keys: tuple[IntegrationKey, ...]


INTEGRATIONS: tuple[Integration, ...] = (
    Integration("github", "GitHub", "Manage repos, issues, and pull requests.", (IntegrationKey("GITHUB_TOKEN", "Token"),)),
    Integration("stripe", "Stripe", "Payments, customers, invoices, and subscriptions.", (IntegrationKey("STRIPE_SECRET_KEY", "Secret key"),)),
    Integration(
        "sentry",
        "Sentry",
        "Track issues, errors, and releases.",
        (IntegrationKey("SENTRY_AUTH_TOKEN", "Auth token"), IntegrationKey("SENTRY_DSN", "DSN")),
    ),
    Integration("cloudflare", "Cloudflare", "DNS, Workers, and zones.", (IntegrationKey("CLOUDFLARE_API_TOKEN", "API token"),)),
    Integration("posthog", "PostHog", "Product analytics and events.", (IntegrationKey("POSTHOG_API_KEY", "API key"),)),
    Integration("semrush", "Semrush", "SEO keywords and domain analytics.", (IntegrationKey("SEMRUSH_API_KEY", "API key"),)),
    Integration(
        "aws",
        "Amazon Web Services",
        "EC2, S3, Lambda, and more.",
        (
            IntegrationKey("AWS_ACCESS_KEY_ID", "Access key ID"),
            IntegrationKey("AWS_SECRET_ACCESS_KEY", "Secret access key"),
            IntegrationKey("AWS_DEFAULT_REGION", "Region"),
        ),
    ),
    Integration(
        "azure",
        "Microsoft Azure",
        "Resource groups, VMs, and Azure services.",
        (
            IntegrationKey("AZURE_CLIENT_ID", "Client ID"),
            IntegrationKey("AZURE_CLIENT_SECRET", "Client secret"),
            IntegrationKey("AZURE_TENANT_ID", "Tenant ID"),
        ),
    ),
    Integration(
        "gcp",
        "Google Cloud",
        "Compute, storage, and GCP services.",
        (
            IntegrationKey("GOOGLE_APPLICATION_CREDENTIALS", "Credentials path"),
            IntegrationKey("GCP_PROJECT_ID", "Project ID"),
        ),
    ),
)


def _load_dotenv() -> dict[str, str]:
    out: dict[str, str] = {}
    for base in (Path.home() / ".quill", Path.home() / ".sexyjarvis"):
        p = base / ".env"
        if not p.is_file():
            continue
        try:
            for line in p.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, _, v = line.partition("=")
                out[k.strip()] = v.strip().strip('"').strip("'")
        except OSError:
            pass
    for k, v in os.environ.items():
        if k not in out and v:
            out[k] = v
    return out


def integration_status(integration: Integration, env: dict[str, str] | None = None) -> str:
    env = env or _load_dotenv()
    ok = all((env.get(k.env) or "").strip() for k in integration.keys)
    return "connected" if ok else "disconnected"


def list_integrations() -> list[dict]:
    env = _load_dotenv()
    rows = []
    for i in INTEGRATIONS:
        rows.append({
            "id": i.id,
            "name": i.name,
            "description": i.description,
            "status": integration_status(i, env),
            "keys": [k.env for k in i.keys],
        })
    return rows


def integrations_summary() -> str:
    rows = list_integrations()
    connected = sum(1 for r in rows if r["status"] == "connected")
    return f"{connected} of {len(rows)} connected"
