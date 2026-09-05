import type { components } from "@/lib/http/schema";

type RouterSettings = NonNullable<components["schemas"]["ConfigYAML"]["router_settings"]>;

/**
 * The two router settings the Key Rotation page writes, always together.
 *
 * A hold budget sent on its own leaves enforcement as it is, so the router would keep
 * the default budget and the page would read back a number nobody asked for.
 */
export interface QuotaSettingsUpdate {
  enable_quota_routing: NonNullable<RouterSettings["enable_quota_routing"]>;
  quota_max_wait_seconds: NonNullable<RouterSettings["quota_max_wait_seconds"]>;
}

export interface QuotaSettingsLive {
  enforced: boolean;
  maxWaitSeconds: number | null;
}

export interface QuotaSettingsDraft {
  enforced: boolean;
  holdSeconds: string;
}

export type QuotaSettingsState =
  | { kind: "loading" }
  | { kind: "unchanged" }
  | { kind: "invalid"; message: string }
  | { kind: "ready"; update: QuotaSettingsUpdate };

export const MAX_HOLD_SECONDS = 600;

const SECONDS = /^\d+(\.\d+)?$/;

export const holdText = (seconds: number | null): string => (seconds == null ? "" : String(seconds));

const holdSecondsOf = (raw: string): { seconds: number } | { message: string } => {
  const text = raw.trim();
  if (text === "") return { message: "Enter how many seconds a request can be held. 0 never holds." };
  if (!SECONDS.test(text)) return { message: "Seconds only, like 75 or 12.5." };

  const seconds = Number(text);
  if (seconds > MAX_HOLD_SECONDS) {
    return { message: `Hold at most ${MAX_HOLD_SECONDS} seconds. Anything longer outlives the client's own timeout.` };
  }
  return { seconds };
};

/**
 * What a save would send, or why it is not offered.
 *
 * The hold budget is only read when enforcement is on in the draft, so a half-typed
 * number never blocks turning enforcement off, and turning it off keeps the budget the
 * router is already running with.
 */
export const quotaSettingsState = (draft: QuotaSettingsDraft, live: QuotaSettingsLive): QuotaSettingsState => {
  if (live.maxWaitSeconds == null) return { kind: "loading" };

  if (!draft.enforced) {
    if (!live.enforced) return { kind: "unchanged" };
    return {
      kind: "ready",
      update: { enable_quota_routing: false, quota_max_wait_seconds: live.maxWaitSeconds },
    };
  }

  const hold = holdSecondsOf(draft.holdSeconds);
  if ("message" in hold) return { kind: "invalid", message: hold.message };
  if (live.enforced && hold.seconds === live.maxWaitSeconds) return { kind: "unchanged" };

  return {
    kind: "ready",
    update: { enable_quota_routing: true, quota_max_wait_seconds: hold.seconds },
  };
};
