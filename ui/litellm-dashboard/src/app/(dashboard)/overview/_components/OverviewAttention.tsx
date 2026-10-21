"use client";

import { CircleAlert, CircleCheck, TriangleAlert } from "lucide-react";

import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent } from "@/components/ui/card";
import { MIGRATED_PAGES, migratedHref } from "@/utils/migratedPages";

import type { AttentionItem } from "../_lib/overviewSummary";

interface OverviewAttentionProps {
  items: readonly AttentionItem[];
}

function AttentionRow({ item }: { item: AttentionItem }) {
  const critical = item.tone === "critical";
  return (
    <Alert variant={critical ? "destructive" : "default"} className={critical ? undefined : "text-warning"}>
      {critical ? <TriangleAlert /> : <CircleAlert />}
      <AlertTitle>{item.title}</AlertTitle>
      <AlertDescription>{item.detail}</AlertDescription>
      <AlertAction>
        <a
          href={migratedHref(MIGRATED_PAGES[item.action.page])}
          className="text-sm font-medium underline-offset-4 hover:underline"
        >
          {item.action.label}
        </a>
      </AlertAction>
    </Alert>
  );
}

export function OverviewAttention({ items }: OverviewAttentionProps) {
  if (items.length === 0) {
    return (
      <Card>
        <CardContent className="flex items-center gap-2 py-5 text-sm text-muted-foreground">
          <CircleCheck className="size-4 shrink-0 text-success" />
          Every pool has a key with room and nothing is failing often enough to call out.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {items.map((item) => (
        <AttentionRow key={item.id} item={item} />
      ))}
    </div>
  );
}
