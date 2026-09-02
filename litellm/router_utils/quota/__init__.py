"""Per-credential request quotas (rpm/rpd) for router deployments."""

from litellm.router_utils.quota.counter import (
    AtomicWindowCounter,
    QuotaDescriptor,
    ReserveBlocked,
    ReserveGranted,
    ReserveResult,
    build_descriptors,
)
from litellm.router_utils.quota.enforcement import (
    NOTHING_SPENT,
    QuotaAvailability,
    QuotaEnforcer,
    warn_on_unenforced_quotas,
)
from litellm.router_utils.quota.reservation import (
    QUOTA_RESERVED_AT_KEY,
    Reservation,
    mark_reservation,
    read_reservation,
    request_never_reached_provider,
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
    "NOTHING_SPENT",
    "QUOTA_RESERVED_AT_KEY",
    "AtomicWindowCounter",
    "QuotaAvailability",
    "QuotaDescriptor",
    "QuotaEnforcer",
    "QuotaScope",
    "QuotaScopeMode",
    "QuotaWindow",
    "QuotaWindowKind",
    "Reservation",
    "ReserveBlocked",
    "ReserveGranted",
    "ReserveResult",
    "UnknownQuotaTimezoneError",
    "build_descriptors",
    "counter_key",
    "day_window",
    "mark_reservation",
    "minute_window",
    "read_reservation",
    "request_never_reached_provider",
    "resolve_quota_scope",
    "resolve_quota_timezone",
    "warn_on_unenforced_quotas",
)
