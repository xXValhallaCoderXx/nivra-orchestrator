import { Alert, Stack, Text, Title } from "@mantine/core";
import { useEffect, useState } from "react";
import type { RunLimitsView } from "../../../shared/ipc";
import { runLimitLines } from "../shell/run-limits";

/** Coverage outside the shared monthly inference-request allowance. */
export const BUDGET_NOT_AVAILABLE = "Coding runs, research, sandbox operations and other agents aren't covered by the Companion and planning request allowance. Their existing per-run limits apply.";

/**
 * Settings › Budget and usage: the coverage outside the Companion and planning allowance and the existing per-run
 * bounds read through main. The adjacent request control owns its combined usage and editable monthly limit.
 */
export function BudgetAndUsage() {
  const [limits, setLimits] = useState<RunLimitsView | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    window.nivra.getRunLimits().then(
      (view) => active && setLimits(view),
      () => active && setFailed(true),
    );
    return () => {
      active = false;
    };
  }, []);

  return (
    <Stack gap="md" data-testid="budget-usage">
      <Text size="sm" data-testid="budget-usage-note">
        {BUDGET_NOT_AVAILABLE}
      </Text>
      <Title order={2} fz={15} lh={1.47}>
        Per-run limits
      </Title>
      {failed ? (
        <Alert color="red" variant="light" data-testid="budget-usage-error">
          <Text size="sm">Nivra couldn't read the per-run limits, so none are shown here. Each run's preview shows its bounds before it starts.</Text>
        </Alert>
      ) : !limits ? (
        <Text size="sm" c="var(--nivra-text-3)" role="status">
          Reading the per-run limits…
        </Text>
      ) : (
        <>
          <Text size="sm" c="var(--nivra-text-2)">
            Every task run has these bounds, whatever its brief:
          </Text>
          <Stack gap={10} data-testid="budget-usage-limits">
            {runLimitLines(limits).map((line) => (
              <Stack key={line.key} gap={2} data-testid="budget-usage-limit" data-key={line.key}>
                <Text size="sm" fw={600}>
                  {line.label}
                </Text>
                <Text size="sm">{line.text}</Text>
              </Stack>
            ))}
          </Stack>
          <Text size="sm" c="var(--nivra-text-2)" data-testid="budget-usage-brief">
            A run's Nebius operations, and the baseline checks it runs first, also depend on its brief's checks: each run's preview shows them, with these, before anything starts.
          </Text>
        </>
      )}
    </Stack>
  );
}
