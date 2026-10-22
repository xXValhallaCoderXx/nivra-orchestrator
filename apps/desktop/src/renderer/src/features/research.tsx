import { Alert, Badge, Button, Checkbox, Group, List, Modal, Paper, SegmentedControl, Stack, Text, Textarea, TextInput } from "@mantine/core";
import { useEffect, useRef, useState } from "react";
import type { PlanView, ProjectView, TurnStatus } from "../../../shared/ipc";
import {
  amendmentChoices,
  amendmentDraft,
  CONCLUSION_LABEL,
  evidenceFor,
  initialQuery,
  RESEARCH_CAVEAT,
  RESEARCH_RETENTION,
  requestText,
  ruleText,
  usageText,
  type AssumptionId,
  type Conclusion,
  type Evidence,
  type ResearchAssessmentView,
  type ResearchPageView,
  type ResearchPick,
  type ResearchPreview,
  type ResearchReportView,
  type ResearchSelection,
  type ResearchView,
} from "../../../shared/research";
import { CONSENT_COVERS, ConsentModal, plural, runBudgetText } from "../shared/evidence";
import { useRunEvents } from "../shared/runs";
import { errorMessage } from "../shared/ui";

/**
 * Research of a saved plan version's assumptions (NIV-45). The dialog freezes the queries the person approves and
 * previews exactly what goes to Tavily and what goes to Token Factory; "Start research" is bound to that preview. Each
 * report stays with the version it researched. Web text is shown as text: titles, addresses and passages are never
 * links, and Nivra never opens a page; the person copies an address to look. The assessments are the model's: Nivra
 * checks only that each quotation is in the page it names.
 *
 * Until research's integration window wires it into a plan's card, its calls come in as `ResearchActions`.
 */

/** The calls research makes, as the preload will expose them. */
export interface ResearchActions {
  prepare(planId: string, selection: ResearchSelection): Promise<ResearchPreview>;
  start(planId: string, selection: ResearchSelection, expected: string): Promise<ResearchView>;
  cancel(researchId: string): Promise<ResearchView[]>;
  saveAmended(researchId: string, text: string, assumptions: string[]): Promise<PlanView>;
  setWebResearch(on: boolean): Promise<void>;
}

export const isOpenResearch = (research: ResearchView) => research.status === "submitting" || research.status === "running";

/** What a plan's card needs to offer research: the conversation's research, and why one can't start now. */
export interface PlanResearching {
  research: ResearchView[];
  /** Why no research can start in this conversation now (a turn, a review or research going); null when it can. */
  blocked: string | null;
  /** The conversation's project, for its sharing; null for a general conversation. */
  project: ProjectView | null;
  /** Whether the conversation's engine runs, to follow research's progress. */
  online: boolean;
  actions: ResearchActions;
  onChanged(): void;
  onPermissionChanged(): void;
}

const STATUS_LOOK: Record<TurnStatus, { label: string; color: string }> = {
  submitting: { label: "Sending", color: "gray" },
  running: { label: "Researching", color: "blue" },
  // Complete is about the run, never the plan: no green.
  answered: { label: "Complete", color: "indigo" },
  failed: { label: "Failed", color: "red" },
  cancelled: { label: "Cancelled", color: "gray" },
  interrupted: { label: "Interrupted", color: "yellow" },
  "not-sent": { label: "Not sent", color: "gray" },
  unknown: { label: "Can't tell", color: "yellow" },
};

// Labels about what the passages say, never a verdict on the plan: no green or red.
const CONCLUSION_COLOR: Record<Conclusion, string> = { supported: "blue", contradicted: "orange", unresolved: "gray" };
const WHERE: Record<ResearchAssessmentView["applicability"]["where"], string> = {
  title: "from the page's title",
  address: "from the page's address",
  heading: "from a heading",
  passage: "from the passage",
  unknown: "the model didn't say where",
};
const PAGE_STATUS: Record<ResearchPageView["status"], string> = { read: "read", "not-read": "found, not read", failed: "couldn't be read", refused: "address refused, not sent" };
const plain = { whiteSpace: "pre-wrap", overflowWrap: "anywhere" } as const;

