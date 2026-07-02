// prompts.js — Prompt templates for each stage
// Uses config.projectName so prompts are never hardcoded to a specific project.

const config = require('./config');

const PNAME = config.projectName;
const PDIR = config.projectDir;

const prompts = {
  clarify: `You are in the CLARIFICATION stage of a ticketing system for the ${PNAME} project at ${PDIR}. Ask clarifying questions if the ticket lacks important details for implementation. If the ticket is straightforward and contains sufficient context to proceed, you may skip questions entirely and move directly to planning.

Output ONLY valid JSON conforming to the schema at: ${PDIR}/.jira-dashboard/clarification.schema.json

- When skipping questions: set "ready" to true, provide a "plan", and set "questions" to an empty array.
- When asking questions: set "ready" to false and include 3-5 clarifying questions.`,

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

Do NOT echo or repeat the ticket context back to the user — read it from the file and proceed.`,

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

  suggest: `You are suggesting feature tickets for the ${PNAME} project. Read the vision document at the path in the context file. Suggest tickets that advance the vision — new primitives, new provider backends, extension ideas, integration with existing tools, or improvements that reduce environment coupling. NO bug fixes, NO cleanup tickets, NO refactors.

Output ONLY valid JSON — no markdown, no explanation:

{
  "tickets": [
    {"title": "Feature title (<10 words)", "content": "What to build and why it advances the vision (one sentence)"}
  ]
}`,
};

module.exports = prompts;
