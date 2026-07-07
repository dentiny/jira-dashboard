# Allow PR review feedback during "PR Opened" stage

## Goal
While a ticket is in the `pr_opened` stage, allow the user to provide PR review feedback via the same textarea + "Send Feedback" button used during the `review` stage, moving the ticket back to `clarification` with their feedback.

## Changes

### 1. `server.js` — Relax `/feedback` stage gate (line 785)

```
if (ticket.stage !== 'review') return res.status(400).json({ error: `Ticket is in ${ticket.stage} stage` });
```
→
```
if (ticket.stage !== 'review' && ticket.stage !== 'pr_opened') return res.status(400).json({ error: `Ticket is in ${ticket.stage} stage` });
```

### 2. `client/src/App.tsx` — Show feedback textarea for both `review` and `pr_opened`

Extract the `<Section title="Feedback (optional)">` block (lines 1675–1685) from inside the Review section wrapper (`{sel.stage === 'review' && ...}`, lines 1576–1687) and place it as a standalone block between the Review section and the Done/PR Opened section with:

```tsx
{(sel.stage === 'review' || sel.stage === 'pr_opened') && (
  <Section title="Feedback (optional)">
    <textarea ...existing props... />
    {error && <p className="t-small text-red-600 mt-1.5">{error}</p>}
  </Section>
)}
```

### 3. `client/src/App.tsx` — Add "Send Feedback" button to `pr_opened` footer

Replace the existing `pr_opened` footer block (lines 1890–1893):

```tsx
{sel.stage === 'pr_opened' && sel.status !== 'running' && cfg.mergeStrategy === 'pr' && (
  <>
    <Btn variant="secondary" onClick={sendFeedback} disabled={busy || !feedback.trim()}>
      {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
      Send Feedback
    </Btn>
    {sel.pr_rework_needed === 0 && (
      <Btn variant="secondary" onClick={() => handlePrTasks(sel.id)}>
        <ExternalLink className="h-3.5 w-3.5" /> Address PR
      </Btn>
    )}
  </>
)}
```

### 4. `pr-checker.js` — Prevent ghost feedback race (after line 97)

Add a stage re-check right before the write operations to prevent the PR checker from overwriting `review_feedback` if the user submitted feedback (which moves the ticket to `clarification`) between the initial stage check and the DB write.

Insert after line 97 (`prStates.set(tid, sig);`), before line 99 (`const needsMove = ...`):

```javascript
// Re-check stage — user may have moved ticket since we started
const now = db.getTicket(tid);
if (!now || now.stage !== 'pr_opened') return;
```

## Ordering
Apply changes in this order:
1. `pr-checker.js` — race guard first (safest)
2. `server.js` — relax gate
3. `client/src/App.tsx` — textarea visibility
4. `client/src/App.tsx` — footer button
