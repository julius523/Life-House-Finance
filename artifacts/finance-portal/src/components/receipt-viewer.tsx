import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Download, FileBox } from "lucide-react";

export interface ReceiptViewerFile {
  fileUrl?: string | null;
  fileName: string;
  fileType?: string | null;
}

interface ReceiptViewerProps {
  file: ReceiptViewerFile | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function buildReceiptHref(fileUrl?: string | null): string | null {
  if (!fileUrl) return null;
  return `/api/storage/${fileUrl.replace(/^\/+/, "")}`;
}

export function ReceiptViewer({ file, open, onOpenChange }: ReceiptViewerProps) {
  const href = buildReceiptHref(file?.fileUrl);
  const fileType = file?.fileType ?? "";
  const isImage = fileType.startsWith("image/");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl w-full p-0 overflow-hidden">
        <DialogHeader className="px-6 pt-6 pb-3 border-b">
          <div className="flex items-center justify-between gap-4">
            <DialogTitle className="truncate" title={file?.fileName}>
              {file?.fileName ?? "Receipt"}
            </DialogTitle>
            {href && (
              <div className="flex items-center gap-2 shrink-0">
                <Button asChild variant="outline" size="sm">
                  <a href={href} download={file?.fileName}>
                    <Download className="mr-2 h-4 w-4" />
                    Download
                  </a>
                </Button>
              </div>
            )}
          </div>
        </DialogHeader>
        <div className="bg-muted h-[70vh] flex items-center justify-center">
          {!href ? (
            <div className="text-center text-muted-foreground space-y-2">
              <FileBox className="h-10 w-10 mx-auto opacity-30" />
              <div>No file attached</div>
            </div>
          ) : isImage ? (
            <img
              src={href}
              alt={file?.fileName ?? "Receipt"}
              className="max-h-full max-w-full object-contain"
            />
          ) : (
            <div className="text-center text-muted-foreground space-y-4">
              <FileBox className="h-12 w-12 mx-auto opacity-40" />
              <div className="text-sm font-medium">{file?.fileName}</div>
              <div className="text-xs opacity-70">
                Preview is not available for this file type.
              </div>
              <Button asChild variant="outline" size="sm">
                <a href={href} download={file?.fileName}>
                  <Download className="mr-2 h-4 w-4" />
                  Download to view
                </a>
              </Button>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
