"""Configuration loading for Quill.

Resolution order (highest priority first):
  1. Explicit CLI flags (handled in cli.py, passed into Config)
  2. Environment variables
  3. A .env file in the workspace (simple KEY=VALUE parser, no dependency)
  4. config.toml in the workspace
  5. Built-in defaults
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

try:  # tomllib is stdlib on 3.11+
    import tomllib  # type: ignore
except Exception:  # pragma: no cover
    tomllib = None  # type: ignore

# Sensible defaults. These can be overridden by env / flags.
DEFAULT_MODEL = "claude-sonnet-4-20250514"
DEFAULT_CURSOR_MODEL = "auto"
DEFAULT_LOCAL_MODEL = "local"
DEFAULT_LOCAL_BASE_URL = "http://localhost:1234/v1"
DEFAULT_PROVIDER = "auto"  # auto | cursor | anthropic | local
DEFAULT_MAX_TOKENS = 4096
DEFAULT_MAX_RETRIES = 5
DEFAULT_RETRY_BASE_DELAY = 1.5  # seconds, exponential backoff base
DEFAULT_BASH_TIMEOUT = 120  # seconds
DEFAULT_MAX_ITERATIONS = 60  # max agent loop turns before pausing


@dataclass
class Config:
    """Runtime configuration."""

    api_key: str | None = None
    model: str = DEFAULT_MODEL
    provider: str = DEFAULT_PROVIDER
    cursor_api_key: str | None = None
    cursor_model: str = DEFAULT_CURSOR_MODEL
    fallback_model: str = DEFAULT_MODEL
    fallback_enabled: bool = True
    local_base_url: str | None = None
    local_model: str = DEFAULT_LOCAL_MODEL
    active_provider: str = ""  # resolved at runtime (cursor | anthropic | local)
    rtk_enabled: bool = True
    codegraph_enabled: bool = True
    max_tokens: int = DEFAULT_MAX_TOKENS
    max_retries: int = DEFAULT_MAX_RETRIES
    retry_base_delay: float = DEFAULT_RETRY_BASE_DELAY
    bash_timeout: int = DEFAULT_BASH_TIMEOUT
    max_iterations: int = DEFAULT_MAX_ITERATIONS
    workspace: Path = field(default_factory=Path.cwd)
    confirm: bool = True  # ask before destructive actions
    plan_mode: bool = False  # block destructive tools; agent must plan only
    token_budget: int = 0  # soft per-session warning threshold; 0 = off
    base_url: str | None = None  # for custom/compatible endpoints
    extra_system: str = ""  # filled from memory files
    theme: dict | None = None  # color overrides; None = default rich theme
    secret_scan: bool = True  # block writes containing obvious API keys
    stream: bool = True  # stream assistant text deltas when supported
    sandbox: str = ""  # "" = none, "docker:<image>" = wrap execute_bash in docker run
    thinking_budget: int = 2048  # extended thinking tokens; 0 = off
    caveman_enabled: bool = True  # terse caveman output protocol in system prompt
    verbose_tools: bool = False  # show full tool args/results; off = simple status lines

    @property
    def has_key(self) -> bool:
        return bool(self.api_key)

    @property
    def has_cursor_key(self) -> bool:
        return bool(self.cursor_api_key)

    @property
    def has_local(self) -> bool:
        return bool((self.local_base_url or "").strip())

    def resolve_initial_provider(self) -> str:
        """Pick cursor vs anthropic vs local for this session."""
        mode = (self.provider or DEFAULT_PROVIDER).lower()
        if mode == "cursor":
            return "cursor"
        if mode == "anthropic":
            return "anthropic"
        if mode == "local":
            return "local"
        # auto: Cursor plan → Claude API → local LLM
        if self.has_cursor_key and _cursor_sdk_available():
            return "cursor"
        if self.has_key:
            return "anthropic"
        if self.has_local:
            return "local"
        return "anthropic"

    def display_model(self) -> str:
        provider = self.active_provider or self.resolve_initial_provider()
        if provider == "cursor":
            return self.cursor_model if (self.cursor_model or "").lower() != "auto" else "composer-2.5 (auto)"
        if provider == "local":
            return self.local_model
        return self.model


def _cursor_sdk_available() -> bool:
    try:
        import cursor_sdk  # noqa: F401
        return True
    except ImportError:
        return False


def _global_config_dir() -> Path:
    quill_dir = Path.home() / ".quill"
    if quill_dir.exists():
        return quill_dir
    legacy = Path.home() / ".sexyjarvis"
    return legacy if legacy.exists() else quill_dir


def _parse_dotenv(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    try:
        for raw in path.read_text(encoding="utf-8-sig").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, val = line.partition("=")
            val = val.strip().strip('"').strip("'")
            out[key.strip()] = val
    except Exception:
        pass
    return out


def _load_toml(path: Path) -> dict:
    if tomllib is None or not path.exists():
        return {}
    try:
        with path.open("rb") as fh:
            return tomllib.load(fh)
    except Exception:
        return {}


def load_config(workspace: Path | None = None, overrides: dict | None = None) -> Config:
    """Build a Config from files, env, and explicit overrides."""
    ws = Path(workspace or Path.cwd()).resolve()
    overrides = overrides or {}
    global_dir = _global_config_dir()

    # Layer 3: .env in workspace, then global ~/.quill/.env (legacy ~/.sexyjarvis/.env)
    dotenv = _parse_dotenv(ws / ".env")
    global_dotenv = _parse_dotenv(global_dir / ".env")
    legacy_global = _parse_dotenv(Path.home() / ".sexyjarvis" / ".env")
    for k, v in legacy_global.items():
        global_dotenv.setdefault(k, v)
    # Layer 4: config.toml in workspace + .quill/config.toml profile + global config
    base_toml = _load_toml(ws / "config.toml")
    profile_toml = _load_toml(ws / ".quill" / "config.toml")
    global_toml = _load_toml(global_dir / "config.toml")

    def _merge(a: dict, b: dict) -> dict:
        out = dict(a) if isinstance(a, dict) else {}
        if not isinstance(b, dict):
            return out
        for k, v in b.items():
            if k in out and isinstance(out[k], dict) and isinstance(v, dict):
                out[k] = _merge(out[k], v)
            else:
                out[k] = v
        return out

    toml_cfg = _merge(_merge(global_toml or {}, base_toml or {}), profile_toml or {})
    toml_q = toml_cfg.get("quill", toml_cfg.get("sexyjarvis", toml_cfg)) if isinstance(toml_cfg, dict) else {}

    def pick(env_keys: list[str], toml_key: str, default):
        # overrides win
        if toml_key in overrides and overrides[toml_key] is not None:
            return overrides[toml_key]
        for k in env_keys:
            if os.environ.get(k):
                return os.environ[k]
            if k in dotenv:
                return dotenv[k]
            if k in global_dotenv:
                return global_dotenv[k]
        if toml_key in toml_q:
            return toml_q[toml_key]
        return default

    api_key = pick(["ANTHROPIC_API_KEY", "QUILL_API_KEY", "SEXYJARVIS_API_KEY"], "api_key", None)
    cursor_api_key = pick(["CURSOR_API_KEY", "QUILL_CURSOR_API_KEY", "SEXYJARVIS_CURSOR_API_KEY"], "cursor_api_key", None)
    model = str(pick(["QUILL_MODEL", "SEXYJARVIS_MODEL", "ANTHROPIC_MODEL"], "model", DEFAULT_MODEL))
    cursor_model = str(pick(["QUILL_CURSOR_MODEL", "SEXYJARVIS_CURSOR_MODEL", "CURSOR_MODEL"], "cursor_model", DEFAULT_CURSOR_MODEL))
    provider = str(pick(["QUILL_PROVIDER", "SEXYJARVIS_PROVIDER"], "provider", DEFAULT_PROVIDER)).lower()
    fallback_model = str(pick(["QUILL_FALLBACK_MODEL", "SEXYJARVIS_FALLBACK_MODEL"], "fallback_model", DEFAULT_MODEL))
    local_base_url = pick(
        ["QUILL_LOCAL_URL", "SEXYJARVIS_LOCAL_URL", "LM_STUDIO_URL", "OLLAMA_HOST"],
        "local_base_url",
        None,
    )
    local_model = str(pick(["QUILL_LOCAL_MODEL", "SEXYJARVIS_LOCAL_MODEL", "LM_MODEL", "OLLAMA_MODEL"], "local_model", DEFAULT_LOCAL_MODEL))
    base_url = pick(["ANTHROPIC_BASE_URL", "QUILL_BASE_URL", "SEXYJARVIS_BASE_URL"], "base_url", None)

    def as_bool(v, default: bool) -> bool:
        if v is None:
            return default
        if isinstance(v, bool):
            return v
        return str(v).strip().lower() in ("1", "true", "yes", "on")

    def as_int(v, d):
        try:
            return int(v)
        except Exception:
            return d

    def as_float(v, d):
        try:
            return float(v)
        except Exception:
            return d

    cfg = Config(
        api_key=api_key,
        cursor_api_key=str(cursor_api_key).strip() if cursor_api_key else None,
        model=model,
        cursor_model=cursor_model,
        provider=provider,
        fallback_model=fallback_model,
        fallback_enabled=as_bool(pick(["QUILL_FALLBACK", "SEXYJARVIS_FALLBACK"], "fallback_enabled", True), True),
        local_base_url=str(local_base_url).strip() if local_base_url else None,
        local_model=local_model,
        rtk_enabled=as_bool(pick(["QUILL_RTK", "SEXYJARVIS_RTK"], "rtk_enabled", True), True),
        codegraph_enabled=as_bool(pick(["QUILL_CODEGRAPH", "SEXYJARVIS_CODEGRAPH"], "codegraph_enabled", True), True),
        max_tokens=as_int(pick(["QUILL_MAX_TOKENS", "SEXYJARVIS_MAX_TOKENS"], "max_tokens", DEFAULT_MAX_TOKENS), DEFAULT_MAX_TOKENS),
        max_retries=as_int(pick(["QUILL_MAX_RETRIES", "SEXYJARVIS_MAX_RETRIES"], "max_retries", DEFAULT_MAX_RETRIES), DEFAULT_MAX_RETRIES),
        retry_base_delay=as_float(pick(["QUILL_RETRY_DELAY", "SEXYJARVIS_RETRY_DELAY"], "retry_base_delay", DEFAULT_RETRY_BASE_DELAY), DEFAULT_RETRY_BASE_DELAY),
        bash_timeout=as_int(pick(["QUILL_BASH_TIMEOUT", "SEXYJARVIS_BASH_TIMEOUT"], "bash_timeout", DEFAULT_BASH_TIMEOUT), DEFAULT_BASH_TIMEOUT),
        max_iterations=as_int(pick(["QUILL_MAX_ITERATIONS", "SEXYJARVIS_MAX_ITERATIONS"], "max_iterations", DEFAULT_MAX_ITERATIONS), DEFAULT_MAX_ITERATIONS),
        token_budget=as_int(pick(["QUILL_TOKEN_BUDGET", "SEXYJARVIS_TOKEN_BUDGET"], "token_budget", 0), 0),
        thinking_budget=as_int(pick(["QUILL_THINKING_BUDGET", "SEXYJARVIS_THINKING_BUDGET"], "thinking_budget", 2048), 2048),
        caveman_enabled=as_bool(pick(["QUILL_CAVEMAN", "SEXYJARVIS_CAVEMAN"], "caveman_enabled", True), True),
        verbose_tools=as_bool(pick(["QUILL_VERBOSE_TOOLS", "SEXYJARVIS_VERBOSE_TOOLS"], "verbose_tools", False), False),
        workspace=ws,
        base_url=str(base_url) if base_url else None,
    )

    # Explicit override for confirm / model etc.
    if "confirm" in overrides and overrides["confirm"] is not None:
        cfg.confirm = bool(overrides["confirm"])
    if "provider" in overrides and overrides["provider"] is not None:
        cfg.provider = str(overrides["provider"]).lower()
    if "cursor_model" in overrides and overrides["cursor_model"] is not None:
        cfg.cursor_model = str(overrides["cursor_model"])
    if "fallback_enabled" in overrides and overrides["fallback_enabled"] is not None:
        cfg.fallback_enabled = bool(overrides["fallback_enabled"])
    if "rtk_enabled" in overrides and overrides["rtk_enabled"] is not None:
        cfg.rtk_enabled = bool(overrides["rtk_enabled"])
    if "codegraph_enabled" in overrides and overrides["codegraph_enabled"] is not None:
        cfg.codegraph_enabled = bool(overrides["codegraph_enabled"])
    if "caveman_enabled" in overrides and overrides["caveman_enabled"] is not None:
        cfg.caveman_enabled = bool(overrides["caveman_enabled"])
    if "verbose_tools" in overrides and overrides["verbose_tools"] is not None:
        cfg.verbose_tools = bool(overrides["verbose_tools"])
    if "stream" in overrides and overrides["stream"] is not None:
        cfg.stream = bool(overrides["stream"])

    # Read theme block from the merged TOML (no overrides for nested theme).
    theme_block = toml_cfg.get("theme") if isinstance(toml_cfg, dict) else None
    if isinstance(theme_block, dict):
        cfg.theme = theme_block

    cfg.active_provider = cfg.resolve_initial_provider()
    return cfg
