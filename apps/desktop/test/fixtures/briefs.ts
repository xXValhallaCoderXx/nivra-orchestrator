import { briefFrom } from "../../src/main/tasks.ts";
import type { BriefContent, BriefFields } from "../../src/shared/ipc.ts";

/**
 * Briefs the task coach's tests share (NIV-53): a vague one, an empty one, a clear small one with and without an
 * acceptance case, a fix that says what happens now, a large one, and one whose repository changed.
 */
const EMPTY_FIELDS: BriefFields = { goal: "", acceptanceCriteria: [], scope: "", exclusions: "", context: "", assumptions: [], checks: [], acceptanceCases: [] };
const brief = (fields: Partial<BriefFields>, extra: Partial<BriefContent> = {}): BriefContent => ({ ...briefFrom({ ...EMPTY_FIELDS, ...fields }), ...extra });

export const CASE = { name: "Exports two rows", command: "sh export.sh", expectedOutput: "id,title\n1,Ada\n2,Grace\n", expectedExitCode: 0 };

export const BRIEFS = {
  empty: brief({}),
  vague: brief({ goal: "Fix the PR detection bug", acceptanceCriteria: ["It works"] }),
  clearSmall: brief({ goal: "Add a CSV export to the task list", acceptanceCriteria: ["Exporting a list of 2 tasks downloads a file with a header row and 2 rows"] }),
  clearWithCase: brief({ goal: "Add a CSV export to the task list", acceptanceCriteria: ["Exporting a list of 2 tasks downloads a file with a header row and 2 rows"], acceptanceCases: [CASE] }),
  fixDescribed: brief({
    goal: "Fix finish-time records that compare miles with kilometres",
    context: "Currently a 5 km run logged in miles is compared as if it were in kilometres, so its record is wrong. Instead, times should be compared in one unit.",
    acceptanceCriteria: ["Given a 5 km run logged in miles, its finish time is compared with other 5 km runs in kilometres", "A run with no unit recorded is left out of the comparison"],
    acceptanceCases: [CASE],
  }),
  large: brief({
    goal: "Rework the training dashboard",
    acceptanceCriteria: [
      "Loads fast",
      "Shows the weekly distance",
      "Shows the weekly time",
      "Shows the longest run",
      "Shows the average pace",
      "Shows the next planned session",
      "Shows the streak",
      "Shows the personal records",
      "Shows the shoes in use",
    ],
  }),
  moved: brief({ goal: "Add a CSV export to the task list", acceptanceCriteria: ["Exporting a list of 2 tasks downloads a file with a header row and 2 rows"] }, { revalidate: ["context", "assumptions"] }),
} satisfies Record<string, BriefContent>;
