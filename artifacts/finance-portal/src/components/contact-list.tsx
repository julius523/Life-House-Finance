import { useEffect, useState } from "react";
import { apiJson } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Mail, Phone, Plus, Pencil, Trash2, User } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

export type Contact = {
  id: number;
  vendorId?: number;
  programId?: number;
  name: string;
  role?: string;
  email?: string;
  phone?: string;
  isPrimary: boolean;
  createdAt: string;
};

type Props = {
  parentId: number;
  /** "vendor" or "program" — determines URLs */
  kind: "vendor" | "program";
};

export function ContactList({ parentId, kind }: Props) {
  const { toast } = useToast();
  const [contacts, setContacts] = useState<Contact[] | null>(null);
  const [editing, setEditing] = useState<Contact | null>(null);
  const [creating, setCreating] = useState(false);

  const listUrl = kind === "vendor" ? `/vendors/${parentId}/contacts` : `/programs/${parentId}/contacts`;
  const createUrl = listUrl;
  const itemUrl = (id: number) =>
    kind === "vendor" ? `/vendor-contacts/${id}` : `/program-contacts/${id}`;

  const refresh = async () => {
    try {
      const data = await apiJson<{ contacts: Contact[] }>(listUrl);
      setContacts(data.contacts);
    } catch (e) {
      toast({
        title: "Could not load contacts",
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      });
    }
  };

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parentId, kind]);

  const handleDelete = async (c: Contact) => {
    if (!confirm(`Remove contact "${c.name}"?`)) return;
    try {
      await apiJson(itemUrl(c.id), { method: "DELETE" });
      toast({ title: "Contact removed" });
      refresh();
    } catch (e) {
      toast({
        title: "Could not remove",
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      });
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Contacts
        </h4>
        <Button size="sm" variant="outline" onClick={() => setCreating(true)}>
          <Plus className="h-3 w-3 mr-1" /> Add contact
        </Button>
      </div>
      {contacts === null ? (
        <div className="text-xs text-muted-foreground">Loading…</div>
      ) : contacts.length === 0 ? (
        <div className="text-xs text-muted-foreground italic">No contacts yet.</div>
      ) : (
        <div className="space-y-2">
          {contacts.map((c) => (
            <div
              key={c.id}
              className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 rounded-md border p-3 bg-background"
            >
              <div className="space-y-0.5">
                <div className="flex items-center gap-2 flex-wrap">
                  <User className="h-3 w-3 text-muted-foreground" />
                  <span className="font-medium text-sm">{c.name}</span>
                  {c.isPrimary && <Badge variant="secondary" className="text-[10px]">Primary</Badge>}
                  {c.role && <Badge variant="outline" className="text-[10px]">{c.role}</Badge>}
                </div>
                <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
                  {c.email && (
                    <span className="flex items-center gap-1">
                      <Mail className="h-3 w-3" /> {c.email}
                    </span>
                  )}
                  {c.phone && (
                    <span className="flex items-center gap-1">
                      <Phone className="h-3 w-3" /> {c.phone}
                    </span>
                  )}
                </div>
              </div>
              <div className="flex gap-1">
                <Button size="sm" variant="ghost" onClick={() => setEditing(c)}>
                  <Pencil className="h-3 w-3" />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-destructive hover:text-destructive"
                  onClick={() => handleDelete(c)}
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
      {creating && (
        <ContactDialog
          createUrl={createUrl}
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            refresh();
          }}
        />
      )}
      {editing && (
        <ContactDialog
          contact={editing}
          itemUrl={itemUrl(editing.id)}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}

function ContactDialog({
  contact,
  createUrl,
  itemUrl,
  onClose,
  onSaved,
}: {
  contact?: Contact;
  createUrl?: string;
  itemUrl?: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [name, setName] = useState(contact?.name ?? "");
  const [role, setRole] = useState(contact?.role ?? "");
  const [email, setEmail] = useState(contact?.email ?? "");
  const [phone, setPhone] = useState(contact?.phone ?? "");
  const [isPrimary, setIsPrimary] = useState(contact?.isPrimary ?? false);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!name.trim()) {
      toast({ title: "Name is required", variant: "destructive" });
      return;
    }
    setBusy(true);
    try {
      const body = { name: name.trim(), role, email, phone, isPrimary };
      if (contact && itemUrl) {
        await apiJson(itemUrl, { method: "PUT", body });
        toast({ title: "Contact updated" });
      } else if (createUrl) {
        await apiJson(createUrl, { method: "POST", body });
        toast({ title: "Contact added" });
      }
      onSaved();
    } catch (e) {
      toast({
        title: "Save failed",
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{contact ? "Edit contact" : "Add contact"}</DialogTitle>
          <DialogDescription>
            People at this organization who handle communication.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>Role / title (optional)</Label>
            <Input value={role} onChange={(e) => setRole(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Email</Label>
              <Input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Phone</Label>
              <Input value={phone} onChange={(e) => setPhone(e.target.value)} />
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={isPrimary}
              onChange={(e) => setIsPrimary(e.target.checked)}
            />
            Primary contact
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={save} disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
