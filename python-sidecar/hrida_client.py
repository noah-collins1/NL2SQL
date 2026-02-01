"""
Hrida Client - Ollama API Integration

Handles communication with Ollama to generate SQL using HridaAI/hrida-t2sql model.

Features:
- Temperature=0.0 for deterministic output
- Gibberish detection (catches Test 3 failure patterns)
- Confidence scoring
- Timeout handling
"""

import re
import requests
from typing import Optional, Tuple
import logging

from config import OLLAMA_BASE_URL, OLLAMA_MODEL, OLLAMA_TIMEOUT

logger = logging.getLogger(__name__)


class HridaError(Exception):
    """Raised when Hrida fails to generate valid SQL"""
    pass


class HridaClient:
    """
    Client for Hrida NL2SQL model via Ollama API
    """

    def __init__(
        self,
        base_url: str = OLLAMA_BASE_URL,
        model: str = OLLAMA_MODEL,
        timeout: int = OLLAMA_TIMEOUT
    ):
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.timeout = timeout

    def generate_sql(
        self,
        prompt: str,
        temperature: float = 0.0,
        max_tokens: int = 200
    ) -> Tuple[str, float]:
        """
        Generate SQL from prompt using Hrida

        Args:
            prompt: Complete prompt including schema and question
            temperature: Sampling temperature (default 0.0 for deterministic)
            max_tokens: Maximum tokens to generate (default 200)

        Returns:
            Tuple of (sql, confidence_score)

        Raises:
            HridaError: If generation fails or produces gibberish
            requests.RequestException: If Ollama API call fails
        """
        logger.debug(f"Calling Ollama API: {self.model}")

        try:
            # Call Ollama generate endpoint
            response = requests.post(
                f"{self.base_url}/api/generate",
                json={
                    "model": self.model,
                    "prompt": prompt,
                    "stream": False,
                    "options": {
                        "temperature": temperature,
                        "num_predict": max_tokens,
                        "stop": [";", "\n\n"],  # Stop at semicolon or double newline
                    }
                },
                timeout=self.timeout
            )

            response.raise_for_status()
            data = response.json()

            # Extract generated text
            sql = data.get("response", "").strip()

            logger.debug(f"Hrida generated: {sql[:100]}...")

            # Check for gibberish (patterns from Test 3)
            if self._is_gibberish(sql):
                logger.warning(f"Gibberish detected: {sql[:50]}...")
                raise HridaError("Model generated invalid output (gibberish detected)")

            # Check basic structure
            if not sql.upper().startswith("SELECT"):
                logger.warning(f"SQL does not start with SELECT: {sql[:50]}...")
                raise HridaError("Model did not generate SELECT statement")

            # Ensure semicolon at end
            if not sql.endswith(";"):
                sql += ";"

            # Estimate confidence based on output quality
            confidence = self._estimate_confidence(sql)

            logger.info(f"SQL generated successfully, confidence: {confidence:.2f}")

            return sql, confidence

        except requests.Timeout:
            logger.error(f"Ollama request timed out after {self.timeout}s")
            raise HridaError(f"Ollama request timed out after {self.timeout}s")

        except requests.RequestException as e:
            logger.error(f"Ollama API error: {e}")
            raise HridaError(f"Ollama API error: {str(e)}")

    def _is_gibberish(self, text: str) -> bool:
        """
        Detect gibberish output patterns from Test 3

        Patterns seen in Test 3 failures:
        - "00 (02.15er00000ment "b's "Gal"
        - "INSERT(ta (insert (semals"
        - Random character sequences
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
        if text.count("(") > 10 or text.count("[") > 5:
            return True

        # Pattern 5: Very short output that's not a valid SQL pattern
        if len(text) < 20 and not text.upper().startswith("SELECT"):
            return True

        # Pattern 6: Contains "CANNOT_GENERATE" (our failure signal)
        if "CANNOT_GENERATE" in text.upper():
            return True

        return False

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


# Singleton instance for convenience
_default_client: Optional[HridaClient] = None


def get_hrida_client() -> HridaClient:
    """Get or create default Hrida client"""
    global _default_client
    if _default_client is None:
        _default_client = HridaClient()
    return _default_client


def reset_hrida_client():
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
        HridaError: If embedding fails
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
            raise HridaError("Empty embedding returned from Ollama")

        logger.debug(f"Generated embedding with {len(embedding)} dimensions")
        return embedding

    except requests.Timeout:
        logger.error(f"Embedding request timed out after {timeout}s")
        raise HridaError(f"Embedding request timed out after {timeout}s")

    except requests.RequestException as e:
        logger.error(f"Embedding API error: {e}")
        raise HridaError(f"Embedding API error: {str(e)}")
