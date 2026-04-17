import { Bell, Check } from "lucide-react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  useListNotifications,
  useMarkNotificationRead,
  useMarkAllNotificationsRead,
  getListNotificationsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { useState } from "react";

export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();
  const { data } = useListNotifications(undefined, {
    query: { refetchInterval: 60_000 },
  });
  const markRead = useMarkNotificationRead({
    mutation: {
      onSuccess: () =>
        queryClient.invalidateQueries({
          queryKey: getListNotificationsQueryKey(),
        }),
    },
  });
  const markAll = useMarkAllNotificationsRead({
    mutation: {
      onSuccess: () =>
        queryClient.invalidateQueries({
          queryKey: getListNotificationsQueryKey(),
        }),
    },
  });

  const items = data?.items ?? [];
  const unread = data?.unreadCount ?? 0;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative text-sidebar-foreground/80 hover:text-sidebar-accent-foreground hover:bg-sidebar-accent"
          aria-label={`Notifications${unread > 0 ? ` (${unread} unread)` : ""}`}
          data-testid="button-notifications"
        >
          <Bell className="h-5 w-5" />
          {unread > 0 && (
            <Badge
              variant="destructive"
              className="absolute -top-1 -right-1 h-5 min-w-5 px-1 text-[10px] flex items-center justify-center rounded-full"
              data-testid="badge-unread-count"
            >
              {unread > 9 ? "9+" : unread}
            </Badge>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        side="right"
        className="w-80 p-0"
        data-testid="popover-notifications"
      >
        <div className="flex items-center justify-between px-3 py-2 border-b">
          <div className="text-sm font-semibold">Notifications</div>
          {unread > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              onClick={() => markAll.mutate()}
              data-testid="button-mark-all-read"
            >
              <Check className="h-3 w-3 mr-1" />
              Mark all read
            </Button>
          )}
        </div>
        <div className="max-h-96 overflow-y-auto divide-y">
          {items.length === 0 ? (
            <div className="px-3 py-6 text-sm text-muted-foreground text-center">
              You're all caught up.
            </div>
          ) : (
            items.map((n) => {
              const inner = (
                <div
                  className={`px-3 py-3 hover:bg-muted/50 transition-colors cursor-pointer ${
                    !n.readAt ? "bg-primary/5" : ""
                  }`}
                  data-testid={`notification-item-${n.id}`}
                  onClick={() => {
                    if (!n.readAt) markRead.mutate({ id: n.id });
                    setOpen(false);
                  }}
                >
                  <div className="flex items-start gap-2">
                    {!n.readAt && (
                      <span className="mt-1.5 h-2 w-2 rounded-full bg-primary shrink-0" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium truncate">
                        {n.title}
                      </div>
                      <div className="text-xs text-muted-foreground line-clamp-2 mt-0.5">
                        {n.body}
                      </div>
                      <div className="text-[10px] text-muted-foreground mt-1">
                        {formatDistanceToNow(new Date(n.createdAt), {
                          addSuffix: true,
                        })}
                      </div>
                    </div>
                  </div>
                </div>
              );
              return n.link ? (
                <Link key={n.id} href={n.link}>
                  {inner}
                </Link>
              ) : (
                <div key={n.id}>{inner}</div>
              );
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
