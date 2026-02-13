"""
Unified config loader for NL2SQL Python sidecar.

Precedence: ENV > config/config.local.yaml > config/config.yaml

All existing env-var names remain supported for backward compatibility.
"""

import os
from pathlib import Path
from typing import Any, Dict, Optional

try:
    import yaml
except ImportError:
    yaml = None  # type: ignore


def _find_config_dir() -> Optional[Path]:
    """Walk up from cwd looking for config/config.yaml."""
    d = Path.cwd()
    for _ in range(10):
        candidate = d / "config" / "config.yaml"
        if candidate.exists():
            return d / "config"
        parent = d.parent
        if parent == d:
            break
        d = parent
    return None


def _deep_merge(a: Dict, b: Dict) -> Dict:
    """Deep merge b into a (b wins)."""
    result = dict(a)
    for key, val in b.items():
        if (
            isinstance(val, dict)
            and not isinstance(val, list)
            and isinstance(result.get(key), dict)
        ):
            result[key] = _deep_merge(result[key], val)
        else:
            result[key] = val
    return result


def _load_yaml(path: Path) -> Dict:
    if not path.exists():
        return {}
    if yaml is None:
        return {}
    with open(path, "r") as f:
        data = yaml.safe_load(f)
    return data if isinstance(data, dict) else {}


def _env(name: str) -> Optional[str]:
    return os.environ.get(name)


def _env_bool(name: str) -> Optional[bool]:
    v = _env(name)
    if v is None:
        return None
    return v.lower() in ("true", "1")


def _env_int(name: str) -> Optional[int]:
    v = _env(name)
    if v is None:
        return None
    try:
        return int(v)
    except ValueError:
        return None


def _apply_env_overrides(cfg: Dict) -> None:
    """Apply env-var overrides using the same var names as existing code."""
    m = cfg.setdefault("model", {})
    m["llm"] = _env("OLLAMA_MODEL") or m.get("llm")
    m["ollama_url"] = _env("OLLAMA_BASE_URL") or m.get("ollama_url")
    m["timeout"] = _env_int("OLLAMA_TIMEOUT") or m.get("timeout")
    m["num_ctx"] = _env_int("OLLAMA_NUM_CTX") if _env("OLLAMA_NUM_CTX") is not None else m.get("num_ctx")
    m["sql_system_prompt"] = _env("SQL_SYSTEM_PROMPT") or m.get("sql_system_prompt")

    g = cfg.setdefault("generation", {})
    seq = _env_bool("SEQUENTIAL_CANDIDATES")
    if seq is not None:
        g["sequential"] = seq

    s = cfg.setdefault("sidecar", {})
    s["join_hint_format"] = _env("JOIN_HINT_FORMAT") or s.get("join_hint_format")

    l = cfg.setdefault("logging", {})
    l["level"] = _env("LOG_LEVEL") or l.get("level")

    # Port (sidecar-specific, not in YAML)
    port = _env_int("PORT")
    if port is not None:
        s["port"] = port


_config: Optional[Dict] = None


def load_config() -> Dict[str, Any]:
    """Load and return the merged config dict (singleton)."""
    global _config
    if _config is not None:
        return _config

    config_dir = _find_config_dir()
    merged: Dict = {}
    if config_dir:
        base = _load_yaml(config_dir / "config.yaml")
        local = _load_yaml(config_dir / "config.local.yaml")
        merged = _deep_merge(base, local)

    _apply_env_overrides(merged)
    _config = merged
    return _config


def get_config() -> Dict[str, Any]:
    return _config if _config is not None else load_config()
