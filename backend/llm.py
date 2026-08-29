"""LLM wrapper — SINGLE place the provider is touched.

Uses Emergent Universal Key via emergentintegrations with OpenAI gpt-5.
Swappable in the future by editing this file only.
"""
from __future__ import annotations

import asyncio
import logging
import os
import uuid
from typing import Optional

from emergentintegrations.llm.chat import LlmChat, UserMessage

logger = logging.getLogger(__name__)

_DEFAULT_SYSTEM = "You are an expert software engineer and technical writer."
_MODEL_PROVIDER = "openai"
_MODEL_NAME = "gpt-5"


class LLMError(RuntimeError):
    """Raised when the LLM provider fails after a retry."""


async def _one_shot(prompt: str, system_message: str, session_id: str) -> str:
    api_key = os.environ.get("EMERGENT_LLM_KEY")
    if not api_key:
        raise LLMError("EMERGENT_LLM_KEY not set in backend/.env")

    chat = LlmChat(
        api_key=api_key,
        session_id=session_id,
        system_message=system_message,
    ).with_model(_MODEL_PROVIDER, _MODEL_NAME)

    resp = await chat.send_message(UserMessage(text=prompt))
    if resp is None:
        raise LLMError("LLM returned no response")

    # send_message returns a string on this library version; be defensive.
    if isinstance(resp, str):
        text = resp
    else:
        text = getattr(resp, "content", None) or getattr(resp, "text", None) or str(resp)

    text = (text or "").strip()
    if not text:
        raise LLMError("LLM returned empty content")
    return text


async def call_llm(
    prompt: str,
    *,
    system_message: Optional[str] = None,
    session_id: Optional[str] = None,
) -> str:
    """Call gpt-5 with `prompt` and return the response text.

    Single retry on timeout / malformed response, then raises LLMError.
    """
    system_message = system_message or _DEFAULT_SYSTEM
    session_id = session_id or f"codememory-{uuid.uuid4().hex[:12]}"

    try:
        return await _one_shot(prompt, system_message, session_id)
    except Exception as exc:  # noqa: BLE001 - deliberate retry-all
        logger.warning("LLM first attempt failed (%s); retrying once…", exc)
        try:
            # small pause before retry
            await asyncio.sleep(1.0)
            return await _one_shot(prompt, system_message, session_id + "-retry")
        except Exception as exc2:  # noqa: BLE001
            logger.exception("LLM retry also failed")
            raise LLMError(f"LLM call failed after retry: {exc2}") from exc2
