import { Alert, Badge, Box, Button, Group, Paper, Stack, Text, Textarea, TextInput, Title } from "@mantine/core";
import { useEffect, useRef, useState } from "react";
import type { CompanionAction, CompanionContextView, CompanionHint, CompanionSettingsView, CompanionTurnView, KnowledgeView, MissionView, ProjectInspectionView } from "../../../shared/ipc";
import { CONSENT_COVERS, ConsentModal } from "../shared/evidence";
import { errorMessage } from "../shared/ui";
import { dialogOpen } from "../shell/keyboard";
import { appendDialogue, guidedBrief, hintKey, separateLines, type CompanionLine } from "./companion-state";

export type CompanionMode = "work" | "idea" | "setup";
export interface CompanionHandle { open(mode?: CompanionMode): void }

interface Buffer {
  sessionId: string;
  lines: CompanionLine[];
  composer: string;
  requestId: string | null;
  answering: boolean;
  askedFrom: string | null;
  error: string | null;
  actions: CompanionAction[];
  epoch: string | null;
  projectId: string | null;
  retained: KnowledgeView[];
  proposals: string[];
}
const freshBuffer = (): Buffer => ({ sessionId: crypto.randomUUID(), lines: [], composer: "", requestId: null, answering: false, askedFrom: null, error: null, actions: [], epoch: null, projectId: null, retained: [], proposals: [] });
const emptySettings: CompanionSettingsView = { hidden: false, invitationDismissed: false };

