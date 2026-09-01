"""
Credential-scoped identity for quota counters.

A provider meters its free tier per account, not per LiteLLM deployment. One key
serving six models produces six `model_list` entries with six different
`model_info.id` values, because `generate_model_id` hashes the model group into
the id, so a counter keyed on the deployment id would enforce a 5/min key at
5/min six separate times. Quota counters are therefore keyed on the credential.

The derived scope id is a salted HMAC of the credential, never the credential
itself, and it is never logged or returned by an API. A bare digest of an API key
sitting in a Redis key name would let anyone who can read those names confirm a
guessed key.
"""

import hashlib
import hmac
import os
from dataclasses import dataclass
from typing import Final

from litellm.types.router import QuotaScopeMode

DEFAULT_QUOTA_SCOPE_MODE: Final[QuotaScopeMode] = "credential_model"

_DIGEST_LENGTH: Final = 24
_EXPLICIT_PREFIX: Final = "id"
_CREDENTIAL_NAME_PREFIX: Final = "cred"
_DIGEST_PREFIX: Final = "key"
_DEPLOYMENT_PREFIX: Final = "deployment"
_FALLBACK_SALT: Final = "litellm-quota-scope"


@dataclass(frozen=True, slots=True)
class QuotaScope:
    scope_id: str
    model: str | None

    @property
    def key_prefix(self) -> str:
        """
        Redis Cluster hash tag holding everything a scope's windows share.

        Wrapping it in braces keeps one scope's rpm and rpd keys on one slot, so
        both can be reserved in a single atomic script call.
        """
        return f"{{{self.scope_id}}}" if self.model is None else f"{{{self.scope_id}:{self.model}}}"


def resolve_quota_scope(
    *,
    mode: QuotaScopeMode,
    litellm_model: str | None,
    deployment_id: str,
    quota_scope_id: str | None = None,
    litellm_credential_name: str | None = None,
    api_base: str | None = None,
    api_key: str | None = None,
) -> QuotaScope:
    """
    Identify the credential a deployment's quota counters belong to.

    Precedence: an operator-set `quota_scope_id`, then the stored credential's
    name, then a salted digest of the resolved `(api_base, api_key)` pair. When a
    deployment carries none of those (an IAM-role or local-endpoint deployment),
    it falls back to its own id, which reproduces per-deployment counting rather
    than silently merging two unrelated accounts onto one counter. Operators who
    do share such an account across deployments set `quota_scope_id` to link them.
    """
    model: Final = litellm_model if mode == "credential_model" else None
    return QuotaScope(
        scope_id=_resolve_scope_id(
            quota_scope_id=quota_scope_id,
            litellm_credential_name=litellm_credential_name,
            api_base=api_base,
            api_key=api_key,
            deployment_id=deployment_id,
        ),
        model=model,
    )


def _resolve_scope_id(
    *,
    quota_scope_id: str | None,
    litellm_credential_name: str | None,
    api_base: str | None,
    api_key: str | None,
    deployment_id: str,
) -> str:
    if quota_scope_id:
        return f"{_EXPLICIT_PREFIX}:{quota_scope_id}"
    if litellm_credential_name:
        return f"{_CREDENTIAL_NAME_PREFIX}:{litellm_credential_name}"
    if api_key:
        return f"{_DIGEST_PREFIX}:{_credential_digest(api_base=api_base, api_key=api_key)}"
    return f"{_DEPLOYMENT_PREFIX}:{deployment_id}"


def _credential_digest(*, api_base: str | None, api_key: str) -> str:
    material: Final = f"{api_base or ''}\n{api_key}".encode()
    return hmac.new(_scope_salt(), material, hashlib.sha256).hexdigest()[:_DIGEST_LENGTH]


def _scope_salt() -> bytes:
    return (os.getenv("LITELLM_SALT_KEY") or os.getenv("LITELLM_MASTER_KEY") or _FALLBACK_SALT).encode()
