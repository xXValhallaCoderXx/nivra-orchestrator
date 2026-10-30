import type { TaskView } from "../../../shared/ipc";
import { Alert, Anchor, Badge, Button, Checkbox, Group, Modal, Paper, Stack, Text, Textarea, Title } from "@mantine/core";
import { useEffect, useRef, useState } from "react";
import type { AttachmentPreview, FrozenReferenceContext, ReferenceReceipt, ReferenceSelection, TaskDiscussion } from "@nivra/domain";
import { errorMessage, usePoll } from "../shared/ui";
import { BriefRead } from "./brief-read";

/** The same actual prepared content shown by each consumer before it asks AI. */
export function ReferenceContextView({ value }: { value: FrozenReferenceContext | null | undefined }) {
  if (!value) return null;
  return <details data-testid="included-task-context"><summary>Included discussion and reference files · {value.comments.length} comments · {value.attachments.length} files</summary><Stack gap="sm" mt="sm">
    <Text size="xs">Supporting context for this request. The approved brief remains authoritative. Images use nvidia/Nemotron-3.5-Super-VL; image secrets aren’t detected.</Text>
    {value.comments.map((comment) => <Paper withBorder p="xs" key={comment.id}><Text size="xs">{comment.author} · {new Date(comment.createdAt).toLocaleString()}</Text><Text size="sm" style={{ whiteSpace: "pre-wrap" }}>{comment.text}</Text></Paper>)}
    {value.attachments.map((item) => <Paper withBorder p="xs" key={item.id}><Text fw={500} size="sm">{item.name}</Text>{item.kind === "pdf" && <Text size="xs">PDF text only — images and layout aren’t included</Text>}{item.image && <img src={`data:image/png;base64,${item.image.base64}`} alt={`Prepared reference: ${item.name}`} style={{ maxWidth: "100%", maxHeight: 360, objectFit: "contain" }} />}{item.text !== null && <Text size="sm" style={{ whiteSpace: "pre-wrap", maxHeight: 260, overflow: "auto" }}>{item.text}</Text>}</Paper>)}
    {value.summaries.map((summary) => { const facts = JSON.parse(summary.payload) as { status: string; workerSummary?: string | null; outcome: string | null; verified: boolean | null; decision: string | null; apply: { status: string | null; resolution: string | null } | null; acceptedAt: string | null }; return <Paper withBorder p="xs" key={summary.id}><Text size="xs">Attempt {summary.id.slice(0, 8)} · {facts.status} · {facts.outcome ?? "outcome not recorded"} · verification {facts.verified === null ? "unknown" : facts.verified ? "passed" : "failed"} · {facts.decision ?? "no proposal decision"}{facts.apply ? ` · apply ${facts.apply.status ?? "unknown"}${facts.apply.resolution ? ` (${facts.apply.resolution})` : ""}` : ""}{facts.acceptedAt ? " · accepted by you" : ""}</Text><Text size="sm" style={{ whiteSpace: "pre-wrap" }}>{facts.workerSummary ?? "Written hand-in summary not retained."}</Text></Paper>; })}
  </Stack></details>;
}
export function TaskReferencePreview({ taskId }: { taskId: string | null | undefined }) {
  const poll = usePoll(() => window.nivra.previewTaskReferences(taskId!), () => 2000, [taskId], Boolean(taskId));
  return <>{poll.error && <Alert color="red">{poll.error}</Alert>}<ReferenceContextView value={poll.value} /></>;
}
export function ReferenceReceiptView({ value }: { value: ReferenceReceipt | null | undefined }) {
  if (!value) return null;
  return <details data-testid="task-attempt-reference-context"><summary>Discussion and files included in this attempt</summary><Stack gap="xs" mt="sm">
    {value.comments.map((comment) => <Paper withBorder p="xs" key={comment.id}><Text size="xs">{comment.author} · {new Date(comment.createdAt).toLocaleString()}</Text><Text size="sm" style={{ whiteSpace: "pre-wrap" }}>{comment.text}</Text></Paper>)}
    {value.attachments.map((attachment) => <Text size="sm" key={attachment.id}>{attachment.name}{attachment.removed ? " · attachment removed" : " · reference retained"}</Text>)}
    <Text size="xs">These references identify the frozen request. Later selection or removal does not change what that attempt received.</Text>
  </Stack></details>;
}
function prepareImage(original: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("../workers/prepare-image.ts", import.meta.url), { type: "module" });
    const timer = setTimeout(() => { worker.terminate(); reject(new Error("Image preparation took too long. Export a smaller image and try again.")); }, 15_000);
    const end = () => { clearTimeout(timer); worker.terminate(); };
    worker.onmessage = (event: MessageEvent<{ base64?: string; error?: string }>) => { end(); event.data.base64 ? resolve(event.data.base64) : reject(new Error(event.data.error ?? "Image preparation failed. Attach a smaller image.")); };
    worker.onerror = () => { end(); reject(new Error("Image preparation couldn't start. Reopen Nivra, then attach the image again.")); };
    worker.postMessage(original);
  });
}
export function TaskDiscussionPanel({ taskId, projectId, onAttempt }: { taskId: string; projectId: string | null; onAttempt(id: string): void }) {
  const actionRevision = useRef(0);
  const pending = useRef(false);
  const poll = usePoll(async () => { const revision = actionRevision.current; return { revision, discussion: await window.nivra.getTaskDiscussion(taskId) }; }, () => 2000, [taskId, projectId]);
  const [view, setView] = useState<TaskDiscussion | null>(null);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [historical, setHistorical] = useState<TaskView["brief"] | null>(null);
  const [preview, setPreview] = useState<AttachmentPreview | null>(null);
  const [included, setIncluded] = useState<FrozenReferenceContext | null>(null);
  useEffect(() => { setPreview(null); setIncluded(null); setView(null); }, [taskId, projectId]);
  useEffect(() => { if (poll.value && poll.value.revision === actionRevision.current && !pending.current) setView(poll.value.discussion); }, [poll.value]);
  useEffect(() => {
    if (!included || !poll.value) return;
    let current = true;
    void window.nivra.previewTaskReferences(taskId).then((value) => { if (current && value.digest !== included.digest) { setIncluded(null); setError("The included context changed. Review it again before asking AI."); } }, (reason) => { if (current) { setIncluded(null); setError(errorMessage(reason)); } });
    return () => { current = false; };
  }, [taskId, poll.value, included?.digest]);
  async function act(work: () => Promise<unknown>) {
    actionRevision.current++; pending.current = true; setBusy(true); setError(null); setIncluded(null);
    try { await work(); } catch (error) { setError(errorMessage(error)); }
    finally {
      try { setView(await window.nivra.getTaskDiscussion(taskId)); } catch (error) { setError(errorMessage(error)); }
      pending.current = false; setBusy(false);
    }
  }
  function selectContext(selection: ReferenceSelection) {
    if (view) setView({ ...view, selection });
    void act(() => window.nivra.selectTaskReferences(taskId, selection));
  }
  async function open(id: string) {
    let value = await window.nivra.getTaskAttachmentPreview(taskId, id);
    if (value.original) { const prepared = await prepareImage(value.original); await window.nivra.prepareTaskImage(taskId, id, prepared, value.attachment.sha256); value = await window.nivra.getTaskAttachmentPreview(taskId, id); }
    setPreview(value);
  }
  const selected = view?.selection;
  return <Paper withBorder p="md" data-testid="task-discussion"><Stack gap="sm"><Title order={3}>Comments and activity</Title>
    {(error ?? poll.error) && <Alert color="red">{error ?? poll.error}</Alert>}
    {view?.notice && <Alert>{view.notice}</Alert>}
    <Text size="sm">Comments are included in future task requests unless excluded. Select reference files explicitly. Adding and previewing files makes no paid calls.</Text>
    <Textarea label="Add a comment" value={comment} onChange={(event) => setComment(event.currentTarget.value)} maxLength={8000} autosize minRows={2} />
    <Group><Button disabled={busy || !comment.trim()} onClick={() => void act(async () => { await window.nivra.addTaskComment(taskId, comment); setComment(""); })}>Add comment</Button><Button variant="default" disabled={busy} onClick={() => void act(async () => { const result = await window.nivra.pickTaskAttachment(taskId); if (!result) return; const pending = result.attachments.filter((item) => item.state === "preparing"); for (const item of pending) await open(item.id); })}>Attach reference file</Button></Group>
    {view?.comments.map((item) => <Paper key={item.id} withBorder p="sm"><Stack gap="xs"><Group justify="space-between"><Text size="xs">You · {new Date(item.createdAt).toLocaleString()}</Text><Checkbox label="Include comment" disabled={busy} checked={!selected?.excludedCommentIds.includes(item.id)} onChange={(event) => { const include = event.currentTarget.checked; if (selected) selectContext({ ...selected, excludedCommentIds: include ? selected.excludedCommentIds.filter((id) => id !== item.id) : [...selected.excludedCommentIds, item.id] }); }} /></Group><Text size="sm" style={{ whiteSpace: "pre-wrap" }}>{item.text}</Text><Button size="compact-xs" variant="subtle" disabled={busy} onClick={() => void act(async () => { const result = await window.nivra.pickTaskAttachment(taskId, item.id); if (result) for (const file of result.attachments.filter((file) => file.state === "preparing")) await open(file.id); })}>Attach to comment</Button></Stack></Paper>)}
    {view?.attachments.map((item) => <Paper data-testid="task-attachment" data-attachment-id={item.id} key={item.id} withBorder p="sm"><Stack gap="xs"><Group justify="space-between"><Text size="sm">{item.name}</Text><Badge>{item.state}</Badge></Group><Text size="xs">{item.mediaType} · {item.bytes.toLocaleString()} bytes · SHA-256 {item.sha256.slice(0, 12)}{item.commentId ? " · linked to comment" : ""}</Text>{item.detail && <Text size="xs">{item.detail}</Text>}{item.state === "removed" && item.cleanupPending !== false && <Button size="compact-xs" variant="default" disabled={busy} onClick={() => void act(() => window.nivra.removeTaskAttachment(taskId, item.id))}>Retry file cleanup</Button>}{item.state !== "removed" && <Group><Checkbox label={`Include ${item.name}`} disabled={busy || (item.state !== "ready" && !selected?.attachmentIds.includes(item.id))} checked={selected?.attachmentIds.includes(item.id) ?? false} onChange={(event) => { const include = event.currentTarget.checked; if (selected) selectContext({ ...selected, attachmentIds: include ? [...selected.attachmentIds, item.id] : selected.attachmentIds.filter((id) => id !== item.id) }); }} /><Button size="compact-xs" variant="default" disabled={busy} onClick={() => void act(() => open(item.id))}>{item.state === "preparing" ? "Prepare image" : "Preview"}</Button><Button size="compact-xs" variant="subtle" color="red" disabled={busy} onClick={() => void act(async () => { setPreview(null); await window.nivra.removeTaskAttachment(taskId, item.id); })}>Remove</Button></Group>}</Stack></Paper>)}
    <Button variant="default" disabled={busy} onClick={() => void act(async () => { setIncluded(await window.nivra.previewTaskReferences(taskId)); })}>Review included context</Button>
    <ReferenceContextView value={included} />
    <Text size="xs">{view?.historyNote}</Text>
    {view?.activity.map((item) => <Group key={item.id} gap="xs"><Text size="xs">{new Date(item.at).toLocaleString()}</Text>{item.kind === "attempt" || item.kind === "decision" || item.kind === "apply" || item.kind === "acceptance" || item.kind === "check" || item.kind === "proposal" ? <Anchor component="button" size="sm" onClick={() => onAttempt(item.recordId)}>{item.label}</Anchor> : item.kind === "brief" ? <Anchor component="button" size="sm" onClick={() => void act(async () => setHistorical(await window.nivra.getTaskBrief(taskId, item.recordId)))}>{item.label}</Anchor> : <Text size="sm">{item.label}</Text>}</Group>)}
    <Modal opened={historical !== null} onClose={() => setHistorical(null)} title={`Brief version ${historical?.version ?? ""}`} closeButtonProps={{ "aria-label": "Close" }} size="lg">{historical && <BriefRead content={historical.content} historical />}</Modal>
    <Modal opened={preview !== null} onClose={() => setPreview(null)} title={preview?.attachment.name} closeButtonProps={{ "aria-label": "Close" }} size="lg">{preview?.image && <img src={preview.image} alt="Prepared image supplied to AI when selected" style={{ maxWidth: "100%" }} />}{preview?.attachment.kind === "pdf" && <Text size="sm">PDF text only — images and layout aren’t included</Text>}{preview?.text !== null && <Text style={{ whiteSpace: "pre-wrap" }}>{preview?.text}</Text>}</Modal>
  </Stack></Paper>;
}
