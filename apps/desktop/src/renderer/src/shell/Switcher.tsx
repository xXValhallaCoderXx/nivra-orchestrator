import { Box, Combobox, Group, Text, useCombobox } from "@mantine/core";
import { useEffect, useImperativeHandle, useRef, type Ref } from "react";
import type { ProjectView } from "../../../shared/ipc";
import type { Scope } from "../app/routes";
import { sharedNames } from "./places";

const ADD = "\u0000add";
const GENERAL = "\u0000general";

export interface SwitcherHandle {
  /** Opens the list with the project in view highlighted, as Ctrl+K does. */
  open(): void;
}

const CHEVRON = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--nivra-text-2)" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m6 9 6 6 6-6" />
  </svg>
);
const TICK = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </svg>
);
const PLUS = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 5v14M5 12h14" />
  </svg>
);

/**
 * The project switcher (SH2, PN5): what is in view, General or one project with its place, and a list to change it.
 * Same-named projects show their folder, and a project on Windows itself says tasks can't run there yet. "Add project…"
 * runs the add flow. The field is a select-only combobox: its value is the name in view (the specs and live scripts read
 * it as `project-select`), and the place under it is `project-target`. Arrow keys, Home and End move; typing a name's
 * first letters moves to it; Enter switches; Esc closes the list and leaves focus on the switcher.
 */