/** A Check assumptions button, and the research of one plan, newest first. */
export function PlanResearch({ versions, researching }: { versions: PlanView[]; researching: PlanResearching }) {
  const latest = versions.at(-1)!;
  const [dialog, setDialog] = useState(false);
  const [amending, setAmending] = useState<ResearchView | null>(null);
  const runs = researching.research.filter((research) => research.planLineage === latest.lineageId).reverse();
  const researched = amending ? versions.find((version) => version.id === amending.planId) : undefined;
  return (
    <Stack gap="xs" data-testid="plan-research">
      <Group gap="xs">
        <Button size="compact-xs" variant="default" onClick={() => setDialog(true)} disabled={researching.blocked !== null} title={researching.blocked ?? undefined} data-testid="plan-research-open">
          Check assumptions…
        </Button>
      </Group>
      {runs.map((research) => (
        <ResearchCard key={research.id} research={research} researching={researching} onAgain={() => setDialog(true)} onAmend={() => setAmending(research)} />
      ))}
      <ResearchDialog opened={dialog} plan={latest} project={researching.project} actions={researching.actions} onClose={() => setDialog(false)} onStarted={researching.onChanged} onPermissionChanged={researching.onPermissionChanged} />
      {amending && researched && <AmendDialog research={amending} plan={researched} actions={researching.actions} onClose={() => setAmending(null)} onSaved={researching.onChanged} />}
    </Stack>
  );
}

/** One assumption picked for research: from the plan's list or typed, and the query the person writes for it. */
interface Row {
  from: ResearchPick["from"];
  text: string;
  query: string;
}

/**
 * Freezes what one research run sends: one to three assumptions of the latest version, each with a query the person
 * writes, and sites if they want. A project's plan's queries start empty, since its assumptions came from repository
 * work; "Use the assumption's words" fills one in only when pressed. Nothing is filled in or rewritten otherwise. Any
 * change clears the preview, and only a preview's own "Start research" sends anything.
 */
