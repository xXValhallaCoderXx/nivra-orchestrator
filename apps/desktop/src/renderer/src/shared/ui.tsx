import { Box, Group, Paper, Stack, Text, Title } from "@mantine/core";
import { useEffect, useRef, useState, type ReactNode } from "react";

/** Electron prefixes errors from the main process; people only need the message itself (from Hird). */
export function errorMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");
}

/** A titled block of the page. */
export function Section({ title, description, actions, children }: { title: string; description?: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <Paper withBorder p="lg">
      <Stack gap="md">
        <Group justify="space-between" align="flex-start" gap="sm">
          <Stack gap={2} style={{ flex: "1 1 220px", minWidth: 0 }}>
            <Title order={3}>{title}</Title>
            {description && (
              <Text size="sm" c="var(--nivra-text-2)">
                {description}
              </Text>
            )}
          </Stack>
          {actions && <Box style={{ flex: "0 1 auto", maxWidth: "100%" }}>{actions}</Box>}
        </Group>
        {children}
      </Stack>
    </Paper>
  );
}

/**
 * Calls `load` now and then every `intervalMs` (which may change with the result), never overlapping, until the
 * component unmounts or `enabled` turns false.
 */
export function usePoll<T>(load: () => Promise<T>, intervalMs: (value: T | null) => number | null, deps: readonly unknown[], enabled = true) {
  const [value, setValue] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadRef = useRef(load);
  loadRef.current = load;
  const intervalRef = useRef(intervalMs);
  intervalRef.current = intervalMs;
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = async () => {
      let next: T | null = null;
      try {
        next = await loadRef.current();
        if (!active) return;
        setValue(next);
        setError(null);
      } catch (reason) {
        if (!active) return;
        setError(errorMessage(reason));
      }
      const wait = intervalRef.current(next);
      if (active && wait !== null) timer = setTimeout(() => void run(), wait);
    };
    void run();
    return () => {
      active = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, enabled, tick]);

  return { value, error, refresh: () => setTick((n) => n + 1) };
}
