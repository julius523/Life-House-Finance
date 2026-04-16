import { useRef, useState } from "react";
import { Upload, X, FileText, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useUpload } from "@workspace/object-storage-web";

export interface PendingReceipt {
  file: File;
  objectPath: string;
  contentType: string;
}

interface ReceiptUploaderProps {
  value: PendingReceipt[];
  onChange: (receipts: PendingReceipt[]) => void;
  label?: string;
  hint?: string;
  accept?: string;
  multiple?: boolean;
}

export function ReceiptUploader({
  value,
  onChange,
  label = "Receipts",
  hint = "Upload PDFs or images of the receipt(s).",
  accept = "image/*,application/pdf",
  multiple = true,
}: ReceiptUploaderProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const { uploadFile, isUploading, progress } = useUpload({
    onError: (e) => setErrMsg(e.message),
  });

  const handlePick = () => inputRef.current?.click();

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setErrMsg(null);
    const next: PendingReceipt[] = [...value];
    for (const file of Array.from(files)) {
      const result = await uploadFile(file);
      if (result) {
        next.push({
          file,
          objectPath: result.objectPath,
          contentType: file.type || "application/octet-stream",
        });
      }
    }
    onChange(next);
    if (inputRef.current) inputRef.current.value = "";
  };

  const remove = (i: number) => {
    const next = value.slice();
    next.splice(i, 1);
    onChange(next);
  };

  return (
    <div className="space-y-2">
      <div className="text-sm font-medium">{label}</div>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple={multiple}
        className="hidden"
        onChange={(e) => handleFiles(e.target.files)}
      />
      {value.length > 0 && (
        <ul className="space-y-2">
          {value.map((r, i) => (
            <li
              key={`${r.objectPath}-${i}`}
              className="flex items-center justify-between rounded-md border bg-muted/40 px-3 py-2 text-sm"
            >
              <div className="flex items-center gap-2 min-w-0">
                <FileText className="h-4 w-4 text-primary shrink-0" />
                <span className="truncate">{r.file.name}</span>
                <span className="text-muted-foreground text-xs shrink-0">
                  {(r.file.size / 1024).toFixed(0)} KB
                </span>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={() => remove(i)}
              >
                <X className="h-4 w-4" />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-3">
        <Button
          type="button"
          variant="outline"
          onClick={handlePick}
          disabled={isUploading}
        >
          {isUploading ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Uploading… {progress}%
            </>
          ) : (
            <>
              <Upload className="mr-2 h-4 w-4" />
              {value.length > 0 ? "Add another" : "Upload receipt"}
            </>
          )}
        </Button>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
      {errMsg && <p className="text-sm text-destructive">{errMsg}</p>}
    </div>
  );
}
