import { Badge, Button, Stack, Table, Text } from "@mantine/core";
import type { DoctorReport } from "@nivra/domain";
import { useState } from "react";
import { errorMessage, Section } from "../shared/ui";

const COLOR = { ok: "green", warn: "yellow", fail: "red" } as const;

/** What works where the chosen project runs, and what to do about what doesn't. Checks only detect; nothing is changed. */
export function Doctor({ projectId, online, targetLabel }: { projectId: string | null; online: boolean; targetLabel: string | null }) {
  const [report, setReport] = useState<DoctorReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run() {
    if (!projectId) return;
    setBusy(true);
    setError(null);
    try {
      setReport(await window.nivra.runDoctor(projectId));
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section
      title="Diagnose setup"
      description={
        targetLabel
          ? `Git, the engine's data folder, and the execution boundaries ${targetLabel} can offer.`
          : "Git, the engine's data folder, and the execution boundaries. Choose a folder first."
      }
      actions={
        <Button size="xs" variant="default" onClick={() => void run()} loading={busy} disabled={!projectId || !online} data-testid="doctor-run">
          Diagnose setup
        </Button>
      }
    >
      {error && (
        <Text size="sm" c="var(--nivra-error)">
          {error}
        </Text>
      )}
      {report && (
        <Table data-testid="doctor-report">
          <Table.Tbody>
            {report.checks.map((check) => (
              <Table.Tr key={check.id}>
                <Table.Td w={90} style={{ verticalAlign: "top" }}>
                  <Badge color={COLOR[check.status]} variant="light">
                    {check.status}
                  </Badge>
                </Table.Td>
                <Table.Td w={170} style={{ verticalAlign: "top" }}>
                  <Text size="sm" fw={500}>
                    {check.title}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Stack gap={4}>
                    <Text size="sm">{check.detail}</Text>
                    {check.fix && (
                      <Text size="sm" c="var(--nivra-text-2)">
                        {check.fix}
                      </Text>
                    )}
                  </Stack>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
    </Section>
  );
}
