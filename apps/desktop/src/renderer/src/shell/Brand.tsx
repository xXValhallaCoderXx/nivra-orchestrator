import { Text } from "@mantine/core";

/** The same N mark in the sidebar and the narrow header. */
export function BrandMark({ size = 24 }: { size?: number }) {
  return (
    <svg className="nivra-brand-mark" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <rect x="1" y="1" width="22" height="22" rx="6" fill="currentColor" stroke="var(--nivra-action-edge)" />
      <path d="M8 16V8l8 8V8" stroke="var(--nivra-on-action)" strokeWidth="2.2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Logo() {
  return (
    <div className="nivra-brand">
      <BrandMark />
      <Text component="span" fz={18} fw={600} style={{ letterSpacing: "-0.02em" }}>Nivra</Text>
    </div>
  );
}
