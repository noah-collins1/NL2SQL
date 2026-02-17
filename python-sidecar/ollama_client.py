"""
Ollama Client - SQL Generation via Ollama API

Handles communication with Ollama to generate SQL using any compatible model
(qwen2.5-coder, llama3.1, HridaAI/hrida-t2sql, etc.).

Features:
- Sync and async SQL generation
- Gibberish detection
- Confidence scoring
- Timeout handling
- Parallel and sequential multi-candidate generation with deduplication
- Embedding support via nomic-embed-text
"""

import re
import asyncio
import requests
import aiohttp
from typing import Optional, Tuple, List
import logging

from config import OLLAMA_BASE_URL, OLLAMA_MODEL, OLLAMA_TIMEOUT, OLLAMA_NUM_CTX

logger = logging.getLogger(__name__)


class OllamaClientError(Exception):
    """Raised when Ollama fails to generate valid SQL"""
    pass


class OllamaClient:
    """
    Client for SQL generation via Ollama API.

    Supports any Ollama-hosted model (qwen2.5-coder, llama3.1, hrida-t2sql, etc.).
    Provides sync/async generation, multi-candidate parallel/sequential generation,
    gibberish detection, and confidence scoring.
    """

    def __init__(
        self,
        base_url: str = OLLAMA_BASE_URL,
        model: str = OLLAMA_MODEL,
        timeout: int = OLLAMA_TIMEOUT,
        num_ctx: int = OLLAMA_NUM_CTX,
        system_prompt: Optional[str] = None
    ):
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.timeout = timeout
        self.num_ctx = num_ctx
        self.system_prompt = system_prompt

    def generate_sql(
        self,
        prompt: str,
        temperature: float = 0.0,
        max_tokens: int = 200,
        multi_candidate: bool = False,
        seed: Optional[int] = None
    ) -> Tuple[str, float, int, int]:
        """
        Generate SQL from prompt via Ollama

        Args:
            prompt: Complete prompt including schema and question
            temperature: Sampling temperature (default 0.0 for deterministic)
            max_tokens: Maximum tokens to generate (default 200)
            multi_candidate: If True, skip SELECT validation (output may start with delimiter)
            seed: Optional seed for reproducible generation

        Returns:
            Tuple of (sql, confidence_score, prompt_tokens, completion_tokens)

        Raises:
            OllamaClientError: If generation fails or produces gibberish
        """
        logger.debug(f"Calling Ollama API: {self.model}, seed={seed}")

        try:
            # Call Ollama generate endpoint
            # For multi-candidate mode, don't stop at semicolon (multiple statements)
            stop_tokens = ["\n\n"] if multi_candidate else [";", "\n\n"]
            # Build options dict
            options = {
                "temperature": temperature,
                "num_predict": max_tokens,
                "stop": stop_tokens,
            }
            if seed is not None:
                options["seed"] = seed
            if self.num_ctx > 0:
                options["num_ctx"] = self.num_ctx

            json_body = {
                "model": self.model,
                "prompt": prompt,
                "stream": False,
                "options": options
            }
            if self.system_prompt:
                json_body["system"] = self.system_prompt

            response = requests.post(
                f"{self.base_url}/api/generate",
                json=json_body,
                timeout=self.timeout
            )

            response.raise_for_status()
            data = response.json()

            # Extract generated text
            sql = data.get("response", "").strip()

            # Extract token counts from Ollama response
            prompt_eval_count = data.get("prompt_eval_count", 0)
            eval_count = data.get("eval_count", 0)

            # Strip markdown code fences / extract SQL from prose
            sql = self._strip_markdown_fences(sql)

            logger.debug(f"Ollama generated: {sql[:100]}...")

            # Check for gibberish (patterns from Test 3)
            # For multi-candidate mode, relax the check since output is larger
            if self._is_gibberish(sql, multi_candidate=multi_candidate):
                logger.warning(f"Gibberish detected: {sql[:50]}...")
                raise OllamaClientError("Model generated invalid output (gibberish detected)")

            # Check basic structure (skip for multi-candidate mode - output may start with delimiter)
            if not multi_candidate:
                if not sql.upper().startswith("SELECT"):
                    logger.warning(f"SQL does not start with SELECT: {sql[:50]}...")
                    raise OllamaClientError("Model did not generate SELECT statement")
                # Ensure semicolon at end (only for single-candidate)
                if not sql.endswith(";"):
                    sql += ";"
            else:
                # For multi-candidate, just verify it contains SELECT somewhere
                if "SELECT" not in sql.upper():
                    logger.warning(f"Multi-candidate output contains no SELECT: {sql[:50]}...")
                    raise OllamaClientError("Model did not generate any SELECT statements")

            # Estimate confidence based on output quality
            confidence = self._estimate_confidence(sql)

            logger.info(f"SQL generated successfully, confidence: {confidence:.2f}, prompt_tokens: {prompt_eval_count}, completion_tokens: {eval_count}")

            return sql, confidence, prompt_eval_count, eval_count

        except requests.Timeout:
            logger.error(f"Ollama request timed out after {self.timeout}s")
            raise OllamaClientError(f"Ollama request timed out after {self.timeout}s")

        except requests.RequestException as e:
            logger.error(f"Ollama API error: {e}")
            raise OllamaClientError(f"Ollama API error: {str(e)}")

    def _is_gibberish(self, text: str, multi_candidate: bool = False) -> bool:
        """
        Detect gibberish output patterns from Test 3

        Patterns seen in Test 3 failures:
        - "00 (02.15er00000ment "b's "Gal"
        - "INSERT(ta (insert (semals"
        - Random character sequences

        Args:
            text: Text to check
            multi_candidate: If True, relax limits for larger multi-candidate output
        """
        # Pattern 1: Excessive numbers mixed with random characters
        if re.search(r'\d{2,4}er\d+', text):
            return True

        # Pattern 2: Multiple single-letter words in quotes
        if re.search(r'"[a-zA-Z]"\s+"[a-zA-Z]"\s+"[a-zA-Z]"', text):
            return True

        # Pattern 3: "INSERT(ta (insert" type patterns
        if re.search(r'INSERT\(ta\s*\(insert', text, re.IGNORECASE):
            return True

        # Pattern 4: Excessive parentheses or brackets
        # For multi-candidate mode, allow more since we have multiple SQL statements
        paren_limit = 60 if multi_candidate else 10
        bracket_limit = 30 if multi_candidate else 5
        if text.count("(") > paren_limit or text.count("[") > bracket_limit:
            return True

        # Pattern 5: Very short output that's not a valid SQL pattern
        # For multi-candidate, check contains SELECT instead of starts with
        if not multi_candidate and len(text) < 20 and not text.upper().startswith("SELECT"):
            return True

        # Pattern 6: Contains "CANNOT_GENERATE" (our failure signal)
        if "CANNOT_GENERATE" in text.upper():
            return True

        return False

    @staticmethod
    def _strip_markdown_fences(text: str) -> str:
        """
        Extract SQL from model output that may contain prose and
        markdown code fences.

        Handles:
        - ```sql ... ``` blocks (extracts first one found anywhere in text)
        - Raw SQL starting with SELECT (returned as-is)
        """
        stripped = text.strip()

        # Extract SQL from ```sql ... ``` or ``` ... ``` block (first match)
        fence_match = re.search(r'```(?:sql)?\s*\n([\s\S]*?)```', stripped)
        if fence_match:
            return fence_match.group(1).strip()

        # If no fences but text contains SELECT, extract from SELECT onward
        select_match = re.search(r'(SELECT\b[\s\S]*)', stripped, re.IGNORECASE)
        if select_match:
            return select_match.group(1).strip()

        return stripped

    def _estimate_confidence(self, sql: str) -> float:
        """
        Estimate confidence score based on SQL complexity and patterns

        Returns:
            Confidence score between 0.0 and 1.0
        """
        confidence = 1.0

        # Penalty for very complex queries (higher chance of error)
        join_count = sql.upper().count("JOIN")
        if join_count > 2:
            confidence -= 0.2

        # Penalty for advanced features (less tested)
        if "HAVING" in sql.upper():
            confidence -= 0.1

        if "WINDOW" in sql.upper() or "OVER" in sql.upper():
            confidence -= 0.1

        # Penalty for very long queries
        if len(sql) > 500:
            confidence -= 0.2

        # Penalty for multiple subqueries
        subquery_count = sql.count("(SELECT")
        if subquery_count > 1:
            confidence -= 0.15

        # Bonus for simple queries
        if join_count == 0 and len(sql) < 100:
            confidence += 0.1

        # Ensure confidence stays in valid range
        return max(0.0, min(1.0, confidence))

    def health_check(self) -> bool:
        """
        Check if Ollama is reachable

        Returns:
            True if Ollama is healthy, False otherwise
        """
        try:
            response = requests.get(
                f"{self.base_url}/api/tags",
                timeout=5
            )
            return response.status_code == 200
        except Exception:
            return False

    async def generate_sql_async(
        self,
        prompt: str,
        temperature: float = 0.0,
        max_tokens: int = 200,
        session: Optional[aiohttp.ClientSession] = None,
        seed: Optional[int] = None
    ) -> Tuple[str, float, int, int]:
        """
        Async version of generate_sql for parallel candidate generation.

        Args:
            prompt: Complete prompt including schema and question
            temperature: Sampling temperature (use >0 for diversity)
            max_tokens: Maximum tokens to generate
            session: Optional aiohttp session for connection reuse
            seed: Optional seed for reproducible generation

        Returns:
            Tuple of (sql, confidence_score, prompt_tokens, completion_tokens)

        Raises:
            OllamaClientError: If generation fails
        """
        logger.debug(f"Async calling Ollama API: {self.model}, temp={temperature}, seed={seed}")

        close_session = False
        if session is None:
            session = aiohttp.ClientSession()
            close_session = True

        try:
            # Build options dict
            options = {
                "temperature": temperature,
                "num_predict": max_tokens,
                "stop": [";", "\n\n"],
            }
            if seed is not None:
                options["seed"] = seed
            if self.num_ctx > 0:
                options["num_ctx"] = self.num_ctx

            json_body = {
                "model": self.model,
                "prompt": prompt,
                "stream": False,
                "options": options
            }
            if self.system_prompt:
                json_body["system"] = self.system_prompt

            async with session.post(
                f"{self.base_url}/api/generate",
                json=json_body,
                timeout=aiohttp.ClientTimeout(total=self.timeout)
            ) as response:
                response.raise_for_status()
                data = await response.json()

                sql = data.get("response", "").strip()

                # Extract token counts from Ollama response
                prompt_eval_count = data.get("prompt_eval_count", 0)
                eval_count = data.get("eval_count", 0)

                # Strip markdown code fences / extract SQL from prose
                sql = self._strip_markdown_fences(sql)

                # Validate output
                if self._is_gibberish(sql):
                    raise OllamaClientError("Model generated gibberish")

                if not sql.upper().startswith("SELECT"):
                    raise OllamaClientError("Model did not generate SELECT statement")

                if not sql.endswith(";"):
                    sql += ";"

                confidence = self._estimate_confidence(sql)
                return sql, confidence, prompt_eval_count, eval_count

        except asyncio.TimeoutError:
            raise OllamaClientError(f"Async request timed out after {self.timeout}s")
        except aiohttp.ClientError as e:
            raise OllamaClientError(f"Async API error: {str(e)}")
        finally:
            if close_session:
                await session.close()

    async def generate_candidates_parallel(
        self,
        prompt: str,
        k: int = 4,
        temperature: float = 0.0,
        max_tokens: int = 200,
        base_seed: int = 42
    ) -> Tuple[List[Tuple[str, float]], int, int]:
        """
        Generate K SQL candidates in parallel with different seeds for reproducible diversity.

        Args:
            prompt: Base prompt for SQL generation
            k: Number of candidates to generate
            temperature: Sampling temperature (0.0 for deterministic with seed-based diversity)
            max_tokens: Maximum tokens per candidate
            base_seed: Base seed value (each candidate uses base_seed + index)

        Returns:
            Tuple of (candidates_list, prompt_tokens, total_completion_tokens)
            where candidates_list is List of (sql, confidence) tuples, deduplicated
        """
        logger.info(f"Generating {k} candidates in parallel, temp={temperature}, base_seed={base_seed}")

        async with aiohttp.ClientSession() as session:
            tasks = [
                self.generate_sql_async(
                    prompt=prompt,
                    temperature=temperature,
                    max_tokens=max_tokens,
                    session=session,
                    seed=base_seed + i  # Different seed per candidate for diversity
                )
                for i in range(k)
            ]

            results = await asyncio.gather(*tasks, return_exceptions=True)

        # Filter successful results and deduplicate
        candidates = []
        seen_normalized = set()
        agg_prompt_tokens = 0
        agg_completion_tokens = 0

        for result in results:
            if isinstance(result, Exception):
                logger.warning(f"Candidate generation failed: {result}")
                continue

            sql, confidence, prompt_tokens, completion_tokens = result
            agg_completion_tokens += completion_tokens
            # Use prompt_tokens from first successful result (same prompt for all)
            if agg_prompt_tokens == 0:
                agg_prompt_tokens = prompt_tokens

            # Normalize for deduplication: lowercase, collapse whitespace
            normalized = re.sub(r'\s+', ' ', sql.lower().strip())

            if normalized not in seen_normalized:
                seen_normalized.add(normalized)
                candidates.append((sql, confidence))
                logger.debug(f"Candidate added: {sql[:50]}...")
            else:
                logger.debug(f"Duplicate candidate skipped")

        logger.info(f"Generated {len(candidates)} unique candidates from {k} attempts, prompt_tokens={agg_prompt_tokens}")
        return candidates, agg_prompt_tokens, agg_completion_tokens

    def generate_candidates_sequential(
        self,
        prompt: str,
        k: int = 4,
        temperature: float = 0.3,
        max_tokens: int = 200,
        base_seed: int = 42
    ) -> Tuple[List[Tuple[str, float]], int, int]:
        """
        Generate K SQL candidates sequentially (one at a time).

        Use this instead of parallel generation when VRAM is limited
        (e.g. large model on small GPU where parallel requests cause OOM).

        Args:
            prompt: Base prompt for SQL generation
            k: Number of candidates to generate
            temperature: Sampling temperature (use >0 for diversity)
            max_tokens: Maximum tokens per candidate
            base_seed: Base seed value (each candidate uses base_seed + index)

        Returns:
            Tuple of (candidates_list, prompt_tokens, total_completion_tokens)
            where candidates_list is List of (sql, confidence) tuples, deduplicated
        """
        logger.info(f"Generating {k} candidates sequentially, temp={temperature}, base_seed={base_seed}")

        candidates = []
        seen_normalized = set()
        agg_prompt_tokens = 0
        agg_completion_tokens = 0

        for i in range(k):
            try:
                sql, confidence, prompt_tokens, completion_tokens = self.generate_sql(
                    prompt=prompt,
                    temperature=temperature,
                    max_tokens=max_tokens,
                    seed=base_seed + i
                )
                agg_completion_tokens += completion_tokens
                # Use prompt_tokens from first successful result (same prompt for all)
                if agg_prompt_tokens == 0:
                    agg_prompt_tokens = prompt_tokens

                normalized = re.sub(r'\s+', ' ', sql.lower().strip())
                if normalized not in seen_normalized:
                    seen_normalized.add(normalized)
                    candidates.append((sql, confidence))
                    logger.debug(f"Sequential candidate {i} added: {sql[:50]}...")
                else:
                    logger.debug(f"Sequential candidate {i} is duplicate, skipped")
            except OllamaClientError as e:
                logger.warning(f"Sequential candidate {i} failed: {e}")

        logger.info(f"Generated {len(candidates)} unique candidates from {k} sequential attempts, prompt_tokens={agg_prompt_tokens}")
        return candidates, agg_prompt_tokens, agg_completion_tokens


