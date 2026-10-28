/**
 * The repository New task starts with (NIV-56): a plan's own project when the task comes from a plan, or none when that
 * plan's project is general or no longer listed; otherwise the project whose page opened the form, when it's listed.
 * The person can choose another, or none, either way.
 */
export function initialRepositoryOf(plan: { projectId: string | null } | null, listed: readonly string[], initialProjectId: string | null): string | null {
  const known = (id: string | null) => (id !== null && listed.includes(id) ? id : null);
  return plan ? known(plan.projectId) : known(initialProjectId);
}
