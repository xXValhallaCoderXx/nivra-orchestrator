import { Alert, Button, Checkbox, NumberInput, Paper, Stack, Text, Title } from "@mantine/core";
import { useEffect, useState } from "react";
import type { BudgetSummary } from "@nivra/domain";
import type { CompanionUsageView } from "../../../shared/ipc";
import { errorMessage } from "../shared/ui";

/** One installation-wide allowance, with attribution retained for each covered feature. */
export function CompanionUsage({ freshness = 0 }: { freshness?: number }) {
  const [view, setView] = useState<CompanionUsageView | null>(null);
  const [budget, setBudget] = useState<BudgetSummary | null>(null);
  const [limit, setLimit] = useState<number | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let active = true;
    void (async () => {
      const value = await window.nivra.getCompanionUsage();
      // Reconciliation can establish a provider-corroborated month; read the confirmation clock afterwards.
      const summary = await window.nivra.budgetSummary();
      if (active) { setView(value); setBudget(summary); setLimit(value.limit); setEnabled(value.limit !== null); setError(null); }
    })().catch((reason: unknown) => { if (active) setError(errorMessage(reason)); });
    return () => { active = false; };
  }, [freshness, refresh]);
  const monthToConfirm = budget && (!budget.period || budget.clock.computerMonth > budget.period.label) ? budget.clock.computerMonth : null;
  return <Paper withBorder p="md" data-testid="companion-usage"><Stack gap="sm"><Title order={2} fz={15}>Companion and planning</Title><Text size="sm">One AI request allowance covers the companion and Planning AI across all projects and engines on this installation. Each inference request counts once. Moving a proposal, manual edits and draft saves use no requests. Coding runs, research and other agents are outside this allowance. This is not a token or dollar ceiling, or a provider invoice limit.</Text>
    {view && <><Text size="sm" data-testid="companion-usage-count">{view.month}: {view.historyComplete ? "" : "Earlier usage is unknown. Retained records show: "}{view.used} requests used, {view.reserved} reserved; {view.unknown} have unknown outcomes. {view.remaining === null ? "No monthly AI request limit is set." : `${view.remaining} requests remain available.`}</Text>
      {(["companion", "planning"] as const).map((feature) => <Text key={feature} size="sm" data-testid={`ai-usage-${feature}`}>{feature === "companion" ? "Companion" : "Planning AI"}: {view.features[feature].used} used, {view.features[feature].reserved} reserved; {view.features[feature].unknown} unknown outcomes.</Text>)}
      <Text size="sm" data-testid="companion-token-usage">{view.historyComplete ? "Reported tokens" : "Earlier token totals are unknown; retained records report"}: {view.reportedInputTokens} input, {view.reportedOutputTokens} output. {view.unknownTokens ? `${view.unknownTokens} requests have unknown token usage; totals are incomplete.` : "Every completed request reported its token usage."}</Text>{view.blocked && <Alert color="yellow">{view.blocked}</Alert>}<Checkbox label="Limit AI requests each month" checked={enabled} onChange={(event) => setEnabled(event.currentTarget.checked)} data-testid="companion-limit-enabled" />{enabled && <NumberInput label="Monthly AI request limit" value={limit ?? ""} onChange={(value) => setLimit(typeof value === "number" ? value : null)} min={0} max={1_000_000} allowDecimal={false} data-testid="companion-limit" />}<Button size="xs" loading={busy} disabled={enabled && limit === null} onClick={async () => { setBusy(true); setError(null); try { await window.nivra.setCompanionLimit(enabled ? limit : null); setRefresh((n) => n + 1); } catch (reason) { setError(errorMessage(reason)); } finally { setBusy(false); } }} data-testid="companion-limit-save">Save AI request limit</Button><Button variant="subtle" size="xs" onClick={() => setRefresh((n) => n + 1)}>Refresh usage</Button></>}
    {monthToConfirm && <Alert color="blue" data-testid="companion-month-confirmation"><Stack gap="xs">
      <Text size="sm">The established budget month is {budget?.period?.label ?? "not set yet"}. By this computer's clock it is {monthToConfirm}. Save and Refresh do not start a new month. Confirm only if the month shown is correct; outstanding requests stay attached to their original month.</Text>
      <Button size="xs" loading={busy} disabled={budget?.recovery !== null} data-testid="companion-month-confirm" onClick={async () => {
        setBusy(true); setError(null);
        try { setBudget(await window.nivra.confirmBudgetMonth(monthToConfirm)); setRefresh((n) => n + 1); }
        catch (reason) { setError(errorMessage(reason)); }
        finally { setBusy(false); }
      }}>Confirm {monthToConfirm} has begun</Button>
    </Stack></Alert>}
    {error && <Alert color="red">{error}</Alert>}
  </Stack></Paper>;
}
