import { Alert, Radio, Stack, Text, useMantineColorScheme } from "@mantine/core";
import { useSyncExternalStore } from "react";
import { createColorSchemeManager, type ColorScheme } from "./color-scheme";
import { browserStorage } from "./drafts";

/** The one manager the window's MantineProvider uses (main.tsx); Appearance reads whether its last save failed. */
export const colorSchemeManager = createColorSchemeManager(browserStorage);

const CHOICES: ReadonlyArray<{ value: ColorScheme; label: string; note?: string }> = [
  { value: "auto", label: "System", note: "(the default)" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

/**
 * Settings › Preferences › Appearance (R29): System, Light or Dark, System by default. The choice applies at once; when
 * this computer couldn't keep it, Appearance says it lasts only until Nivra closes.
 */
export function Appearance() {
  const { colorScheme, setColorScheme } = useMantineColorScheme();
  const failed = useSyncExternalStore(colorSchemeManager.onSaveFailedChange, colorSchemeManager.saveFailed);
  return (
    <Stack gap="sm">
      <Radio.Group label="Appearance" value={colorScheme} onChange={(value) => setColorScheme(value as ColorScheme)} data-testid="appearance">
        <Stack gap={8} mt={8}>
          {CHOICES.map((choice) => (
            <Radio
              key={choice.value}
              value={choice.value}
              label={
                <>
                  {choice.label}
                  {choice.note && (
                    <Text component="span" size="sm" c="var(--nivra-text-3)">
                      {" "}
                      {choice.note}
                    </Text>
                  )}
                </>
              }
              data-testid={`appearance-${choice.value}`}
            />
          ))}
        </Stack>
      </Radio.Group>
      <Text size="xs" c="var(--nivra-text-3)">
        System follows your computer's light or dark setting.
      </Text>
      {failed && (
        <Alert color="yellow" variant="light" data-testid="appearance-not-kept">
          <Text size="sm">Nivra couldn't keep this choice on this computer. It applies until Nivra closes.</Text>
        </Alert>
      )}
    </Stack>
  );
}