# Singleton instance for convenience
_default_client: Optional[OllamaClient] = None


def get_ollama_client(**kwargs) -> OllamaClient:
    """Get or create default Ollama client. Pass kwargs to override defaults on first creation."""
    global _default_client
    if _default_client is None:
        _default_client = OllamaClient(**kwargs)
    return _default_client


def reset_ollama_client():
    """Reset singleton (for testing)"""
    global _default_client
    _default_client = None


# Embedding support using nomic-embed-text
EMBED_MODEL = "nomic-embed-text:latest"
EMBED_DIM = 768  # nomic-embed-text output dimension


def get_embedding(
    text: str,
    model: str = EMBED_MODEL,
    base_url: str = OLLAMA_BASE_URL,
    timeout: int = 30
) -> list:
    """
    Get embedding vector for text using Ollama embedding API

    Args:
        text: Text to embed
        model: Embedding model name (default: nomic-embed-text)
        base_url: Ollama API URL
        timeout: Request timeout in seconds

    Returns:
        List of floats (embedding vector)

    Raises:
        OllamaClientError: If embedding fails
    """
    try:
        response = requests.post(
            f"{base_url.rstrip('/')}/api/embeddings",
            json={
                "model": model,
                "prompt": text
            },
            timeout=timeout
        )

        response.raise_for_status()
        data = response.json()

        embedding = data.get("embedding", [])

        if not embedding:
            raise OllamaClientError("Empty embedding returned from Ollama")

        logger.debug(f"Generated embedding with {len(embedding)} dimensions")
        return embedding

    except requests.Timeout:
        logger.error(f"Embedding request timed out after {timeout}s")
        raise OllamaClientError(f"Embedding request timed out after {timeout}s")

    except requests.RequestException as e:
        logger.error(f"Embedding API error: {e}")
        raise OllamaClientError(f"Embedding API error: {str(e)}")
