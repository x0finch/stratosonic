import { CheckIcon, CopyIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  InputGroupTextarea,
} from "@/components/ui/input-group";
import type { Library } from "@/lib/api";
import { CORS_FILE, corsCommands, corsJson, type LibraryNotice } from "@/lib/libraries";
import { toastFailure } from "@/lib/toasts";

/**
 * A bucket's CORS rule (#84, "CORS per bucket"). The console uploads
 * straight to each bucket, so each needs Phase 2's rule for this console's
 * origin. The console cannot apply it (that needs an Admin token, and a
 * library's token is Object Read & Write on its bucket only), so the dialog
 * shows the rule and the two Wrangler commands, each with a copy button.
 *
 * It opens by itself once a bucket is connected. Its backdrop then covers
 * the connect's toast, so `connected` repeats the toast's words first.
 */
export function CorsDialog({
  library,
  connected,
  open,
  onOpenChange,
}: {
  library: Library | null;
  connected: LibraryNotice | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Wide enough for a command on one line; taller than a phone's screen, it scrolls. */}
      <DialogContent className="max-h-svh overflow-y-auto sm:max-w-2xl">
        {library && <CorsRule library={library} connected={connected} />}
      </DialogContent>
    </Dialog>
  );
}

function CorsRule({ library, connected }: { library: Library; connected: LibraryNotice | null }) {
  const json = corsJson(window.location.origin);
  const commands = corsCommands(library.bucket);

  return (
    <>
      <DialogHeader>
        <DialogTitle>Bucket CORS for {library.name}</DialogTitle>
        <DialogDescription>
          {connected && `${connected.title}. ${connected.description} `}
          Uploads from this console go straight to the bucket, which needs this CORS rule. Save it
          as {CORS_FILE}, then run the commands under the Cloudflare account that owns the bucket.
        </DialogDescription>
      </DialogHeader>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="cors-rule">{CORS_FILE}</FieldLabel>
          <InputGroup>
            <InputGroupTextarea
              id="cors-rule"
              readOnly
              rows={json.split("\n").length}
              value={json}
              spellCheck={false}
              className="font-mono text-xs"
            />
            <InputGroupAddon align="block-end">
              <CopyButton text={json} label={`Copy ${CORS_FILE}`} className="ml-auto" />
            </InputGroupAddon>
          </InputGroup>
        </Field>
        <CommandField id="cors-set" label="Apply the rule" command={commands.set} />
        <CommandField id="cors-list" label="Check it" command={commands.list} />
      </FieldGroup>
      <DialogFooter>
        <DialogClose render={<Button variant="outline" />}>Close</DialogClose>
      </DialogFooter>
    </>
  );
}

function CommandField({ id, label, command }: { id: string; label: string; command: string }) {
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <InputGroup>
        <InputGroupInput
          id={id}
          readOnly
          value={command}
          spellCheck={false}
          className="font-mono text-xs"
        />
        <InputGroupAddon align="inline-end">
          <CopyButton text={command} label={`Copy the command to ${label.toLowerCase()}`} />
        </InputGroupAddon>
      </InputGroup>
    </Field>
  );
}

/** Copies `text`, and shows a check for two seconds once it is on the clipboard. */
function CopyButton({
  text,
  label,
  className,
}: {
  text: string;
  label: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) {
      return;
    }
    const timer = window.setTimeout(() => setCopied(false), 2_000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      toastFailure("Not copied", "The browser did not allow it. Select the text and copy it.");
    }
  }

  return (
    <InputGroupButton size="icon-xs" aria-label={label} className={className} onClick={copy}>
      {copied ? <CheckIcon /> : <CopyIcon />}
    </InputGroupButton>
  );
}
