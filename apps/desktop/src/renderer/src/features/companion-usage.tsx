import { Alert, Button, Checkbox, NumberInput, Paper, Stack, Text, Title } from "@mantine/core";
import { useEffect, useState } from "react";
import type { CompanionUsageView } from "../../../shared/ipc";
import { errorMessage } from "../shared/ui";

/** Counts are admission controls for companion requests only; other features retain their existing limits. */
export function CompanionUsage({ freshness = 0 }: { freshness?: number }) {
  const [view, setView] = useState<CompanionUsageView | null>(null);
  const [limit, setLimit] = useState<number | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let active = true;
    window.nivra.getCompanionUsage().then((value) => { if (active) { setView(value); setLimit(value.limit); setEnabled(value.limit !== null); } }, (reason: unknown) => { if (active) setError(errorMessage(reason)); });
    return () => { active = false; };
  }, [freshness, refresh]);
  return <Paper withBorder p="md" data-testid="companion-usage"><Stack gap="sm"><Title order={2} fz={15}>Companion requests</Title><Text size="sm">This control counts inference requests sent by the companion on this installation. It doesn't cover other agents, tokens or a provider invoice.</Text>
    {view && <><Text size="sm" data-testid="companion-usage-count">{view.month}: {view.historyComplete ? "" : "Earlier usage is unknown. Retained records show: "}{view.used} requests used, {view.reserved} reserved; {view.unknown} have unknown outcomes. {view.remaining === null ? "No companion request cap is set." : `${view.remaining} requests remain available.`}</Text><Text size="sm" data-testid="companion-token-usage">{view.historyComplete ? "Reported tokens" : "Earlier token totals are unknown; retained records report"}: {view.reportedInputTokens} input, {view.reportedOutputTokens} output. {view.unknownTokens ? `${view.unknownTokens} requests have unknown token usage; totals are incomplete.` : "Every completed request reported its token usage."}</Text>{view.blocked && <Alert color="yellow">{view.blocked}</Alert>}<Checkbox label="Limit companion requests each month" checked={enabled} onChange={(event) => setEnabled(event.currentTarget.checked)} data-testid="companion-limit-enabled" />{enabled && <NumberInput label="Monthly companion requests" value={limit ?? ""} onChange={(value) => setLimit(typeof value === "number" ? value : null)} min={0} max={1_000_000} allowDecimal={false} data-testid="companion-limit" />}<Button size="xs" loading={busy} disabled={enabled && limit === null} onClick={async () => { setBusy(true); setError(null); try { await window.nivra.setCompanionLimit(enabled ? limit : null); setRefresh((n) => n + 1); } catch (reason) { setError(errorMessage(reason)); } finally { setBusy(false); } }} data-testid="companion-limit-save">Save companion limit</Button><Button variant="subtle" size="xs" onClick={() => setRefresh((n) => n + 1)}>Refresh usage</Button></>}
    {error && <Alert color="red">{error}</Alert>}
  </Stack></Paper>;
}
