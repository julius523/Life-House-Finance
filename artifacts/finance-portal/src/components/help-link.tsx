import { HelpCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { openHelp, type RunbookSlug } from "@/lib/runbooks";

export function HelpLink({
  topic,
  label = "Help with this page",
  className,
}: {
  topic: RunbookSlug;
  label?: string;
  className?: string;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className={className}
      onClick={() => openHelp(topic)}
      data-testid={`button-help-${topic}`}
    >
      <HelpCircle className="mr-1.5 h-4 w-4" />
      {label}
    </Button>
  );
}
