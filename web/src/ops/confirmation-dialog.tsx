import type { ReactNode } from "react";
import { AlertDialog as AlertDialogPrimitive } from "radix-ui";

import { Button } from "@/components/ui/button";

interface ConfirmationDialogProps {
  actionLabel: string;
  busy: boolean;
  children: ReactNode;
  description: string;
  onConfirm: () => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  title: string;
}

export function ConfirmationDialog({
  actionLabel,
  busy,
  children,
  description,
  onConfirm,
  onOpenChange,
  open,
  title,
}: ConfirmationDialogProps) {
  return (
    <AlertDialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialogPrimitive.Trigger asChild>{children}</AlertDialogPrimitive.Trigger>
      <AlertDialogPrimitive.Portal>
        <AlertDialogPrimitive.Overlay className="ops-dialog-overlay" />
        <AlertDialogPrimitive.Content className="ops-dialog-content">
          <div className="ops-dialog-header">
            <AlertDialogPrimitive.Title className="ops-dialog-title">{title}</AlertDialogPrimitive.Title>
            <AlertDialogPrimitive.Description className="ops-dialog-description">
              {description}
            </AlertDialogPrimitive.Description>
          </div>
          <div className="ops-dialog-actions">
            <AlertDialogPrimitive.Cancel asChild>
              <Button type="button" variant="outline" disabled={busy}>Cancel</Button>
            </AlertDialogPrimitive.Cancel>
            <AlertDialogPrimitive.Action asChild>
              <Button type="button" variant="destructive" disabled={busy} onClick={onConfirm}>
                {busy ? "Working…" : actionLabel}
              </Button>
            </AlertDialogPrimitive.Action>
          </div>
        </AlertDialogPrimitive.Content>
      </AlertDialogPrimitive.Portal>
    </AlertDialogPrimitive.Root>
  );
}
