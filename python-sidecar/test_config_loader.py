"""Tests for the unified Python config loader."""

import os
import tempfile
import textwrap
from pathlib import Path
from unittest import mock

import pytest

# Reset the singleton before importing so tests start clean
import config_loader
config_loader._config = None


@pytest.fixture(autouse=True)
def reset_config():
    """Reset singleton and clear env vars before/after each test."""
    config_loader._config = None
    env_vars = [
        "OLLAMA_MODEL", "OLLAMA_BASE_URL", "OLLAMA_TIMEOUT", "OLLAMA_NUM_CTX",
        "SQL_SYSTEM_PROMPT", "SEQUENTIAL_CANDIDATES", "JOIN_HINT_FORMAT",
        "LOG_LEVEL", "PORT",
    ]
    saved = {v: os.environ.get(v) for v in env_vars}
    for v in env_vars:
        os.environ.pop(v, None)
    yield
    config_loader._config = None
    for v, val in saved.items():
        if val is None:
            os.environ.pop(v, None)
        else:
            os.environ[v] = val


def write_yaml(tmpdir: str, filename: str, content: str):
    config_dir = os.path.join(tmpdir, "config")
    os.makedirs(config_dir, exist_ok=True)
    with open(os.path.join(config_dir, filename), "w") as f:
        f.write(textwrap.dedent(content))


# ── Basic Loading ──────────────────────────────────────────────────────


class TestBasicLoading:
    def test_loads_from_config_yaml(self, tmp_path, monkeypatch):
        write_yaml(str(tmp_path), "config.yaml", """\
            database:
              host: myhost
              port: 5433
            model:
              llm: "llama3.1:8b"
              timeout: 60
            features:
              glosses: false
        """)
        monkeypatch.chdir(tmp_path)
        cfg = config_loader.load_config()
        assert cfg["database"]["host"] == "myhost"
        assert cfg["database"]["port"] == 5433
        assert cfg["model"]["llm"] == "llama3.1:8b"
        assert cfg["model"]["timeout"] == 60
        assert cfg["features"]["glosses"] is False

    def test_returns_dict_when_no_config_dir(self, tmp_path, monkeypatch):
        # tmp_path has no config/ subdirectory
        monkeypatch.chdir(tmp_path)
        cfg = config_loader.load_config()
        assert isinstance(cfg, dict)

    def test_singleton_returns_same_object(self, tmp_path, monkeypatch):
        write_yaml(str(tmp_path), "config.yaml", "database:\n  host: host1\n")
        monkeypatch.chdir(tmp_path)
        a = config_loader.load_config()
        b = config_loader.load_config()
        assert a is b

    def test_get_config_autoloads(self, tmp_path, monkeypatch):
        write_yaml(str(tmp_path), "config.yaml", "database:\n  host: autoload\n")
        monkeypatch.chdir(tmp_path)
        cfg = config_loader.get_config()
        assert cfg["database"]["host"] == "autoload"


# ── Deep Merge ─────────────────────────────────────────────────────────


class TestDeepMerge:
    def test_local_overrides_base(self, tmp_path, monkeypatch):
        write_yaml(str(tmp_path), "config.yaml", """\
            database:
              host: basehost
              port: 5432
              name: basedb
            model:
              llm: "base-model"
        """)
        write_yaml(str(tmp_path), "config.local.yaml", """\
            database:
              host: localhost
              name: localdb
        """)
        monkeypatch.chdir(tmp_path)
        cfg = config_loader.load_config()
        assert cfg["database"]["host"] == "localhost"
        assert cfg["database"]["name"] == "localdb"
        assert cfg["database"]["port"] == 5432  # kept from base
        assert cfg["model"]["llm"] == "base-model"  # kept from base

    def test_nested_override_preserves_siblings(self, tmp_path, monkeypatch):
        write_yaml(str(tmp_path), "config.yaml", """\
            features:
              glosses: true
              pg_normalize: true
              schema_linker: false
        """)
        write_yaml(str(tmp_path), "config.local.yaml", """\
            features:
              schema_linker: true
        """)
        monkeypatch.chdir(tmp_path)
        cfg = config_loader.load_config()
        assert cfg["features"]["glosses"] is True
        assert cfg["features"]["pg_normalize"] is True
        assert cfg["features"]["schema_linker"] is True

    def test_missing_local_yaml_is_fine(self, tmp_path, monkeypatch):
        write_yaml(str(tmp_path), "config.yaml", "database:\n  host: onlybase\n")
        monkeypatch.chdir(tmp_path)
        cfg = config_loader.load_config()
        assert cfg["database"]["host"] == "onlybase"


# ── Env-Var Overrides ──────────────────────────────────────────────────


