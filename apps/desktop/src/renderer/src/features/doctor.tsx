import { Badge, Button, Stack, Table, Text } from "@mantine/core";
import type { DoctorReport } from "@nivra/domain";
import { useState } from "react";
import { errorMessage, Section } from "../shared/ui";

const COLOR = { ok: "green", warn: "yellow", fail: "red" } as const;

/** What works on this target, and what to do about what doesn't. Checks only detect; nothing is changed. */
export function Doctor({ online }: { online: boolean }) {
  const [report, setReport] = useState<DoctorReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      setReport(await window.nivra.runDoctor());
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section
      title="Doctor"
      description="Git, the engine's data folder, and the execution boundaries this target can offer."
      actions={
        <Button size="xs" variant="default" onClick={() => void run()} loading={busy} disabled={!online} data-testid="doctor-run">
          Run checks
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
