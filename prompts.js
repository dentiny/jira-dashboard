// prompts.js — Prompt templates for each stage
// Uses config.projectName so prompts are never hardcoded to a specific project.

const config = require('./config');

const PNAME = config.projectName;
const PDIR = config.projectDir;

const prompts = {
  clarify: `You are in the CLARIFICATION stage of a ticketing system for the ${PNAME} project at ${PDIR}. Ask clarifying questions if the ticket lacks important details for implementation. If the ticket is straightforward and contains sufficient context to proceed, you may skip questions entirely and move directly to planning.

Write your structured output to the file specified in the context. The file must contain valid JSON conforming to: ${PDIR}/.jira-dashboard/clarification.schema.json

- When skipping questions: set "ready" to true, provide a "plan", and set "questions" to an empty array.
- When asking questions: set "ready" to false and include up to 5 clarifying questions. Keep questions focused on the most critical unknowns — the ticketing system will call you again for another round after the user answers, so you can build on prior answers iteratively rather than covering everything at once.
- Use the Write tool to write the JSON to the output file.
- Do NOT output the JSON in your response — only write it to the file.`,

  evaluate: `You are in the ANSWER EVALUATION stage. The user has answered the clarification questions in the context file. Decide whether to proceed to implementation or ask follow-up questions.

Output ONLY valid JSON — no markdown, no explanation, no code fences:

If you NEED more info:
{
  "need_more": true,
  "questions": [
    { "question": "Follow-up?", "type": "free_text" },
    { "question": "Which approach?", "type": "multiple_choice", "options": ["A", "B"] }
  ],
  "notes": "Why more info is needed"
}

If you have ENOUGH info:
{
  "need_more": false,
  "plan": "High-level plan (1-3 sentences)",
  "files_to_modify": ["file1.py", "file2.py"],
  "estimated_complexity": "low|medium|high",
  "notes": "Any assumptions"
}`,

  implement: `You are implementing changes for a ${PNAME} ticket. Work in the directory referenced below.

Your job:
1. Read the context file for ticket details (title, content, plan, Q&A, any prior review feedback and test failure tail)
2. Read the relevant source files to understand the current code
3. Implement the changes described in the plan
4. Write clean, well-tested, maintainable code
5. Make sure existing tests still pass
6. Update relevant documentation
7. Commit ALL changes with clear messages as you go — you MUST commit before declaring implementation complete. Do NOT declare the task done until git add + git commit has been run.

Do NOT echo or repeat the ticket context back to the user — read it from the file and proceed.
Do NOT push to any remote. Only commit locally.`,

  resolveConflictAuto: `You are auto-resolving git rebase conflicts for a ticket in the ${PNAME} project.

Your job:
1. Read the context file for conflict details (conflicted files, git status, diffs, etc.)
2. Read the conflicted files in the worktree
3. Resolve the merge conflicts by editing the files
4. Run \`git add\` on the resolved files to mark them as resolved
5. Run \`git rebase --continue\` to complete the rebase

Output ONLY valid JSON conforming to the schema at: ${PDIR}/.jira-dashboard/resolve-conflict.schema.json`,

  resolveConflict: `You are in the CONFLICT RESOLUTION stage of a ticketing system for the ${PNAME} project at ${PDIR}.

A rebase conflict occurred that could not be auto-resolved. The ticket has a worktree with a branch that needs to be rebased onto the default branch, but there are merge conflicts.

Read the context file for conflict details (conflicted files, git status, diffs, etc.). Ask 3-5 clarifying questions so the user can specify how to resolve each conflict. After the user answers, the next implementation stage will apply the resolution.

Output ONLY valid JSON — no markdown, no explanation, no code fences:

{
  "questions": [
    { "question": "Which side should we keep for file X? Which specific changes from ours vs theirs?", "type": "multiple_choice", "options": ["Keep theirs (upstream)", "Keep ours (feature branch)", "Manual merge (custom)"] },
    { "question": "Any additional instructions?", "type": "free_text" }
  ],
  "notes": "Optional: why these questions matter"
}`,

  clarifyPR: `A PR for this ticket has issues that need attention. Do NOT re-ask the original implementation questions.

CRITICAL: Only address the actionable failures listed below (FAILURE/ERROR checks that require code changes). Explicitly IGNORE any checks marked as "ignore" — they are pending, non-actionable, or require human intervention (approvals, release notes, etc.) and are outside your scope.

CRITICAL: You MAY use \`gh\` CLI to READ PR comments and check status. You MUST NOT modify any PR metadata (descriptions, labels, reviewers, titles, comments) via \`gh\` or any other tool. Only edit code and commit locally.

CRITICAL: Work on the branch specified in the context. If a worktree path is provided, use that worktree. Otherwise, use \`gh\` to check out the branch. Do NOT re-implement from scratch or create a new branch.

Focus only on resolving the PR issues listed below. If you can fix them directly via code changes, provide a plan and proceed to implementation. If you need clarification about the issues themselves, ask about those specifically.

Write your structured output to the file specified in the context. The file must contain valid JSON conforming to: ${PDIR}/.jira-dashboard/clarification.schema.json

- Use the same schema as a new ticket: "ready" (boolean), "plan" (string, required when ready), "questions" (array of {question, type, options}), "estimated_complexity", "files_to_modify", "notes".
- Use the Write tool to write the JSON to the output file.
- Do NOT output the JSON in your response — only write it to the file.`,
  prTasks: `You are addressing GitHub PR tasks for a ${PNAME} ticket.

CRITICAL: Do NOT make any code changes. Do NOT edit any files. You may use tools (including the \`gh\` CLI) to investigate checks, but you must not modify any code.

Read the PR checks input JSON file specified in the context. It contains:
- \`checks\`: an array of checks to investigate and resolve. Address ONLY these checks.
- \`ignored_checks\`: an array of check names you must NEVER investigate, query, or act upon. Skip these completely even if you encounter them via \`gh\` or other tools.

For each check in \`checks\`, investigate the root cause and drive it to a success state, including pending checks. Do not skip a check without first determining why it is still failing or pending and attempting to resolve it.

REWORK means changing code. If you determine that any check requires actual code changes to resolve, include it in the rework_checks array with the reason why code changes are needed. Do NOT attempt code changes yourself — they will be handled in a separate code rework flow.

Read the output schema to understand the expected JSON structure. Use the Write tool to write the JSON to the output file path specified in the context.

Do NOT output the JSON in your response — only write it to the file.`,

  suggest: `First, understand what this project actually is and does. Explore the codebase: read the README, look at the top-level directory structure, and skim the main modules and any docs/ to grasp the project's purpose, domain, and current capabilities. Then read the context file referenced below — if it contains a project vision, treat that as the primary guide for where the project is headed; if the vision section is empty, infer the project's direction from the codebase itself.

Suggest concrete feature tickets that advance THIS project — new capabilities, meaningful extensions of existing features, or integrations that fit the project's actual domain and tech stack. Ground every suggestion in something you observed in the codebase or vision. Do NOT suggest generic features that could apply to any project. NO bug fixes, NO cleanup tickets, NO refactors.

Output ONLY valid JSON — no markdown, no explanation:

{
  "tickets": [
    {"title": "Feature title (<10 words)", "content": "What to build and why it advances the vision (one sentence)"}
  ]
}`,
};

module.exports = prompts;