class TestEnvOverrides:
    def test_env_overrides_yaml(self, tmp_path, monkeypatch):
        write_yaml(str(tmp_path), "config.yaml", """\
            model:
              llm: "yaml-model"
              timeout: 60
        """)
        monkeypatch.chdir(tmp_path)
        os.environ["OLLAMA_MODEL"] = "env-model"
        os.environ["OLLAMA_TIMEOUT"] = "120"
        cfg = config_loader.load_config()
        assert cfg["model"]["llm"] == "env-model"
        assert cfg["model"]["timeout"] == 120

    def test_sequential_bool_env(self, tmp_path, monkeypatch):
        write_yaml(str(tmp_path), "config.yaml", "generation:\n  sequential: false\n")
        monkeypatch.chdir(tmp_path)
        os.environ["SEQUENTIAL_CANDIDATES"] = "true"
        cfg = config_loader.load_config()
        assert cfg["generation"]["sequential"] is True

    def test_sequential_false_env(self, tmp_path, monkeypatch):
        write_yaml(str(tmp_path), "config.yaml", "generation:\n  sequential: true\n")
        monkeypatch.chdir(tmp_path)
        os.environ["SEQUENTIAL_CANDIDATES"] = "false"
        cfg = config_loader.load_config()
        assert cfg["generation"]["sequential"] is False

    def test_num_ctx_zero_env(self, tmp_path, monkeypatch):
        write_yaml(str(tmp_path), "config.yaml", "model:\n  num_ctx: 4096\n")
        monkeypatch.chdir(tmp_path)
        os.environ["OLLAMA_NUM_CTX"] = "0"
        cfg = config_loader.load_config()
        assert cfg["model"]["num_ctx"] == 0

    def test_unset_env_preserves_yaml(self, tmp_path, monkeypatch):
        write_yaml(str(tmp_path), "config.yaml", """\
            model:
              llm: "yaml-model"
              timeout: 90
        """)
        monkeypatch.chdir(tmp_path)
        # No env vars set (cleared in fixture)
        cfg = config_loader.load_config()
        assert cfg["model"]["llm"] == "yaml-model"
        assert cfg["model"]["timeout"] == 90

    def test_join_hint_format_env(self, tmp_path, monkeypatch):
        write_yaml(str(tmp_path), "config.yaml", "sidecar:\n  join_hint_format: edges\n")
        monkeypatch.chdir(tmp_path)
        os.environ["JOIN_HINT_FORMAT"] = "paths"
        cfg = config_loader.load_config()
        assert cfg["sidecar"]["join_hint_format"] == "paths"

    def test_port_env(self, tmp_path, monkeypatch):
        write_yaml(str(tmp_path), "config.yaml", "sidecar:\n  url: 'http://localhost:8001'\n")
        monkeypatch.chdir(tmp_path)
        os.environ["PORT"] = "9999"
        cfg = config_loader.load_config()
        assert cfg["sidecar"]["port"] == 9999

    def test_env_overrides_local_overrides_base(self, tmp_path, monkeypatch):
        write_yaml(str(tmp_path), "config.yaml", "model:\n  llm: base\n  timeout: 60\n")
        write_yaml(str(tmp_path), "config.local.yaml", "model:\n  llm: local\n")
        monkeypatch.chdir(tmp_path)
        os.environ["OLLAMA_MODEL"] = "fromenv"
        cfg = config_loader.load_config()
        assert cfg["model"]["llm"] == "fromenv"  # env wins
        assert cfg["model"]["timeout"] == 60      # base (no local/env)


# ── Deep Merge Helper ──────────────────────────────────────────────────


class TestDeepMergeHelper:
    def test_non_overlapping_keys(self):
        a = {"x": 1}
        b = {"y": 2}
        result = config_loader._deep_merge(a, b)
        assert result == {"x": 1, "y": 2}

    def test_nested_merge(self):
        a = {"top": {"a": 1, "b": 2}}
        b = {"top": {"b": 3, "c": 4}}
        result = config_loader._deep_merge(a, b)
        assert result == {"top": {"a": 1, "b": 3, "c": 4}}

    def test_scalar_overwrite(self):
        a = {"key": "old"}
        b = {"key": "new"}
        result = config_loader._deep_merge(a, b)
        assert result == {"key": "new"}

    def test_list_replacement_not_merge(self):
        a = {"items": [1, 2]}
        b = {"items": [3, 4, 5]}
        result = config_loader._deep_merge(a, b)
        assert result == {"items": [3, 4, 5]}

    def test_does_not_mutate_inputs(self):
        a = {"top": {"a": 1}}
        b = {"top": {"b": 2}}
        config_loader._deep_merge(a, b)
        assert a == {"top": {"a": 1}}
        assert b == {"top": {"b": 2}}


# ── Integration with real config.yaml ──────────────────────────────────


class TestIntegration:
    def test_loads_real_project_config(self, monkeypatch):
        project_root = Path(__file__).resolve().parent.parent
        monkeypatch.chdir(project_root)
        cfg = config_loader.load_config()

        assert cfg["database"]["host"] == "localhost"
        assert cfg["database"]["port"] == 5432
        assert cfg["database"]["name"] == "enterprise_erp"
        assert cfg["model"]["llm"] == "qwen2.5-coder:7b"
        assert cfg["model"]["embedding"] == "nomic-embed-text"
        assert cfg["generation"]["temperature"] == 0.3
        assert cfg["generation"]["candidates"]["k_default"] == 4
        assert cfg["features"]["glosses"] is True
        assert cfg["features"]["column_pruning"] is False
        assert cfg["repair"]["max_attempts"] == 3
        assert cfg["sidecar"]["url"] == "http://localhost:8001"
