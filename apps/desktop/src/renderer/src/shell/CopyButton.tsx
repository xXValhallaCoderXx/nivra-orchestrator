import { Button, Text } from "@mantine/core";
import { useState } from "react";
import { useToast } from "./Toasts";

export const COPY_FAILED = "Nivra couldn't copy that. Select the text and copy it instead.";

/**
 * Copies `text` for the person (NIV-56), through main's copyText: the window has no clipboard of its own. A copy shows
 * a short "Copied" toast; one that failed says so beside the button, and stays until the next try. `label` names what is
 * copied, for screen readers, and starts with the button's own word.
 */
export function CopyButton({ text, label, testId }: { text: string; label: string; testId?: string }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function copy() {
    setBusy(true);
    setFailed(false);
    try {
      await window.nivra.copyText(text);
      toast("Copied");
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <span style={{ display: "inline-flex", flexDirection: "column", alignItems: "flex-start", gap: 4 }}>
      <Button size="xs" variant="default" onClick={() => void copy()} loading={busy} aria-label={label} data-testid={testId}>
        Copy
      </Button>
      {failed && (
        <Text size="xs" c="var(--nivra-error)" role="alert" data-testid="copy-failed">
          {COPY_FAILED}
        </Text>
      )}
    </span>
  );
}