export function Switcher({
  scope,
  projects,
  windowsHost,
  compact = false,
  adding,
  onSwitch,
  onAdd,
  handle,
}: {
  scope: Scope;
  projects: ProjectView[];
  /** The window runs on Windows itself, where tasks can't run yet. */
  windowsHost: boolean;
  /** One line, for the narrow top bar. */
  compact?: boolean;
  adding: boolean;
  onSwitch(scope: Scope): void;
  onAdd(): void;
  handle?: Ref<SwitcherHandle>;
}) {
  const field = useRef<HTMLInputElement>(null);
  const combobox = useCombobox();
  const project = scope.kind === "project" ? (projects.find((p) => p.id === scope.projectId) ?? null) : null;
  const name = project?.label ?? "General";
  const place = project?.targetLabel ?? "No repository";
  const shared = sharedNames(projects);
  const values = [GENERAL, ...projects.map((p) => p.id), ADD];
  const names = ["General", ...projects.map((p) => p.label), "Add project…"];
  const typed = useRef({ text: "", at: 0 });

  useImperativeHandle(handle, () => ({
    open() {
      field.current?.focus();
      combobox.openDropdown("keyboard");
    },
  }));

  // On opening, the project in view is the highlighted option.
  useEffect(() => {
    if (combobox.dropdownOpened) combobox.updateSelectedOptionIndex("active", { scrollIntoView: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [combobox.dropdownOpened]);

  const submit = (value: string) => {
    combobox.closeDropdown();
    field.current?.focus();
    if (value === ADD) onAdd();
    else if (value === GENERAL) onSwitch({ kind: "general" });
    else onSwitch({ kind: "project", projectId: value });
  };

  // Typing the first letters of a name moves to it.
  const typeahead = (key: string) => {
    const now = performance.now();
    typed.current = { text: now - typed.current.at < 700 ? typed.current.text + key.toLowerCase() : key.toLowerCase(), at: now };
    const index = names.findIndex((label) => label.toLowerCase().startsWith(typed.current.text));
    if (index >= 0) combobox.selectOption(index);
  };

  const describe = (p: ProjectView) => `${p.targetLabel}${shared.has(p.id) ? ` · ${p.displayPath}` : ""}`;

  return (
    <Combobox store={combobox} onOptionSubmit={submit} position="bottom-start" offset={4} width={compact ? "target" : 300} shadow="md">
      <Combobox.DropdownTarget>
        <Box
          onClick={() => {
            field.current?.focus();
            combobox.toggleDropdown();
          }}
          className="nivra-switcher"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            width: "100%",
            boxSizing: "border-box",
            padding: compact ? "6px 10px" : "8px 10px",
            background: "var(--nivra-surface)",
            border: `1px solid ${combobox.dropdownOpened ? "var(--nivra-focus)" : "var(--nivra-control-border)"}`,
            borderRadius: 8,
            cursor: "pointer",
            minWidth: 0,
          }}
          data-testid="switcher"
        >
          <Box style={{ display: "flex", flexDirection: compact ? "row" : "column", alignItems: compact ? "baseline" : "stretch", gap: compact ? 8 : 0, minWidth: 0, flex: "1 1 auto" }}>
            <Combobox.EventsTarget targetType="button" withExpandedAttribute>
              <input
                ref={field}
                readOnly
                value={name}
                title={name}
                aria-label={`Switch project. Now showing: ${name}, ${place}`}
                onKeyDown={(event) => {
                  if (event.key === "Home" || event.key === "End") {
                    if (!combobox.dropdownOpened) return;
                    event.preventDefault();
                    combobox.selectOption(event.key === "Home" ? 0 : values.length - 1);
                  } else if (event.key.length === 1 && event.key !== " " && !event.ctrlKey && !event.metaKey && !event.altKey) {
                    if (!combobox.dropdownOpened) combobox.openDropdown("keyboard");
                    typeahead(event.key);
                  }
                }}
                style={{
                  all: "unset",
                  display: "block",
                  minWidth: 0,
                  width: compact ? `${Math.min(name.length, 40) + 1}ch` : "100%",
                  flex: compact ? "0 1 auto" : undefined,
                  fontSize: 13,
                  fontWeight: 600,
                  lineHeight: "18px",
                  color: "var(--mantine-color-text)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  cursor: "pointer",
                }}
                data-testid="project-select"
              />
            </Combobox.EventsTarget>
            <Text component="span" size="xs" c="var(--nivra-text-2)" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} data-testid="project-target">
              {place}
            </Text>
          </Box>
          {CHEVRON}
        </Box>
      </Combobox.DropdownTarget>
      <Combobox.Dropdown data-testid="project-switcher-list">
        <Combobox.Options aria-label="Switch project" mah="min(420px, 70vh)" style={{ overflowY: "auto" }}>
          <SwitcherOption value={GENERAL} chosen={scope.kind === "general"} name="General" lines={["Conversations and tasks with no repository"]} testId="switcher-general" projectId={null} />
          {projects.length > 0 && (
            <Combobox.Group label="Projects">
              {projects.map((p) => (
                <SwitcherOption
                  key={p.id}
                  value={p.id}
                  chosen={scope.kind === "project" && scope.projectId === p.id}
                  name={p.label}
                  lines={[describe(p), ...(windowsHost && p.targetId === "local" ? ["Tasks can't run on Windows yet"] : [])]}
                  testId="switcher-project"
                  projectId={p.id}
                />
              ))}
            </Combobox.Group>
          )}
          <Combobox.Option
            value={ADD}
            disabled={adding}
            style={{ borderTop: "1px solid var(--nivra-border)", marginTop: 4, paddingTop: 10 }}
            data-testid="project-add"
          >
            <Group gap={8} wrap="nowrap">
              {PLUS}
              <Text size="sm" fw={500}>
                {adding ? "Adding a project…" : "Add project…"}
              </Text>
            </Group>
          </Combobox.Option>
        </Combobox.Options>
      </Combobox.Dropdown>
    </Combobox>
  );
}

function SwitcherOption({ value, chosen, name, lines, testId, projectId }: { value: string; chosen: boolean; name: string; lines: string[]; testId: string; projectId: string | null }) {
  return (
    <Combobox.Option value={value} active={chosen} aria-selected={chosen} data-testid={testId} data-project-id={projectId ?? undefined}>
      <Group gap={8} wrap="nowrap" justify="space-between" align="flex-start">
        {/* Names wrap rather than being cut off, so the full name always shows, with its place and folder. */}
        <Box style={{ minWidth: 0 }}>
          <Text size="sm" fw={500} style={{ overflowWrap: "anywhere" }}>
            {name}
          </Text>
          {lines.map((line) => (
            <Text key={line} size="xs" c="var(--nivra-text-2)" style={{ overflowWrap: "anywhere" }}>
              {line}
            </Text>
          ))}
        </Box>
        {chosen && TICK}
      </Group>
    </Combobox.Option>
  );
}