function ResearchDialog({
  opened,
  plan,
  project,
  actions,
  onClose,
  onStarted,
  onPermissionChanged,
}: {
  opened: boolean;
  plan: PlanView;
  project: ProjectView | null;
  actions: ResearchActions;
  onClose(): void;
  onStarted(): void;
  onPermissionChanged(): void;
}) {
  const scope = plan.projectId ? "project" : "general";
  const [rows, setRows] = useState<Row[]>([]);
  const [typing, setTyping] = useState("");
  const [sites, setSites] = useState("");
  const [mode, setMode] = useState<"prefer" | "restrict">("prefer");
  // The preview, with the selection it was made from: Start sends exactly that selection.
  const [previewed, setPreviewed] = useState<{ preview: ResearchPreview; selection: ResearchSelection } | null>(null);
  const preview = previewed?.preview ?? null;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState<"web" | "sharing" | null>(null);
  // Counts the form's changes: a preview asked for before the latest one is dropped when it arrives.
  const asked = useRef(0);

  useEffect(() => {
    if (!opened) return;
    asked.current++;
    setRows([]);
    setTyping("");
    setSites("");
    setMode("prefer");
    setPreviewed(null);
    setError(null);
  }, [opened, plan.id]);

  const selection = (): ResearchSelection => {
    const hosts = sites.split(/[\s,]+/).filter(Boolean);
    return { assumptions: rows.map((row) => ({ from: row.from, query: row.query })), sites: hosts.length ? { mode, hosts } : null };
  };
  /** Any change makes the preview stale: it is cleared, one still on its way is dropped, and Start waits for a new one. */
  const change = (update: () => void) => {
    asked.current++;
    setPreviewed(null);
    setError(null);
    update();
  };
  const full = rows.length >= 3;
  const picked = (index: number) => rows.some((row) => row.from.kind === "plan" && row.from.index === index);

  async function prepare() {
    const mine = ++asked.current;
    const chosen = selection();
    setBusy(true);
    setError(null);
    try {
      const value = await actions.prepare(plan.id, chosen);
      if (mine === asked.current) setPreviewed({ preview: value, selection: chosen });
    } catch (reason) {
      if (mine === asked.current) setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  async function start() {
    if (!previewed) return;
    setBusy(true);
    setError(null);
    try {
      await actions.start(previewed.preview.planId, previewed.selection, previewed.preview.expected);
      onStarted();
      onClose();
    } catch (reason) {
      // Whatever stopped it, nothing was sent: the preview is cleared, so a new start shows what it would send first.
      asked.current++;
      setError(errorMessage(reason));
      setPreviewed(null);
    } finally {
      setBusy(false);
    }
  }

  async function allowWeb() {
    setAsking(null);
    setError(null);
    try {
      await actions.setWebResearch(true);
      onPermissionChanged();
      await prepare();
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }

  async function allowSharing() {
    setAsking(null);
    if (!project) return;
    setError(null);
    try {
      await window.nivra.setSharing(project.id, true);
      onPermissionChanged();
      await prepare();
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }

  const sharingOff = preview?.scope.kind === "project" && !preview.scope.sharing;
  return (
    <>
      <Modal opened={opened && asking === null} onClose={onClose} title={`Check assumptions in plan v${plan.version}`} size="lg" data-testid="research-dialog">
        <Stack gap="sm">
          <Text size="sm">
            Pick up to three assumptions. Nivra searches the web with the queries you write here, exactly as written, reads passages from the pages found, and asks the
            model whether they support each assumption.
          </Text>
          {plan.assumptions.length > 0 && (
            <Stack gap={4} data-testid="research-plan-assumptions">
              <Text size="sm" fw={600}>
                The plan's assumptions
              </Text>
              {plan.assumptions.map((assumption, index) => (
                <Checkbox
                  key={index}
                  label={assumption}
                  checked={picked(index)}
                  disabled={full && !picked(index)}
                  onChange={(event) => {
                    const on = event.currentTarget.checked;
                    change(() =>
                      setRows((current) =>
                        on ? [...current, { from: { kind: "plan", index }, text: assumption, query: initialQuery(scope, assumption) }] : current.filter((row) => !(row.from.kind === "plan" && row.from.index === index)),
                      ),
                    );
                  }}
                  data-testid="research-pick"
                />
              ))}
            </Stack>
          )}
          <Group gap="xs" align="flex-end">
            <TextInput
              label="Or type an assumption"
              value={typing}
              onChange={(event) => setTyping(event.currentTarget.value)}
              disabled={full}
              style={{ flex: 1 }}
              data-testid="research-type"
            />
            <Button
              variant="default"
              disabled={full || !typing.trim()}
              onClick={() =>
                change(() => {
                  const text = typing.trim();
                  setRows((current) => [...current, { from: { kind: "typed", text }, text, query: initialQuery(scope, text) }]);
                  setTyping("");
                })
              }
              data-testid="research-add"
            >
              Add
            </Button>
          </Group>
          {rows.map((row, index) => (
            <Paper key={`${index}-${row.text}`} withBorder p="xs" radius="sm" data-testid="research-row">
              <Stack gap={6}>
                <Group justify="space-between" wrap="nowrap">
                  <Text size="sm" style={plain}>
                    <Text span fw={600}>
                      A{index + 1}
                    </Text>{" "}
                    {row.from.kind === "plan" ? `(the plan's assumption ${row.from.index + 1})` : "(typed)"} {row.text}
                  </Text>
                  <Button size="compact-xs" variant="subtle" onClick={() => change(() => setRows((current) => current.filter((_, i) => i !== index)))} data-testid="research-remove">
                    Remove
                  </Button>
                </Group>
                <TextInput
                  label="Query sent to Tavily"
                  value={row.query}
                  onChange={(event) => {
                    const query = event.currentTarget.value;
                    change(() => setRows((current) => current.map((other, i) => (i === index ? { ...other, query } : other))));
                  }}
                  data-testid="research-query"
                />
                {scope === "project" && row.query !== row.text && (
                  <Group>
                    <Button size="compact-xs" variant="default" onClick={() => change(() => setRows((current) => current.map((other, i) => (i === index ? { ...other, query: other.text } : other))))} data-testid="research-use-words">
                      Use the assumption's words
                    </Button>
                  </Group>
                )}
              </Stack>
            </Paper>
          ))}
          <Group gap="xs" align="flex-end">
            <TextInput
              label="Sites (optional)"
              description="Host names only, such as docs.python.org, separated by commas."
              value={sites}
              onChange={(event) => {
                const value = event.currentTarget.value;
                change(() => setSites(value));
              }}
              style={{ flex: 1 }}
              data-testid="research-sites"
            />
            <SegmentedControl
              size="xs"
              value={mode}
              onChange={(value) => change(() => setMode(value === "restrict" ? "restrict" : "prefer"))}
              data={[
                { value: "prefer", label: "Prefer these" },
                { value: "restrict", label: "Only these" },
              ]}
              data-testid="research-sites-mode"
            />
          </Group>
          {preview && <PreviewBody preview={preview} />}
          {preview?.blocked && (
            <Alert color="yellow" variant="light" data-testid="research-blocked">
              <Stack gap={6}>
                <Text size="sm">{preview.blocked}</Text>
                {!preview.webResearch && (
                  <Group>
                    <Button size="xs" variant="default" onClick={() => setAsking("web")} data-testid="research-allow-web">
                      Turn on research queries to Tavily…
                    </Button>
                  </Group>
                )}
                {preview.webResearch && sharingOff && project && (
                  <Group>
                    <Button size="xs" variant="default" onClick={() => setAsking("sharing")} data-testid="research-allow-sharing">
                      Allow sharing for {project.label}…
                    </Button>
                  </Group>
                )}
              </Stack>
            </Alert>
          )}
          {error && (
            <Text size="sm" c="var(--nivra-error)" data-testid="research-error">
              {error}
            </Text>
          )}
          <Group justify="flex-end" gap="sm">
            <Button variant="default" onClick={onClose} data-testid="research-dialog-cancel">
              Cancel
            </Button>
            {preview ? (
              <Button onClick={() => void start()} loading={busy} disabled={preview.blocked !== null} data-testid="research-start">
                Start research
              </Button>
            ) : (
              <Button onClick={() => void prepare()} loading={busy} disabled={rows.length === 0} data-testid="research-preview-button">
                Preview what is sent
              </Button>
            )}
          </Group>
        </Stack>
      </Modal>
      <WebResearchModal opened={opened && asking === "web"} onClose={() => setAsking(null)} onAllow={() => void allowWeb()} />
      <ConsentModal
        opened={opened && asking === "sharing"}
        onClose={() => setAsking(null)}
        onAllow={() => void allowSharing()}
        intro={`To check the assumptions of plans from conversations about ${project?.label ?? "this project"}, Nivra sends Nebius Token Factory:`}
        sends={["the plan version's text and the assumptions you pick;", "passages read from public web pages."]}
        after={CONSENT_COVERS}
        testId="research-consent"
      />
    </>
  );
}

/**
 * The app-wide permission to send research queries to Tavily, separate from a project's sharing with Token Factory and
 * from sandbox uploads. Each run still waits for its own "Start research".
 */
function WebResearchModal({ opened, onClose, onAllow }: { opened: boolean; onClose(): void; onAllow(): void }) {
  return (
    <Modal opened={opened} onClose={onClose} title="Send research queries to Tavily?" data-testid="research-permission">
      <Stack gap="sm">
        <Text size="sm">Research sends Tavily, a web search service:</Text>
        <List size="sm">
          <List.Item>the queries you approve for each run, exactly as the preview shows them;</List.Item>
          <List.Item>the addresses of pages its own search returned, so it can read passages from them;</List.Item>
          <List.Item>the sites you list, if any.</List.Item>
        </List>
        <Text size="sm">
          Never the plan's text, your repositories, their paths, your preferences or your conversations. Nivra checks each query for keys, addresses, paths and your
          projects' names before it is sent, but those checks can't catch everything: read each query before you start.
        </Text>
        <Text size="sm">{RESEARCH_RETENTION}</Text>
        <Text size="sm">
          This is for the whole app, apart from sharing a project with Token Factory or uploading it to a sandbox. Each run still waits for you to start it. Turning it
          off stops further requests and cancels research where it can.
        </Text>
        <Group justify="flex-end" gap="sm">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={onAllow} data-testid="research-permission-allow">
            Turn on
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

function PreviewBody({ preview }: { preview: ResearchPreview }) {
  const { tavily, model, limits, scope } = preview;
  return (
    <Stack gap="xs" data-testid="research-preview" data-plan-version={preview.planVersion}>
      <Text size="sm" c="var(--nivra-text-2)" data-testid="research-preview-scope">
        {scope.kind === "general" ? "A general plan: no repository." : `${scope.projectLabel} · ${scope.targetLabel} · sharing ${scope.sharing ? "on" : "off"}`}
      </Text>
      <Stack gap={4}>
        <Text size="sm" fw={600}>
          Sent to Tavily
        </Text>
        <List size="sm" data-testid="research-preview-queries">
          {tavily.queries.map((query) => (
            <List.Item key={query.assumption} data-testid="research-preview-query" data-problems={query.problems.length}>
              {query.assumption}:{" "}
              <Text span ff="monospace" size="sm" style={plain}>
                {query.query || "(empty)"}
              </Text>
              {query.problems.length > 0 && (
                <Text size="xs" c="var(--nivra-error)">
                  This query {query.problems.join(", and ")}, so it can't be sent.
                </Text>
              )}
            </List.Item>
          ))}
          <List.Item>The addresses of the pages its search returns, so it can read passages from them.</List.Item>
          {tavily.sites && (
            <List.Item>
              {tavily.sites.mode === "prefer" ? "Sites to prefer" : "The only sites to search"}: {tavily.sites.hosts.join(", ")}
            </List.Item>
          )}
        </List>
      </Stack>
      <Stack gap={4}>
        <Text size="sm" fw={600}>
          Sent to Nebius Token Factory
        </Text>
        <List size="sm" data-testid="research-preview-model">
          <List.Item>The plan's text: {plural(model.planChars, "character")}.</List.Item>
          <List.Item>
            The assumptions in full:
            <List size="sm" withPadding>
              {model.assumptions.map((assumption) => (
                <List.Item key={assumption.id}>
                  {assumption.id}
                  {assumption.fromPlan !== null ? ` (the plan's ${assumption.fromPlan + 1})` : ""}: {assumption.text}
                </List.Item>
              ))}
            </List>
          </List.Item>
          <List.Item>The passages read from those pages.</List.Item>
        </List>
      </Stack>
      <Text size="sm" data-testid="research-preview-not-sent">
        Not sent: the repository's files, this conversation, other plans or versions, your preferences and your tasks.
      </Text>
      <Text size="sm" data-testid="research-preview-limits">
        At most {plural(limits.searches, "search", "searches")} and {plural(limits.extracts, "read")} of up to {plural(limits.pages, "page")} in all, {plural(limits.modelRequests, "model call")}, {plural(limits.credits, "Tavily credit")} and {limits.seconds} seconds. Nothing
        is retried.
      </Text>
      <Text size="xs" c="var(--nivra-text-3)">
        Nivra checks each query for keys, addresses, paths and your projects' names. The checks can't catch everything: read each query before you start. {RESEARCH_RETENTION}
      </Text>
    </Stack>
  );
}

function ResearchCard({ research, researching, onAgain, onAmend }: { research: ResearchView; researching: PlanResearching; onAgain(): void; onAmend(): void }) {
  const open = isOpenResearch(research);
  const report = research.report;
  const look = STATUS_LOOK[research.status];
  const [error, setError] = useState<string | null>(null);
  const choices = report ? amendmentChoices(report) : [];
  const amendable = research.status === "answered" && research.amended === null && research.latestVersion === research.planVersion;

  async function cancel() {
    setError(null);
    try {
      await researching.actions.cancel(research.id);
      researching.onChanged();
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }

  return (
    <Paper withBorder p="sm" radius="md" data-testid="research" data-research-id={research.id} data-status={research.status} data-plan-version={research.planVersion}>
      <Stack gap={8}>
        <Group justify="space-between" wrap="nowrap">
          <Group gap="xs">
            <Text size="xs" fw={600}>
              Research · v{research.planVersion}
            </Text>
            <Badge color={look.color} variant="light" data-testid="research-status">
              {open && research.cancelRequested ? "Cancelling" : look.label}
            </Badge>
          </Group>
          {open ? (
            <Button size="compact-xs" variant="default" onClick={() => void cancel()} disabled={research.cancelRequested} data-testid="research-cancel">
              Cancel
            </Button>
          ) : (
            <Button size="compact-xs" variant="subtle" onClick={onAgain} disabled={researching.blocked !== null} data-testid="research-again">
              Check again
            </Button>
          )}
        </Group>
        {research.latestVersion > research.planVersion && (
          <Text size="xs" c="var(--nivra-warning)" data-testid="research-stale">
            The plan is now at v{research.latestVersion}. This research is of v{research.planVersion}, and stays as it was.
          </Text>
        )}
        <Text size="xs" c="var(--nivra-text-2)" style={plain} data-testid="research-queries">
          Approved queries: {research.queries.map((query) => `${query.assumption} “${query.query}”`).join(" · ")}
          {research.sites ? ` · ${research.sites.mode === "prefer" ? "preferring" : "only"} ${research.sites.hosts.join(", ")}` : ""}
        </Text>
        {open && research.runId && <ResearchProgress runId={research.runId} online={researching.online} />}
        {research.note && (
          <Text size="sm" c="var(--nivra-text-2)" data-testid="research-note">
            {research.note}
          </Text>
        )}
        {research.unresolved && (
          <Text size="sm" c="var(--nivra-warning)" data-testid="research-unresolved">
            {research.unresolved}
          </Text>
        )}
        {error && (
          <Text size="sm" c="var(--nivra-error)" data-testid="research-card-error">
            {error}
          </Text>
        )}
        {report && <Report report={report} />}
        {research.amended ? (
          <Text size="xs" data-testid="research-amended">
            Saved as v{research.amended.version} from this research.
          </Text>
        ) : (
          report &&
          research.status === "answered" && (
            <Group gap="xs">
              <Button size="compact-xs" variant="default" onClick={onAmend} disabled={!amendable} title={amendable ? undefined : "Only research of the latest version can be saved as its next version."} data-testid="research-amend">
                Save as v{research.planVersion + 1}…
              </Button>
              <Text size="xs" c="var(--nivra-text-3)">
                {choices.length ? `${plural(choices.length, "amendment")} offered.` : "No amendments offered."}
              </Text>
            </Group>
          )
        )}
        <Text size="xs" c="var(--nivra-text-3)" data-testid="research-not-approval">
          Research doesn't change the plan, mark a task ready, or approve anything.
        </Text>
        <Text size="xs" c="var(--nivra-text-3)" data-testid="research-binding">
          packet {research.packetDigest.slice(0, 12)}
        </Text>
      </Stack>
    </Paper>
  );
}

/** What research in progress is doing, from its run's events: counts and ids only. */
function ResearchProgress({ runId, online }: { runId: string; online: boolean }) {
  const { events } = useRunEvents(runId, online, "running");
  const latest = [...events].reverse().find((event) => event.type === "step.output" || event.type === "model.call");
  return latest ? (
    <Text size="xs" c="var(--nivra-text-3)" data-testid="research-progress">
      {latest.message}
    </Text>
  ) : null;
}

function Report({ report }: { report: ResearchReportView }) {
  return (
    <Stack gap="sm" data-testid="research-report" data-outcome={report.outcome}>
      {report.stop && (
        <Text size="sm" data-testid="research-stop">
          {report.stop.message}
        </Text>
      )}
      {report.assessments.map((assessment) => (
        <Assessment key={assessment.assumption} assessment={assessment} report={report} />
      ))}
      {report.checks.relabelled > 0 && (
        <Text size="xs" c="var(--nivra-text-3)" data-testid="research-relabelled">
          {plural(report.checks.relabelled, "assessment")} shown as unresolved by the rules above. {plural(report.checks.valid, "quotation")} of {report.checks.citations} found in the pages read.
        </Text>
      )}
      <Pages pages={report.pages} />
      <Stack gap={2} data-testid="research-requests">
        <Text size="xs" fw={600}>
          Requests
        </Text>
        {report.requests.map((request) => (
          <Text key={request.id} size="xs" data-testid="research-request" data-state={request.state}>
            {requestText(request, report.outcome)}
          </Text>
        ))}
      </Stack>
      <Text size="xs" c="var(--nivra-text-3)" data-testid="research-usage">
        {report.route ? `${report.route.model}${report.route.endpoint === "loopback-test" ? " (test endpoint)" : ""}` : "Model unknown"} · {(report.elapsedMs / 1000).toFixed(1)} s · {usageText(report)}
        {report.budget ? `. ${runBudgetText(report.budget)}` : ""}
      </Text>
    </Stack>
  );
}

function Assessment({ assessment, report }: { assessment: ResearchAssessmentView; report: ResearchReportView }) {
  const query = report.queries.find((item) => item.assumption === assessment.assumption);
  const why = ruleText(assessment);
  const { shown, left } = evidenceFor(report, assessment);
  const { applicability } = assessment;
  return (
    <Stack gap={4} data-testid="research-assessment" data-assumption={assessment.assumption} data-shown={assessment.shown} data-rule={assessment.rule ?? ""}>
      <Group gap={6} wrap="nowrap" align="flex-start">
        <Badge size="sm" variant="outline" style={{ textTransform: "none" }}>
          {assessment.assumption}
        </Badge>
        <Badge size="sm" variant="light" color={CONCLUSION_COLOR[assessment.shown]} style={{ textTransform: "none" }} data-testid="research-shown">
          {CONCLUSION_LABEL[assessment.shown]}
        </Badge>
        <Text size="sm" fw={600} style={plain}>
          {query?.text ?? ""}
        </Text>
      </Group>
      <Text size="xs" c="var(--nivra-text-3)">
        The model's assessment, from the passages Nivra read.
      </Text>
      {why && (
        <Text size="sm" data-testid="research-rule">
          {why}
        </Text>
      )}
      {assessment.reasoning && (
        <Text size="sm" style={plain} data-testid="research-reasoning">
          {assessment.reasoning}
        </Text>
      )}
      {(applicability.plan || applicability.source) && (
        <Text size="xs" style={plain} data-testid="research-applicability">
          The plan means {applicability.plan || "no particular version"}; the sources are about {applicability.source || "no particular version"} ({WHERE[applicability.where]}).
        </Text>
      )}
      {assessment.uncertainty && (
        <Text size="xs" style={plain}>
          Uncertain: {assessment.uncertainty}
        </Text>
      )}
      {shown.map((evidence, index) => (
        <Quote key={`${index}-${evidence.passage.id}`} evidence={evidence} />
      ))}
      {left > 0 && (
        <Text size="xs" c="var(--nivra-text-3)" data-testid="research-left-out">
          {plural(left, "quotation")} the model gave {left === 1 ? "wasn't" : "weren't"} found in the passage {left === 1 ? "it names" : "they name"}, and {left === 1 ? "is" : "are"} left out.
        </Text>
      )}
      {assessment.amendment?.kind === "model" && assessment.shown === "contradicted" && shown.length > 0 && (
        <Text size="sm" style={plain} data-testid="research-amendment">
          From web research, the model suggests: {assessment.amendment.text}
        </Text>
      )}
      <Text size="xs" c="var(--nivra-text-3)" data-testid="research-caveat">
        {RESEARCH_CAVEAT}
      </Text>
    </Stack>
  );
}

/** A quotation Nivra found, its passage on request, and its page: title, host and address, as text to read and copy. */
function Quote({ evidence }: { evidence: Evidence }) {
  const [passage, setPassage] = useState(false);
  const { page } = evidence;
  return (
    <Stack gap={2} style={{ borderLeft: "3px solid var(--nivra-border)", paddingLeft: 8 }} data-testid="research-evidence" data-passage={evidence.passage.id}>
      <Text size="sm" style={plain} data-testid="research-quote">
        “{evidence.quote}”
      </Text>
      <Text size="xs" c="var(--nivra-text-2)" style={plain}>
        {evidence.stance === "supports" ? "Supports it" : "Contradicts it"}, by the model's reading · {page.title || "Untitled page"} · {page.host}
        {evidence.passage.heading ? ` · under “${evidence.passage.heading}”` : ""}
      </Text>
      <Text size="xs" ff="monospace" style={{ ...plain, userSelect: "text" }} data-testid="research-address">
        {page.address}
      </Text>
      <Group gap="xs">
        <Button size="compact-xs" variant="subtle" onClick={() => setPassage((on) => !on)} data-testid="research-show-passage">
          {passage ? "Hide the passage" : "Show the passage"}
        </Button>
      </Group>
      {passage && (
        <Text size="xs" style={plain} data-testid="research-passage">
          {evidence.passage.text}
          {evidence.passage.clipped ? " [clipped]" : ""}
        </Text>
      )}
    </Stack>
  );
}

function Pages({ pages }: { pages: ResearchPageView[] }) {
  if (pages.length === 0) return null;
  return (
    <Stack gap={4} data-testid="research-pages">
      <Text size="xs" fw={600}>
        Pages its searches found
      </Text>
      {pages.map((page) => (
        <Stack key={page.id} gap={0} data-testid="research-page" data-status={page.status}>
          <Text size="xs" style={plain}>
            {page.id} · {page.title || "Untitled page"} · {page.host} · {PAGE_STATUS[page.status]} · found for {page.foundBy.map((found) => `${found.assumption} (#${found.rank})`).join(", ")}
          </Text>
          <Text size="xs" ff="monospace" c="var(--nivra-text-3)" style={{ ...plain, userSelect: "text" }}>
            {page.address}
          </Text>
        </Stack>
      ))}
    </Stack>
  );
}

/**
 * Saves the researched version's next version from what the person ticks and writes. The text starts as the researched
 * text plus the ticked amendments, each naming its sites; once the person edits it, ticking leaves it alone. The
 * assumptions start as the researched version's. Nothing is saved until the person saves.
 */
function AmendDialog({ research, plan, actions, onClose, onSaved }: { research: ResearchView; plan: PlanView; actions: ResearchActions; onClose(): void; onSaved(): void }) {
  const choices = research.report ? amendmentChoices(research.report) : [];
  const [ticked, setTicked] = useState<AssumptionId[]>([]);
  const [text, setText] = useState(plan.text);
  const [edited, setEdited] = useState(false);
  // One assumption a line: one written over several lines is joined, so the list saves as it reads.
  const [assumptions, setAssumptions] = useState(plan.assumptions.map((assumption) => assumption.replace(/\s*\n\s*/g, " ")).join("\n"));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const chosen = choices.filter((choice) => ticked.includes(choice.assumption));
  /** The ticks change the text only while the person hasn't edited it. */
  const tick = (next: AssumptionId[]) => {
    setTicked(next);
    setText(amendmentDraft(plan.text, choices.filter((choice) => next.includes(choice.assumption))));
  };

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await actions.saveAmended(research.id, text, assumptions.split("\n"));
      onSaved();
      onClose();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal opened onClose={onClose} title={`Save plan v${research.planVersion + 1}`} size="lg" data-testid="research-amend-dialog">
      <Stack gap="sm">
        {choices.length === 0 ? (
          <Text size="sm">This research offers no amendments. You can still edit the plan and save its next version.</Text>
        ) : (
          <Stack gap={4} data-testid="research-amend-choices">
            <Text size="sm" fw={600}>
              Amendments to add
            </Text>
            {choices.map((choice) => (
              <Checkbox
                key={choice.assumption}
                checked={ticked.includes(choice.assumption)}
                disabled={edited}
                onChange={(event) => tick(event.currentTarget.checked ? [...ticked, choice.assumption] : ticked.filter((id) => id !== choice.assumption))}
                label={`${choice.assumption} · ${choice.amendment.kind === "model" ? `from web research (${choice.hosts.join(", ")})` : "unverified"}: ${choice.amendment.text}`}
                data-testid="research-amend-choice"
              />
            ))}
            {edited && (
              <Group gap="xs">
                <Text size="xs" c="var(--nivra-text-3)">
                  You've edited the text, so ticking no longer changes it.
                </Text>
                <Button
                  size="compact-xs"
                  variant="subtle"
                  onClick={() => {
                    setEdited(false);
                    tick(ticked);
                  }}
                  data-testid="research-amend-reset"
                >
                  Start again from the ticked amendments
                </Button>
              </Group>
            )}
          </Stack>
        )}
        <Textarea
          label="Plan"
          autosize
          minRows={6}
          maxRows={18}
          value={text}
          onChange={(event) => {
            setEdited(true);
            setText(event.currentTarget.value);
          }}
          data-testid="research-amend-text"
        />
        <Textarea
          label="Assumptions"
          description="What the plan takes as true without checking. One per line."
          autosize
          minRows={2}
          maxRows={8}
          value={assumptions}
          onChange={(event) => setAssumptions(event.currentTarget.value)}
          data-testid="research-amend-assumptions"
        />
        <Text size="xs" c="var(--nivra-text-3)">
          {chosen.length ? `${plural(chosen.length, "amendment")} added. ` : ""}v{research.planVersion} and this research stay as they are.
        </Text>
        {error && (
          <Text size="sm" c="var(--nivra-error)" data-testid="research-amend-error">
            {error}
          </Text>
        )}
        <Group justify="flex-end" gap="sm">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void save()} loading={busy} data-testid="research-amend-save">
            Save v{research.planVersion + 1}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
