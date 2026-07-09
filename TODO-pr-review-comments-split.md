# PR Review Comments Split — Implementation TODO

## Summary
Split the current single `"PR Review Comments"` virtual check into two separate checks:
- **PR Comments** — general issue-level comments (`pr.comments`)
- **PR Review OPEN Comments** — unresolved inline review threads (`reviewThreads` where `isResolved == false`)

The coder assesses each open review comment per-item: either flags it for rework or closes the thread (with optional reply).

---

## Files to Modify

### 1. `pr-checker.js`

- [ ] **Parse PR URL for host/owner/repo** — extract `ghHost`, `ghOwner`, `ghRepo` from `t.pr_url` to use with `gh api graphql`
- [ ] **Add GraphQL call for review threads** — run `gh api graphql --hostname <host>` to fetch unresolved review threads alongside the existing `gh pr view` call
- [ ] **Create `"PR Comments"` virtual check** — from `pr.comments` (non-minimized), e.g. `"3 comment(s)"`
- [ ] **Create `"PR Review OPEN Comments"` virtual check** — from unresolved threads (`isResolved == false`), counting total comments across them, e.g. `"2 open review comment(s)"`
- [ ] **Remove old `"PR Review Comments"` virtual check** (line 77-79)
- [ ] **Update staleness signature** — replace `newComments` with the two new counts

### 2. `pr-rework.schema.json`

- [ ] **Add `resolved_comments` array field** (optional, not in `required`):
  ```json
  "resolved_comments": {
    "type": "array",
    "description": "Open review comments resolved without code changes. The coder closes each thread (optionally with a reply) and logs it here.",
    "items": {
      "type": "object",
      "properties": {
        "comment_id": {
          "type": "number",
          "description": "GitHub comment databaseId"
        },
        "reply": {
          "type": "string",
          "description": "Optional reply posted before resolving"
        }
      },
      "required": ["comment_id"]
    }
  }
  ```

### 3. `prompts.js` — `prTasks` prompt (lines 100-116)

- [ ] **Update permissions** — explicitly say "You MAY use `gh` CLI to READ PR comments and use `gh api` to reply to and resolve review threads"
- [ ] **Add instruction for `"PR Comments"` check** — same as current behavior: read and assess, report in `rework_checks` or `touched_checks`
- [ ] **Add instruction for `"PR Review OPEN Comments"` check** — per-comment assessment:
  - If code changes needed → include in `rework_checks` with reason
  - If no rework needed → close thread via `gh api` (optional reply first), add to `resolved_comments[]`
- [ ] **Reference `resolved_comments`** in the prompt so the coder knows it exists

### 4. `server.js` — Address PR endpoint (lines 688-720)

- [ ] **Parse `resolved_comments` from coder output** alongside `rework_checks` and `touched_checks`
- [ ] **Log each resolved comment** as activity entry:
  ```js
  db.logActivity(ticket.id, 'pr_comment_resolved', `Comment #${rc.comment_id}: ${rc.reply || '(no reply)'}`);
  ```
- [ ] **Include resolution in touched state** — if any comments were resolved, treat the `"PR Review OPEN Comments"` check as addressed (affects flow smoothly)

### 5. Verification

- [ ] **Locally test `gh api graphql`** with the review threads query on the target repo (already confirmed working on nuro-ai)
- [ ] **Run a test "Address PR" flow** end-to-end with a ticket that has both general comments and open review threads
