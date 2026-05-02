import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import { ChevronLeft } from "lucide-react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  HELP_OPEN_EVENT,
  getRunbook,
  listRunbooks,
  openHelp,
  type RunbookSlug,
} from "@/lib/runbooks";

export function HelpDrawer() {
  const [open, setOpen] = useState(false);
  const [slug, setSlug] = useState<RunbookSlug>("index");

  useEffect(() => {
    const onOpen = (e: Event) => {
      const detail = (e as CustomEvent<RunbookSlug>).detail ?? "index";
      setSlug(detail);
      setOpen(true);
    };
    window.addEventListener(HELP_OPEN_EVENT, onOpen);
    return () => window.removeEventListener(HELP_OPEN_EVENT, onOpen);
  }, []);

  const runbook = getRunbook(slug);
  const isIndex = slug === "index";

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-xl flex flex-col gap-0 p-0"
        data-testid="drawer-help"
      >
        <SheetHeader className="px-6 py-4 border-b">
          <div className="flex items-center gap-2">
            {!isIndex && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="-ml-2"
                onClick={() => setSlug("index")}
                data-testid="button-help-back"
              >
                <ChevronLeft className="mr-1 h-4 w-4" />
                All runbooks
              </Button>
            )}
          </div>
          <SheetTitle data-testid="text-help-title">
            {runbook?.title ?? "Help"}
          </SheetTitle>
        </SheetHeader>
        <ScrollArea className="flex-1">
          <div className="px-6 py-4">
            {isIndex ? (
              <RunbookIndex onPick={(s) => setSlug(s)} />
            ) : (
              <MarkdownBody body={runbook?.body ?? ""} />
            )}
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}

function RunbookIndex({ onPick }: { onPick: (slug: RunbookSlug) => void }) {
  const all = listRunbooks();
  const tour = all.find((r) => r.slug === "index");
  const others = all.filter((r) => r.slug !== "index");
  return (
    <div className="space-y-6">
      {tour && <MarkdownBody body={tour.body} onLinkPick={onPick} />}
      <div>
        <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground mb-2">
          All runbooks
        </h3>
        <ul className="space-y-1">
          {others.map((r) => (
            <li key={r.slug}>
              <Button
                type="button"
                variant="link"
                className="px-0 h-auto py-1 text-left"
                onClick={() => onPick(r.slug)}
                data-testid={`link-runbook-${r.slug}`}
              >
                {r.title}
              </Button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function MarkdownBody({
  body,
  onLinkPick,
}: {
  body: string;
  onLinkPick?: (slug: RunbookSlug) => void;
}) {
  return (
    <div className="prose prose-sm max-w-none dark:prose-invert prose-headings:font-semibold prose-h1:text-2xl prose-h2:text-lg prose-h2:mt-6 prose-h3:text-base prose-p:leading-relaxed prose-li:my-0.5 prose-code:before:content-none prose-code:after:content-none prose-code:bg-muted prose-code:px-1 prose-code:py-0.5 prose-code:rounded">
      <ReactMarkdown
        components={{
          a: ({ href, children, ...rest }) => {
            const internal = href?.match(/^([a-z0-9-]+)\.md(?:#.*)?$/i);
            if (internal && onLinkPick) {
              const target = internal[1] as RunbookSlug;
              return (
                <a
                  href="#"
                  onClick={(e) => {
                    e.preventDefault();
                    onLinkPick(target);
                  }}
                >
                  {children}
                </a>
              );
            }
            if (internal) {
              const target = internal[1] as RunbookSlug;
              return (
                <a
                  href="#"
                  onClick={(e) => {
                    e.preventDefault();
                    openHelp(target);
                  }}
                >
                  {children}
                </a>
              );
            }
            return (
              <a href={href} target="_blank" rel="noreferrer" {...rest}>
                {children}
              </a>
            );
          },
        }}
      >
        {body}
      </ReactMarkdown>
    </div>
  );
}
