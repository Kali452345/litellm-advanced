"""Per-credential request quotas (rpm/rpd) for router deployments."""

from litellm.router_utils.quota.counter import (
    AtomicWindowCounter,
    QuotaDescriptor,
    ReserveBlocked,
    ReserveGranted,
    ReserveResult,
    build_descriptors,
)
from litellm.router_utils.quota.scope import (
    DEFAULT_QUOTA_SCOPE_MODE,
    QuotaScope,
    QuotaScopeMode,
    resolve_quota_scope,
)
from litellm.router_utils.quota.window import (
    DEFAULT_QUOTA_TIMEZONE,
    QuotaWindow,
    QuotaWindowKind,
    UnknownQuotaTimezoneError,
    counter_key,
    day_window,
    minute_window,
    resolve_quota_timezone,
)

__all__ = (
    "DEFAULT_QUOTA_SCOPE_MODE",
    "DEFAULT_QUOTA_TIMEZONE",
    "AtomicWindowCounter",
    "QuotaDescriptor",
    "QuotaScope",
    "QuotaScopeMode",
    "QuotaWindow",
    "QuotaWindowKind",
    "ReserveBlocked",
    "ReserveGranted",
    "ReserveResult",
    "UnknownQuotaTimezoneError",
    "build_descriptors",
    "counter_key",
    "day_window",
    "minute_window",
    "resolve_quota_scope",
    "resolve_quota_timezone",
)