/** One optional surface over native work. Its text lives only in these session buffers, never in DraftStore. */
export function Companion({ hint, narrow, handle, onNavigate, onAdd, onExplain, onVisibilityChange, projectIds, refreshKey = 0 }: {
  hint: CompanionHint;
  narrow: boolean;
  handle: { current: CompanionHandle | null };
  onNavigate(action: CompanionAction): void;
  onAdd(): void;
  onExplain(projectId: string): void;
  onVisibilityChange(open: boolean): void;
  projectIds: readonly string[];
  refreshKey?: number;
}) {
  const key = hintKey(hint);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<CompanionMode>("work");
  const [settings, setSettings] = useState(emptySettings);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [loadedContext, setContext] = useState<CompanionContextView | null>(null);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const context = loadedKey === key ? loadedContext : null;
  const [contextError, setContextError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [sharingConsent, setSharingConsent] = useState(false);
  const [proposal, setProposal] = useState<{ action: CompanionAction; sessionId: string; requestId: string; fingerprint: string } | null>(null);
  const buffers = useRef(new Map<string, Buffer>());
  const [, render] = useState(0);
  const launcher = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  if (!buffers.current.has(key)) buffers.current.set(key, freshBuffer());
  const buffer = buffers.current.get(key)!;
  const patch = (bufferKey: string, sessionId: string, update: Partial<Buffer>) => {
    const current = buffers.current.get(bufferKey);
    if (!current || current.sessionId !== sessionId) return;
    buffers.current.set(bufferKey, { ...current, ...update });
    render((n) => n + 1);
  };
  const receive = (bufferKey: string, sessionId: string, requestId: string, result: CompanionTurnView) => {
    const latest = buffers.current.get(bufferKey);
    if (!latest || latest.sessionId !== sessionId || latest.requestId !== requestId || !latest.answering || result.status === "running") return;
    patch(bufferKey, sessionId, {
      answering: false,
      lines: result.reply ? appendDialogue(latest.lines, { role: "assistant", text: result.reply }) : latest.lines,
      actions: result.actions ?? [], retained: result.retained ?? [], proposals: result.proposals ?? [],
      askedFrom: result.fingerprint ?? result.actions?.find((action) => action.fingerprint)?.fingerprint ?? latest.askedFrom,
      epoch: result.dialogueEpoch ?? latest.epoch,
      error: result.status === "answered" ? null : result.message ?? `The companion turn ${result.status}. Ask again when you're ready.`,
    });
  };
  const dismiss = () => {
    setOpen(false);
    requestAnimationFrame(() => launcher.current?.focus());
  };
  handle.current = { open: (next = "work") => { setMode(next); setOpen(true); setRefresh((n) => n + 1); } };
  useEffect(() => onVisibilityChange(open), [open, onVisibilityChange]);
  useEffect(() => {
    const active = buffers.current.get(key);
    if (active) { buffers.current.delete(key); buffers.current.set(key, active); }
    // Keep at most eight scope sessions. Eviction ends the old session, including a turn still in progress.
    while (buffers.current.size > 8) {
      const oldest = buffers.current.entries().next().value as [string, Buffer] | undefined;
      if (!oldest) break;
      buffers.current.delete(oldest[0]);
      void window.nivra.endCompanionSession(oldest[1].sessionId).catch(() => undefined);
    }
  }, [key]);
  useEffect(() => {
    for (const [bufferKey, value] of buffers.current) {
      const projectId = value.projectId ?? (bufferKey.startsWith("project:") ? bufferKey.slice(8) : null);
      if (projectId && !projectIds.includes(projectId)) {
        void window.nivra.endCompanionSession(value.sessionId).catch(() => undefined);
        buffers.current.delete(bufferKey);
      }
    }
    render((n) => n + 1);
  }, [JSON.stringify(projectIds)]);

  useEffect(() => {
    let active = true;
    window.nivra.getCompanionSettings().then((value) => { if (active) setSettings(value); }, (reason: unknown) => { if (active) setSettingsError(errorMessage(reason)); });
    return () => { active = false; };
  }, [refreshKey]);

  useEffect(() => {
    if (!open) return;
    let active = true;
    let reading = 0;
    setContextError(null);
    const read = async () => {
      const readId = ++reading;
      const readSessionId = buffers.current.get(key)?.sessionId;
      const valid = () => active && readId === reading && buffers.current.get(key)?.sessionId === readSessionId;
      try {
        let value = await window.nivra.getCompanionContext(hint);
        if (!valid()) return;
        let current = buffers.current.get(key);
        if (current && current.epoch !== null && current.epoch !== value.dialogueEpoch && current.requestId) {
          const sessionId = current.sessionId;
          const requestId = current.requestId;
          // Own retained outcomes change the epoch before the answer RPC finishes. Read that same turn, never resend it,
          // then check fresh context: external edits/forgetting interrupt it in the host and must still clear this buffer.
          const result = await window.nivra.getCompanionTurn(sessionId, requestId);
          if (!valid() || buffers.current.get(key)?.requestId !== requestId) return;
          value = await window.nivra.getCompanionContext(hint);
          if (!valid() || buffers.current.get(key)?.requestId !== requestId) return;
          if (result.status === "answered" && result.dialogueEpoch === value.dialogueEpoch) receive(key, sessionId, requestId, result);
          current = buffers.current.get(key);
        }
        if (current && current.epoch !== null && current.epoch !== value.dialogueEpoch) {
          void window.nivra.endCompanionSession(current.sessionId).catch(() => undefined);
          buffers.current.set(key, { ...freshBuffer(), epoch: value.dialogueEpoch, projectId: value.sources.find((source) => source.kind === "project")?.id ?? null });
          render((n) => n + 1);
        } else if (current) {
          current.epoch = value.dialogueEpoch;
          current.projectId = value.sources.find((source) => source.kind === "project")?.id ?? null;
        }
        setContext(value); setLoadedKey(key); setContextError(null);
      } catch (reason) {
        if (!valid()) return;
        setContext(null);
        setContextError(errorMessage(reason));
        // Removed work or revoked sharing must not leave its dialogue visible under another scope.
        const current = buffers.current.get(key);
        if (current) {
          void window.nivra.endCompanionSession(current.sessionId).catch(() => undefined);
          buffers.current.set(key, freshBuffer());
          render((n) => n + 1);
        }
      }
    };
    void read();
    const timer = window.setInterval(() => void read(), 5_000);
    return () => { active = false; clearInterval(timer); };
    // The key contains all route IDs. Local refreshes make no model request.
  }, [open, key, refresh, refreshKey]);

  useEffect(() => {
    if (!open) return;
    panel.current?.focus();
    const escape = (event: KeyboardEvent) => {
      if (event.defaultPrevented || dialogOpen()) return;
      if (narrow && event.key === "Tab" && panel.current) {
        const focusable = [...panel.current.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])')].filter((element) => element.getClientRects().length > 0);
        const first = focusable[0]; const last = focusable.at(-1);
        if (first && last && (!panel.current.contains(document.activeElement) || document.activeElement === panel.current || (!event.shiftKey && document.activeElement === last) || (event.shiftKey && document.activeElement === first))) {
          event.preventDefault(); (event.shiftKey ? last : first).focus();
        }
      }
      if (event.key !== "Escape") return;
      if (event.target instanceof Element && event.target.closest("[data-mantine-stop-propagation]")) return;
      event.preventDefault();
      dismiss();
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [open, narrow]);

  // Poll every outstanding scope independently. Switching pages never moves a reply to another dialogue.
  useEffect(() => {
    let active = true;
    const poll = async () => {
      await Promise.all([...buffers.current.entries()].filter(([, value]) => value.answering && value.requestId).map(async ([bufferKey, value]) => {
        try {
          const result = await window.nivra.getCompanionTurn(value.sessionId, value.requestId!);
          if (!active || result.status === "running") return;
          receive(bufferKey, value.sessionId, value.requestId!, result);
        } catch (reason) {
          if (active && buffers.current.get(bufferKey)?.requestId === value.requestId) patch(bufferKey, value.sessionId, { error: `${errorMessage(reason)} Nivra is checking the same request; it won't resend it.` });
        }
      }));
    };
    const timer = window.setInterval(() => void poll(), 800);
    return () => { active = false; clearInterval(timer); };
  }, []);

  const saveSettings = async (change: Partial<CompanionSettingsView>) => {
    try { setSettings(await window.nivra.setCompanionSettings(change)); setSettingsError(null); return true; }
    catch (reason) { setSettingsError(errorMessage(reason)); return false; }
  };
  const send = async () => {
    const current = buffers.current.get(key)!;
    const message = current.composer.trim();
    if (!message || current.answering || !context?.canAsk) return;
    const requestId = crypto.randomUUID();
    // This synchronous change also guards a second click before React renders.
    patch(key, current.sessionId, { composer: "", answering: true, requestId: null, error: null, actions: [], retained: [], proposals: [], askedFrom: context.fingerprint, lines: appendDialogue(current.lines, { role: "user", text: message }) });
    try {
      const started = await window.nivra.sendCompanionTurn({ sessionId: current.sessionId, clientRequestId: requestId, hint, message });
      patch(key, current.sessionId, { requestId: started.requestId });
    } catch (reason) {
      // The host records dispatch before sending. A later retry is an explicit new turn, never an automatic replay.
      patch(key, current.sessionId, { answering: false, error: errorMessage(reason) });
    }
  };
  const end = async () => {
    const current = buffers.current.get(key)!;
    const cleared = freshBuffer();
    // Ending is a local privacy action even when the owning engine can't acknowledge cancellation.
    buffers.current.set(key, cleared);
    setProposal(null);
    setRefresh((n) => n + 1);
    render((n) => n + 1);
    try {
      await window.nivra.endCompanionSession(current.sessionId);
    } catch (reason) { patch(key, cleared.sessionId, { error: errorMessage(reason) }); }
  };
  const go = (action: CompanionAction) => {
    setOpen(false);
    const needsProject = action.kind === "settings" || action.kind === "environment" || action.kind === "explain";
    onNavigate(needsProject && !action.entityId && context?.projectId ? { ...action, entityId: context.projectId } : action);
  };
  const stale = buffer.askedFrom !== null && context !== null && buffer.askedFrom !== context.fingerprint;
  const projectId = hint.projectId ?? context?.sources.find((source) => source.kind === "project")?.id;

  return (
    <>
      {!settings.hidden && <Button ref={launcher} variant="default" className="nivra-companion-launcher" onClick={() => { setOpen(true); setRefresh((n) => n + 1); }} aria-expanded={open} aria-controls="nivra-companion" data-testid="companion-launcher">Nivra</Button>}
        <Paper ref={panel} id="nivra-companion" component="aside" tabIndex={-1} aria-label="Nivra companion" display={open ? undefined : "none"} className={`nivra-companion-panel${narrow ? " nivra-companion-narrow" : ""}`} withBorder p="md" data-testid="companion-panel">
          <Stack gap="md">
            <Group justify="space-between" align="flex-start" wrap="wrap">
              <Stack gap={2}><Title order={2} fz={18}>Nivra companion</Title><Text size="xs" c="var(--nivra-text-2)">Dialogue stays in memory until you end it or close the app.</Text></Stack>
              <Button size="xs" variant="default" onClick={dismiss} data-testid="companion-minimise">Minimise</Button>
            </Group>
            {!settings.invitationDismissed && <Alert color="gray" withCloseButton closeButtonLabel="Dismiss companion invitation" onClose={() => void saveSettings({ invitationDismissed: true })} data-testid="companion-invitation">Start an idea, set up a project, or ask about the work in view. Guidance by hand needs no key.</Alert>}
            <Group gap="xs">
              <Button size="xs" variant={mode === "idea" ? "filled" : "default"} onClick={() => setMode("idea")} data-testid="companion-start-idea">Start an idea</Button>
              <Button size="xs" variant={mode === "setup" ? "filled" : "default"} onClick={() => setMode("setup")} data-testid="companion-setup">Help set up this project</Button>
              <Button size="xs" variant={mode === "work" ? "filled" : "default"} onClick={() => setMode("work")} data-testid="companion-ask-work">Ask about this work</Button>
            </Group>
            {contextError && <Alert color="red" data-testid="companion-context-error">{contextError}</Alert>}
            {context && <Stack gap={4} data-testid="companion-context"><Text size="sm" fw={600}>Using: {context.label}</Text><Text size="xs" c="var(--nivra-text-2)">{context.sources.map((source) => `${source.label} · ${source.revision}`).join("; ") || "General guidance, with no repository"}</Text><Group gap="xs">{context.sources.filter((source) => source.kind === "task" || source.kind === "mission").map((source) => <Button key={`${source.kind}:${source.id}`} variant="subtle" size="xs" onClick={() => go({ id: `source:${source.id}`, kind: source.kind === "task" ? "open-task" : "open-mission", entityId: source.id, label: source.label })}>Open {source.label}</Button>)}</Group></Stack>}
            <Box display={mode === "idea" ? undefined : "none"}><IdeaGuide key={buffer.sessionId} onNavigate={go} /></Box>
            {mode === "setup" && <SetupGuide projectId={projectId ?? null} refreshKey={refresh + refreshKey} onNavigate={go} onAdd={onAdd} onExplain={(id) => { setOpen(false); onExplain(id); }} />}
            {context && <Stack gap="xs">{context.blockers.map((blocker) => <Alert key={blocker.id} color="yellow"><Text size="sm" fw={600}>{blocker.title}</Text><Text size="sm">{blocker.detail}</Text>{blocker.action && <Button mt="xs" size="xs" variant="default" onClick={() => blocker.action === "recheck" ? setRefresh((n) => n + 1) : go({ id: blocker.id, kind: blocker.action === "environment" ? "environment" : "settings", ...(projectId ? { entityId: projectId } : {}), label: blocker.action === "settings" ? "Open Settings" : "Open environment" })}>{blocker.action === "recheck" ? "Recheck" : blocker.action === "settings" ? "Open Settings" : "Open environment"}</Button>}</Alert>)}</Stack>}
            <Stack gap="xs" data-testid="companion-dialogue">
              {buffer.lines.map((line, index) => <Paper key={index} p="sm" withBorder><Text size="xs" fw={600}>{line.role === "user" ? "You" : "Nivra"}</Text><Text size="sm" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{line.text}</Text></Paper>)}
              {stale && <Alert color="yellow" data-testid="companion-stale">This work changed after the advice was requested. Check the current records before using it.</Alert>}
              {buffer.error && <Alert color="red" data-testid="companion-turn-error">{buffer.error}</Alert>}
              {buffer.retained.length > 0 && <Alert color="green" data-testid="companion-retained"><Text size="sm" fw={600}>Remembered for this scope</Text>{buffer.retained.map((note) => <Text key={note.id} size="sm">{note.statement}</Text>)}<Button size="xs" variant="default" onClick={() => { const details = panel.current?.querySelector<HTMLDetailsElement>('[data-testid="companion-knowledge"]'); if (details) { details.open = true; details.scrollIntoView({ block: "nearest" }); } }}>View, edit or forget saved knowledge</Button></Alert>}
              {buffer.proposals.map((text, index) => <Text key={index} size="sm" data-testid="companion-follow-up">{text}</Text>)}
              {buffer.actions.map((action) => <Button key={action.id} size="xs" variant="default" onClick={() => {
                if (action.kind === "draft-task" || action.kind === "draft-mission") {
                  if (buffer.requestId && buffer.askedFrom) setProposal({ action, sessionId: buffer.sessionId, requestId: buffer.requestId, fingerprint: action.fingerprint ?? buffer.askedFrom });
                } else go(action);
              }} disabled={stale}>{action.label}</Button>)}
              {proposal?.sessionId === buffer.sessionId && buffer.actions.some((action) => action.id === proposal.action.id) && <ProposalReview key={proposal.action.id} proposal={proposal} stale={stale} onSaved={go} onCancel={() => setProposal(null)} />}
              {buffer.answering ? <Group><Text size="sm" role="status">Nivra is answering…</Text><Button size="xs" variant="default" disabled={!buffer.requestId} onClick={() => void window.nivra.cancelCompanionTurn(buffer.sessionId, buffer.requestId!).catch((reason: unknown) => patch(key, buffer.sessionId, { error: errorMessage(reason) }))}>Cancel turn</Button></Group> : null}
              <Textarea label="Ask Nivra" description="Sends only when you press Ask. This message box is never recovered after restart." value={buffer.composer} maxLength={8_000} autosize minRows={2} onChange={(event) => patch(key, buffer.sessionId, { composer: event.currentTarget.value })} data-testid="companion-message" />
              {!context?.canAsk && context?.askBlocked && <Text size="sm" c="var(--nivra-text-2)" data-testid="companion-ask-blocked">{context.askBlocked} You can keep planning by hand.</Text>}
              {context?.sharingRequired && context.projectId && <Button variant="default" size="xs" onClick={() => setSharingConsent(true)} data-testid="companion-sharing-preview">Review sharing for this project</Button>}
              <Group><Button onClick={() => void send()} disabled={!context?.canAsk || !buffer.composer.trim() || buffer.answering} data-testid="companion-send">Ask Nivra</Button><Button variant="subtle" size="xs" onClick={() => void end()} data-testid="companion-end">End this dialogue</Button></Group>
            </Stack>
            {context && <KnowledgePanel key={key} context={context} sessionId={buffer.sessionId} onChanged={() => setRefresh((n) => n + 1)} />}
            {settings.hidden && <Button variant="default" size="xs" onClick={() => void saveSettings({ hidden: false })} data-testid="companion-show-launcher">Show launcher again</Button>}
            <Group><Button variant="subtle" size="xs" onClick={() => void saveSettings({ hidden: true }).then((saved) => { if (saved) dismiss(); })} data-testid="companion-hide">Hide launcher</Button><Text size="xs" c="var(--nivra-text-2)">Reopen from Settings or Ctrl+Shift+Space.</Text></Group>
            {settingsError && <Alert color="red">{settingsError}</Alert>}
          </Stack>
        </Paper>
      <ConsentModal opened={sharingConsent} onClose={() => setSharingConsent(false)} onAllow={() => {
        const id = context?.projectId;
        if (!id) return;
        void window.nivra.setSharing(id, true).then(() => { setSharingConsent(false); setRefresh((n) => n + 1); }, (reason: unknown) => patch(key, buffer.sessionId, { error: errorMessage(reason) }));
      }} intro={`To help with ${context?.label ?? "this project"}, Nivra sends Nebius Token Factory:`} sends={["your requested message and bounded recent companion dialogue;", "the current task or mission brief, relevant native state, and selected saved knowledge from this scope;", "your confirmed preferences that apply here."]} after={CONSENT_COVERS} testId="companion-consent" />
    </>
  );
}

function ProposalReview({ proposal, stale, onSaved, onCancel }: {
  proposal: { action: CompanionAction; sessionId: string; requestId: string; fingerprint: string };
  stale: boolean;
  onSaved(action: CompanionAction): void;
  onCancel(): void;
}) {
  const draft = proposal.action.draft;
  const mission = proposal.action.kind === "draft-mission";
  const [title, setTitle] = useState(draft?.title ?? "");
  const [goal, setGoal] = useState(mission ? draft?.outcome ?? "" : draft?.goal ?? "");
  const [scope, setScope] = useState(draft?.scope ?? "");
  const [acceptance, setAcceptance] = useState(draft?.acceptance?.join("\n") ?? "");
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const save = async () => {
    if (saving.current || stale || saved) return;
    saving.current = true; setBusy(true); setError(null);
    try {
      const result = await window.nivra.saveCompanionDraft({ sessionId: proposal.sessionId, requestId: proposal.requestId, actionId: proposal.action.id, fingerprint: proposal.fingerprint, draft: { title, ...(mission ? { outcome: goal } : { goal, scope, acceptance: separateLines(acceptance) }) } });
      setSaved(true);
      if (result.task) onSaved({ id: proposal.action.id, kind: "open-task", entityId: result.task.summary.id, label: "Open saved task" });
      else if (result.mission) onSaved({ id: proposal.action.id, kind: "open-mission", entityId: result.mission.id, label: "Open saved mission" });
    } catch (reason) { setError(errorMessage(reason)); }
    finally { saving.current = false; setBusy(false); }
  };
  return <Paper withBorder p="sm" data-testid="companion-proposal"><Stack gap="sm">
    <Text size="sm" fw={600}>Review proposed {mission ? "mission" : "task"}</Text>
    <Text size="xs" c="var(--nivra-text-2)">Edit the wording before saving. This creates a native draft; it does not run work.</Text>
    <TextInput label={mission ? "Mission name" : "Task title"} value={title} onChange={(event) => setTitle(event.currentTarget.value)} />
    <Textarea label="Intended outcome" value={goal} onChange={(event) => setGoal(event.currentTarget.value)} />
    {!mission && <><Textarea label="Scope" value={scope} onChange={(event) => setScope(event.currentTarget.value)} /><Textarea label="Acceptance wording (one per line)" value={acceptance} onChange={(event) => setAcceptance(event.currentTarget.value)} /></>}
    {stale && <Alert color="yellow">The source work changed. Ask again before saving this proposal.</Alert>}
    {saved && <Alert color="green">Saved to native work.</Alert>}
    {error && <Alert color="red">{error}</Alert>}
    <Group><Button size="xs" loading={busy} disabled={stale || saved || !title.trim() || (mission && !goal.trim())} onClick={() => void save()} data-testid="companion-proposal-save">Save reviewed {mission ? "mission" : "draft task"}</Button><Button variant="subtle" size="xs" onClick={onCancel}>Close proposal</Button></Group>
  </Stack></Paper>;
}

function IdeaGuide({ onNavigate }: { onNavigate(action: CompanionAction): void }) {
  const [name, setName] = useState("");
  const [outcome, setOutcome] = useState("");
  const [users, setUsers] = useState("");
  const [criteria, setCriteria] = useState("");
  const [constraints, setConstraints] = useState("");
  const [excluded, setExcluded] = useState("");
  const [mission, setMission] = useState<MissionView | null>(null);
  const [taskTitle, setTaskTitle] = useState("");
  const [taskGoal, setTaskGoal] = useState("");
  const [taskScope, setTaskScope] = useState("");
  const [taskAcceptance, setTaskAcceptance] = useState("");
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const missionAction = useRef(crypto.randomUUID());
  const taskAction = useRef(crypto.randomUUID());
  const [error, setError] = useState<string | null>(null);
  const act = async (body: () => Promise<void>) => {
    if (saving.current) return;
    saving.current = true; setBusy(true); setError(null);
    try { await body(); } catch (reason) { setError(errorMessage(reason)); }
    finally { saving.current = false; setBusy(false); }
  };
  return <Paper withBorder p="sm" data-testid="companion-idea"><Stack gap="sm">
    <Text size="sm" fw={600}>A saved brief for your idea</Text><Text size="sm">Save a mission first. A repository, Git and provider key can come later.</Text>
    {!mission ? <>
      <TextInput label="Short name" value={name} onChange={(event) => setName(event.currentTarget.value)} data-testid="companion-idea-name" />
      <Textarea label="What should this achieve?" value={outcome} onChange={(event) => setOutcome(event.currentTarget.value)} data-testid="companion-idea-outcome" />
      <details><summary>Audience, success and constraints (optional)</summary><Stack gap="xs" mt="xs"><Textarea label="Who is it for?" value={users} onChange={(event) => setUsers(event.currentTarget.value)} /><Textarea label="What does success look like? (one per line)" value={criteria} onChange={(event) => setCriteria(event.currentTarget.value)} /><Textarea label="Constraints (one per line)" value={constraints} onChange={(event) => setConstraints(event.currentTarget.value)} /><Textarea label="Leave out (one per line)" value={excluded} onChange={(event) => setExcluded(event.currentTarget.value)} /></Stack></details>
      <Button loading={busy} disabled={!name.trim() || !outcome.trim()} onClick={() => void act(async () => setMission(await window.nivra.createMission({ name: name.trim(), intendedUsers: users.trim(), outcome: outcome.trim(), successCriteria: separateLines(criteria), constraints: separateLines(constraints), nonGoals: separateLines(excluded) }, missionAction.current)))} data-testid="companion-idea-save">Save idea</Button>
    </> : <>
      <Alert color="green" data-testid="companion-idea-saved">Saved as mission “{mission.latest.content.name}”, v{mission.latest.version}. This saves the brief; no application or repository was created.</Alert>
      <Button variant="default" size="xs" onClick={() => onNavigate({ id: "open-saved-mission", kind: "open-mission", entityId: mission.id, label: "Open saved mission" })}>Open saved mission</Button>
      <Text size="sm" fw={600}>First manageable task (optional)</Text>
      <TextInput label="Task title" value={taskTitle} onChange={(event) => setTaskTitle(event.currentTarget.value)} data-testid="companion-first-title" />
      <Textarea label="Task outcome" value={taskGoal} onChange={(event) => setTaskGoal(event.currentTarget.value)} data-testid="companion-first-goal" />
      <Textarea label="What is in scope?" value={taskScope} onChange={(event) => setTaskScope(event.currentTarget.value)} />
      <Textarea label="How will you know it worked? (one per line)" value={taskAcceptance} onChange={(event) => setTaskAcceptance(event.currentTarget.value)} data-testid="companion-first-acceptance" />
      <Text size="xs" c="var(--nivra-text-2)">Saved as a draft. Executable checks and repository selection stay on the task page.</Text>
      <Button loading={busy} disabled={!taskTitle.trim()} onClick={() => void act(async () => {
        const made = await window.nivra.createMissionTask(mission.id, taskTitle.trim(), guidedBrief(taskGoal, taskScope, taskAcceptance), taskAction.current);
        setMission(made);
        const task = made.backlog.find((entry) => entry.task.title === taskTitle.trim() && !mission.backlog.some((old) => old.task.id === entry.task.id));
        if (task) onNavigate({ id: "open-first-task", kind: "open-task", entityId: task.task.id, label: "Open first task" });
        else setError("The task was saved in this mission. Open the mission to continue.");
      })} data-testid="companion-first-save">Save first draft task</Button>
    </>}
    {error && <Alert color="red" data-testid="companion-save-error">{error}{mission ? " Your mission remains saved; retry this task step." : " Your idea hasn't been confirmed saved yet."}</Alert>}
  </Stack></Paper>;
}

function SetupGuide({ projectId, refreshKey, onNavigate, onAdd, onExplain }: { projectId: string | null; refreshKey: number; onNavigate(action: CompanionAction): void; onAdd(): void; onExplain(projectId: string): void }) {
  const [inspection, setInspection] = useState<ProjectInspectionView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let active = true;
    setInspection(null); setError(null);
    if (projectId) window.nivra.inspectProject(projectId).then((value) => { if (active) setInspection(value); }, (reason: unknown) => { if (active) setError(errorMessage(reason)); });
    return () => { active = false; };
  }, [projectId, refresh, refreshKey]);
  return <Paper withBorder p="sm" data-testid="companion-project-setup"><Stack gap="sm"><Text size="sm" fw={600}>Project setup</Text><Text size="sm">Planning stays available while you set up execution.</Text>
    {!projectId ? <><Text size="sm">Choose an existing project or add its folder. Git and a committed baseline are needed when you execute work.</Text><Button variant="default" onClick={onAdd}>Add an existing project…</Button></> : <>
      {error && <Alert color="red">{error}</Alert>}
      {!inspection && !error && <Text size="sm" role="status">Checking this project's local Git and baseline facts…</Text>}
      {inspection && <><Text size="sm" fw={600}>Git: {{ available: "available", missing: "not installed", unsupported: "version unsupported", failed: "couldn't be checked" }[inspection.git.status]}</Text><Text size="sm">{inspection.git.message}</Text>{inspection.git.version && <Text size="xs">{inspection.git.version}</Text>}<Text size="sm" fw={600}>Repository baseline: {{ ready: "commit found", "not-repository": "not a Git repository", "no-commits": "no commits yet", unavailable: "couldn't be checked" }[inspection.repository.status]}</Text><Text size="sm">{inspection.repository.message}</Text>{inspection.repository.head && <Text size="xs">Commit {inspection.repository.head.slice(0, 12)}</Text>}<Text size="xs" c="var(--nivra-text-2)">Checked {inspection.checkedAt}. These preliminary checks do not establish that a snapshot can be sent. Tracked changes must be committed or set aside before execution; untracked files are left out.</Text></>}
      <Group gap="xs"><Button size="xs" variant="default" onClick={() => setRefresh((n) => n + 1)} data-testid="companion-recheck">Recheck</Button><Button size="xs" variant="default" onClick={() => onNavigate({ id: "setup-environment", kind: "environment", entityId: projectId, label: "Open environment" })}>Open environment</Button><Button size="xs" variant="default" onClick={() => onNavigate({ id: "setup-connections", kind: "settings", entityId: projectId, label: "Open Settings" })}>Open Settings</Button></Group>
      <Button size="xs" variant="default" onClick={() => onExplain(projectId)} data-testid="companion-explain">Explain this repository</Button>
      <Text size="xs" c="var(--nivra-text-2)">Explain opens its own preview and sharing controls. The companion's temporary dialogue is not sent to it.</Text>
      <Text size="xs" c="var(--nivra-text-2)">Environment preparation is optional when a task needs no dependencies. Open Environment to inspect the declared runtime, package manager and supported workspace choices. Preparation and uploads still need their own preview and approval. A Git GUI is optional.</Text>
    </>}
  </Stack></Paper>;
}

function KnowledgePanel({ context, sessionId, onChanged }: { context: CompanionContextView; sessionId: string; onChanged(): void }) {
  const [statement, setStatement] = useState("");
  const [editing, setEditing] = useState<KnowledgeView | null>(null);
  const [acknowledgement, setAcknowledgement] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  useEffect(() => { setStatement(""); setEditing(null); setAcknowledgement(null); setError(null); }, [context.scope.kind, JSON.stringify(context.scope)]);
  const act = async (body: () => Promise<void>) => {
    if (saving.current) return;
    saving.current = true; setBusy(true); setError(null);
    try { await body(); onChanged(); } catch (reason) { setError(errorMessage(reason)); }
    finally { saving.current = false; setBusy(false); }
  };
  return <details data-testid="companion-knowledge"><summary>Saved knowledge for this work ({context.knowledge.length})</summary><Stack gap="sm" mt="sm">
    <Text size="xs" c="var(--nivra-text-2)">Only selected statements are retained. Preferences belong in Settings and approved task wording belongs in its brief.</Text>
    {context.knowledge.map((note) => <Paper withBorder p="sm" key={note.id} data-testid="companion-knowledge-item"><Stack gap={4}><Text size="sm">{note.statement}</Text><Text size="xs" c="var(--nivra-text-2)">{note.origin} · {note.sourceLabel}</Text><Badge size="xs" variant="light">{note.status}</Badge><Group gap="xs"><Button size="xs" variant="subtle" onClick={() => { setEditing(note); setStatement(note.statement ?? ""); }}>Edit</Button><Button size="xs" variant="subtle" color="red" disabled={busy} onClick={() => void act(async () => { await window.nivra.forgetKnowledge(note.id, note.revision); setAcknowledgement("Forgotten. Future turns won't retrieve this statement."); if (editing?.id === note.id) { setEditing(null); setStatement(""); } })}>Forget</Button></Group></Stack></Paper>)}
    {context.scope.kind !== "general" && <><Textarea label={editing ? "Correct this statement" : "Remember an explicit decision for this scope"} value={statement} maxLength={500} onChange={(event) => setStatement(event.currentTarget.value)} data-testid="companion-knowledge-statement" /><Button size="xs" loading={busy} disabled={!statement.trim()} onClick={() => void act(async () => {
      if (editing) await window.nivra.editKnowledge(editing.id, editing.revision, statement.trim());
      else await window.nivra.captureKnowledge({ scope: context.scope, statement: statement.trim(), kind: "decision", sessionId });
      setAcknowledgement(editing ? "Saved the corrected statement for this scope." : "Remembered for this scope. View, edit or forget it here."); setEditing(null); setStatement("");
    })} data-testid="companion-knowledge-save">{editing ? "Save correction" : "Remember decision"}</Button>{editing && <Button size="xs" variant="subtle" onClick={() => { setEditing(null); setStatement(""); }}>Cancel edit</Button>}</>}
    {context.scope.kind === "general" && <Text size="sm">Save an idea as a mission or open a project/task to retain a decision in its scope.</Text>}
    {acknowledgement && <Alert color="green" data-testid="companion-knowledge-ack">{acknowledgement}</Alert>}{error && <Alert color="red">{error}</Alert>}
  </Stack></details>;
}

export { CompanionUsage } from "./companion-usage";
