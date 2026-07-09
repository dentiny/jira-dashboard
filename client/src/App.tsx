import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { timeAgo } from './lib/utils'

const ACTIVITY_MAX_VISIBLE = 24
const FILES_MODIFIED_MAX_VISIBLE = 12
const OTHER_MARKER = '__other__'
import {
  Loader2, Link as LinkIcon, ExternalLink, Play, Shield,
  RefreshCw, ArrowRight, X, ChevronRight, Circle, Copy, Check, Sun, Moon, Monitor,
  GitBranch, GitPullRequest, Ban
} from 'lucide-react'

/* Extract a GitHub PR number from a PR URL (…/pull/123).
   Returns null for compare/create fallback links (…/pull/new/branch). */
function prNumberFromUrl(url?: string | null): number | null {
  if (!url) return null
  const m = url.match(/\/pull\/(\d+)(?:$|[/?#])/)
  return m ? Number(m[1]) : null
}

/* Resolve a ticket's PR URL: prefer the persisted pr_url column, but fall
   back to the pr_created / pr_link activity entry so tickets completed before
   pr_url was persisted still surface their PR link. */
function resolvePrUrl(t: { pr_url?: string | null; activity?: { action: string; detail: string }[] }): string | null {
  if (t.pr_url) return t.pr_url
  const entry = (t.activity || []).find(a => a.action === 'pr_created' || a.action === 'pr_link')
  return entry?.detail || null
}

/* ─────────────────────────────────────────────────────────
   Domain types
   ───────────────────────────────────────────────────────── */
interface Q { id: number; question: string; answer: string | null; round: number; type?: string; options?: string[] }
interface A { action: string; detail: string; time: string }
interface S {
  cpu: number; elapsed: number; peak_mem: number;
  tokens_in: number; tokens_out: number; cost: number; calls: number;
}
interface SR { buckets: ({ stage: string } & S)[]; total: S }
interface TestRun {
  id: number
  ticket_id: string
  status: 'running' | 'pass' | 'fail' | 'skip' | 'error'
  framework: string | null
  command: string | null
  exit_code: number | null
  summary: string | null
  output: string
  duration_ms: number | null
  triggered_by: string
  started_at: string
  finished_at: string | null
}
interface T {
  id: string; title: string; content: string; stage: string; status?: string
  plan: string | null; worktree_path: string | null; branch_name: string | null
  commit_sha: string | null; pr_url?: string | null; review_feedback: string | null
  estimated_complexity?: string | null
  plan_notes?: string | null
  questions: Q[]; activity: A[]; created_at: string; updated_at: string
  total_cpu?: string; total_elapsed?: string
  stage_resources?: SR
  latest_test?: TestRun | null
  behind_count?: number | null
  pr_state?: string | null
  pr_rework_needed?: number | null
  pr_touched_checks?: { name: string; action: string; result: string }[] | null
  impl_count?: number | null
  qa_count?: number | null
}

type Sug = { id: string; title: string; content: string }

/* ─────────────────────────────────────────────────────────
   Stage vocabulary — single source of truth.
   Order in the board, label, color, accent dot.
   ───────────────────────────────────────────────────────── */
type Stage = 'clarification' | 'implementation' | 'review' | 'pr_opened' | 'done'

const STAGES: Stage[] = ['clarification', 'implementation', 'review', 'pr_opened', 'done']

const STAGE_META: Record<Stage, { label: string; dot: string; pill: string }> = {
  clarification: {
    label: 'Clarification',
    dot:   'bg-blue-500',
    pill:  'bg-blue-50 text-blue-700 ring-1 ring-blue-200/70',
  },
  implementation: {
    label: 'Implementation',
    dot:   'bg-amber-500',
    pill:  'bg-amber-50 text-amber-700 ring-1 ring-amber-200/70',
  },
  review: {
    label: 'Review',
    dot:   'bg-violet-500',
    pill:  'bg-violet-50 text-violet-700 ring-1 ring-violet-200/70',
  },
  pr_opened: {
    label: 'PR Opened',
    dot:   'bg-emerald-500',
    pill:  'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200/70',
  },
  done: {
    label: 'Done',
    dot:   'bg-ink-3',
    pill:  'bg-surface-3 text-ink-2 ring-1 ring-border',
  },
}

/* ─────────────────────────────────────────────────────────
   Tiny UI primitives — no shadcn noise.
   ───────────────────────────────────────────────────────── */
function Btn({
  variant = 'default', size = 'md', children, className = '', ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'outline' | 'ghost' | 'danger' | 'secondary'
  size?: 'sm' | 'md'
}) {
  const base =
    'inline-flex items-center justify-center gap-1.5 font-medium rounded-md ' +
    'transition-colors disabled:opacity-50 disabled:cursor-not-allowed ' +
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900/20'
  // sm: 40px on phones (h-10), 28px on desktop (h-7).  md: 44px on phones (h-11), 36px on desktop (h-9).
  const sizes = {
    sm: 'h-10 sm:h-7 px-3 sm:px-2.5 t-body sm:t-small',
    md: 'h-11 sm:h-9 px-4 sm:px-3 t-body',
  }
  const variants = {
    default:    'bg-brand text-brand-fg hover:bg-zinc-700',
    outline:    'bg-surface text-ink-2 ring-1 ring-border hover:bg-bg hover:text-ink-1',
    ghost:      'text-ink-2 hover:bg-surface-3 hover:text-ink-1',
    secondary:  'bg-surface-3 text-ink-2 hover:bg-surface-3',
    danger:     'bg-red-600 text-white hover:bg-red-700',
  }
  return (
    <button className={`${base} ${sizes[size]} ${variants[variant]} ${className}`} {...rest}>
      {children}
    </button>
  )
}

function StagePill({ stage }: { stage: string }) {
  const m = STAGE_META[stage as Stage]
  if (!m) return <span className="t-meta text-ink-2">{stage}</span>
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 t-meta font-medium ${m.pill}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${m.dot}`} />
      {m.label}
    </span>
  )
}

function IconBtn({ children, label, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      aria-label={label}
      className="h-10 w-10 sm:h-7 sm:w-7 inline-flex items-center justify-center rounded-md text-ink-2 hover:text-ink-1 hover:bg-surface-3 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900/20"
      {...rest}
    >
      {children}
    </button>
  )
}

/* ─────────────────────────────────────────────────────────
   Card
   ───────────────────────────────────────────────────────── */
function TicketCard({ t, onOpen, loading, highlighted }: { t: T; onOpen: (id: string) => void; loading?: boolean; highlighted?: boolean }) {
  const meta = STAGE_META[t.stage as Stage]
  const running = t.status === 'running'
  const qaCount = t.qa_count || 0
  const implCount = t.impl_count || 0
  return (
    <button
      onClick={() => { if (!loading) onOpen(t.id) }}
      className={`group w-full text-left bg-surface rounded-lg ring-1 hover:ring-ink-3 hover:shadow-sm active:bg-bg transition-all p-3.5 flex flex-col gap-2.5 ${loading ? 'opacity-50 pointer-events-none' : ''} ${highlighted ? 'ring-2 ring-blue-500/60 animate-[attention-pulse_2s_ease-in-out_infinite]' : 'ring-border'}`}
    >
      <div className="flex items-center justify-between">
        <span className="t-mono-11 text-ink-3 truncate">{t.id}</span>
        {loading && <Loader2 className="h-3.5 w-3.5 text-accent animate-spin" />}
        {!loading && running && <Loader2 className="h-3.5 w-3.5 text-amber-500 animate-spin" />}
      </div>
      <p className="t-body font-medium text-ink-1 clamp-2 leading-snug flex-1">{t.title}</p>
      <div className="flex items-center justify-between pt-1 border-t border-surface-3">
        <div className="flex items-center gap-1.5 t-meta text-ink-2 min-w-0">
          {meta && <span className={`h-1.5 w-1.5 rounded-full ${meta.dot} shrink-0`} />}
          <span className="truncate">{timeAgo(t.updated_at)}</span>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {qaCount > 0 && (
            <span className="t-meta text-ink-2 bg-surface-3 px-1.5 py-0.5 rounded">
              {qaCount} Q&amp;A
            </span>
          )}
          {implCount > 0 && (
            <span className="t-meta text-ink-2 bg-surface-3 px-1.5 py-0.5 rounded">
              {implCount} impl{implCount === 1 ? '' : 's'}
            </span>
          )}
        </div>
      </div>
    </button>
  )
}

/* ─────────────────────────────────────────────────────────
   Question card — long questions get a Read more toggle.
   Uses the t-body size (13px) consistently.
   ───────────────────────────────────────────────────────── */
function QuestionCard({
  q, index, answer, onAnswer, disabled,
}: {
  q: Q; index: number; answer: string; onAnswer: (v: string) => void; disabled: boolean
}) {
  const [expanded, setExpanded] = useState(false)
  const [otherText, setOtherText] = useState('')
  const long = q.question.length > 110
  const isMC = q.type === 'multiple_choice' && q.options && q.options.length > 0
  // Was "Other" selected? true when answer is a custom value not in the option list.
  const isOther = answer.startsWith(OTHER_MARKER)
  const otherValue = isOther ? answer.slice(OTHER_MARKER.length) : ''

  return (
    <div className="rounded-lg ring-1 ring-border bg-surface p-3.5">
      <div className="flex gap-3">
        <span className="t-mono-11 text-ink-3 shrink-0 mt-0.5 w-6">Q{index}</span>
        <div className="flex-1 min-w-0">
          <p
            className={`t-body text-ink-1 leading-relaxed ${!expanded && long ? 'clamp-3' : ''}`}
            title={q.question}
          >
            {q.question}
          </p>
          {long && (
            <button
              onClick={() => setExpanded(s => !s)}
              className="t-meta text-ink-2 hover:text-ink-1 mt-1 font-medium"
            >
              {expanded ? 'Show less' : 'Read more'}
            </button>
          )}

          {q.answer ? (
            <div className="mt-2 flex gap-2.5 pl-3 border-l-2 border-emerald-300 bg-emerald-50/50 rounded-r py-1.5 pr-2">
              <span className="t-mono-11 text-emerald-600 shrink-0 mt-0.5">A{index}</span>
              <p className="t-body text-emerald-900 leading-relaxed">{q.answer}</p>
            </div>
          ) : isMC ? (
            <fieldset className="mt-2 space-y-1">
              {q.options!.map((opt, oi) => (
                <label
                  key={oi}
                  className={`flex items-center gap-2 px-2.5 py-1.5 rounded-md cursor-pointer transition-colors t-body ${
                    answer === opt
                      ? 'bg-brand text-brand-fg'
                      : 'hover:bg-surface-3 text-ink-2'
                  }`}
                >
                  <input
                    type="radio"
                    name={`q-${q.id}`}
                    value={opt}
                    checked={answer === opt}
                    onChange={e => { setOtherText(''); onAnswer(e.target.value) }}
                    disabled={disabled}
                    className="sr-only"
                  />
                  <span className={`h-3.5 w-3.5 rounded-full border-2 flex items-center justify-center shrink-0 ${
                    answer === opt ? 'border-white' : 'border-ink-3'
                  }`}>
                    {answer === opt && <span className="h-1.5 w-1.5 rounded-full bg-surface" />}
                  </span>
                  {opt}
                </label>
              ))}
              {/* "Other" option */}
              <label
                className={`flex items-center gap-2 px-2.5 py-1.5 rounded-md cursor-pointer transition-colors t-body ${
                  isOther
                    ? 'bg-brand text-brand-fg'
                    : 'hover:bg-surface-3 text-ink-2'
                }`}
              >
                <input
                  type="radio"
                  name={`q-${q.id}`}
                  value={OTHER_MARKER}
                  checked={isOther}
                  onChange={e => { setOtherText(''); onAnswer(OTHER_MARKER) }}
                  disabled={disabled}
                  className="sr-only"
                />
                <span className={`h-3.5 w-3.5 rounded-full border-2 flex items-center justify-center shrink-0 ${
                  isOther ? 'border-white' : 'border-ink-3'
                }`}>
                  {isOther && <span className="h-1.5 w-1.5 rounded-full bg-surface" />}
                </span>
                Something else…
              </label>
              {isOther && (
                <div className="pl-7 pt-1">
                  <input
                    value={otherValue}
                    onChange={e => onAnswer(OTHER_MARKER + e.target.value)}
                    name={`a-${q.id}-other`}
                    placeholder="Type your answer…"
                    disabled={disabled}
                    autoFocus
                    className="w-full h-8 px-2.5 rounded-md ring-1 ring-border focus:ring-2 focus:ring-zinc-900/20 t-small text-ink-1 placeholder:text-ink-3 bg-surface"
                  />
                </div>
              )}
            </fieldset>
          ) : (
            <input
              value={answer}
              onChange={e => onAnswer(e.target.value)}
              name={`a-${q.id}`}
              placeholder="Type your answer (optional)…"
              disabled={disabled}
              className="mt-2 w-full h-8 px-2.5 rounded-md ring-1 ring-border focus:ring-2 focus:ring-zinc-900/20 t-small text-ink-1 placeholder:text-ink-3 bg-surface"
            />
          )}
        </div>
      </div>
    </div>
  )
}

/* ─────────────────────────────────────────────────────────
   Activity sidebar — same scroll context, no nested scroll.
   ───────────────────────────────────────────────────────── */
function ActivitySidebar({ items }: { items: A[] }) {
  const [expanded, setExpanded] = useState<Record<number, boolean>>({})
  if (!items.length) {
    return (
      <aside className="w-full lg:w-[240px] shrink-0 border-t lg:border-t-0 lg:border-l border-border pt-4 lg:pt-0 lg:pl-4">
        <h4 className="t-meta font-semibold text-ink-2 uppercase tracking-wider mb-3">Activity</h4>
        <p className="t-small text-ink-3">No activity yet.</p>
      </aside>
    )
  }
  return (
    <aside className="w-full lg:w-[240px] shrink-0 border-t lg:border-t-0 lg:border-l border-border pt-4 lg:pt-0 lg:pl-4">
      <h4 className="t-meta font-semibold text-ink-2 uppercase tracking-wider mb-3">
        Activity
        <span className="ml-1.5 text-ink-3 normal-case tracking-normal font-normal">
          {items.length}
        </span>
      </h4>
      <ol className="space-y-1.5">
        {items.slice(0, ACTIVITY_MAX_VISIBLE).map((a, i) => (
          <li key={i}>
            <button
              onClick={() => setExpanded(s => ({ ...s, [i]: !s[i] }))}
              className="w-full text-left rounded px-2 py-2 sm:px-1.5 sm:py-1 -mx-2 sm:-mx-1.5 hover:bg-bg active:bg-surface-3 transition-colors"
            >
              <div className="flex items-baseline gap-2">
                <span className="t-mono-11 text-ink-3 shrink-0 w-14 sm:w-12">{timeAgo(a.time)}</span>
                <span className="t-small font-medium text-ink-2 truncate">{a.action}</span>
              </div>
              {expanded[i] && a.detail && (
                <div className="mt-1 ml-14 pl-2 border-l border-border">
                  <p className="t-mono-11 text-ink-2 break-words leading-relaxed whitespace-pre-wrap">
                    {a.detail}
                  </p>
                </div>
              )}
            </button>
          </li>
        ))}
      </ol>
    </aside>
  )
}

/* ─────────────────────────────────────────────────────────
   Resource metrics — read from "resource" activity entries.
   ───────────────────────────────────────────────────────── */
function fmtNum(v: number) { return v > 1000 ? v.toFixed(0) : v > 10 ? v.toFixed(1) : v.toFixed(2) }
function fmtCost(c: number) { return c > 0 ? '$' + (c > 1 ? c.toFixed(2) : c.toFixed(4)) : '—' }
function parseToken(s: string | undefined) {
  if (!s) return 0
  s = s.replace(/,/g, '')
  if (s.endsWith('B')) return parseFloat(s) * 1e9
  if (s.endsWith('M')) return parseFloat(s) * 1e6
  if (s.endsWith('K')) return parseFloat(s) * 1e3
  return parseFloat(s) || 0
}
function fmtToken(n: number) {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B'
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K'
  return n.toFixed(0)
}
function parseCost(s: string | undefined) {
  return parseFloat((s || '0').replace(/[$,]/g, '')) || 0
}

function SuggestionCard({ sug, onAccept, onDismiss }: { sug: Sug; onAccept: (s: Sug) => void; onDismiss: (s: Sug) => void }) {
  const [open, setOpen] = useState(false)
  return (
    <div
      className="bg-surface rounded-lg ring-1 ring-border px-3.5 py-2.5 cursor-pointer hover:ring-ink-2 transition-colors"
      onClick={() => setOpen(o => !o)}
    >
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <p className={`t-body font-medium text-ink-1 ${open ? '' : 'truncate'}`}>{sug.title}</p>
          <p className={`t-small text-ink-2 mt-0.5 ${open ? '' : 'clamp-2'}`}>{sug.content}</p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0" onClick={e => e.stopPropagation()}>
          <button onClick={() => onAccept(sug)} className="px-2.5 py-1 rounded text-xs font-medium bg-brand text-brand-fg hover:bg-zinc-700">Accept</button>
          <button onClick={() => onDismiss(sug)} className="px-2.5 py-1 rounded text-xs font-medium text-ink-3 hover:text-ink-2 hover:bg-surface-3">Dismiss</button>
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────
// TestReportPanel — shows pass/fail pill + summary + collapsible
// output for the latest unit-test run.  Lives inside the ticket
// popup on the review / done stages.  Reads from
// `ticket.latest_test` (auto-refreshed via SSE).
//
// UX:
//   • running → amber pill with spinner; output hidden
//   • pass    → green pill + summary; output collapsible
//   • fail    → red pill + summary + last 60 lines auto-shown
//   • skip    → zinc pill + skip reason
//   • error   → red pill + crash message
//   • missing → "No tests run yet" (with Re-run button)
// ─────────────────────────────────────────────────────────
function TestReportPanel({
  test, onRerun, rerunning, autoExpandFail = true,
}: {
  test?: TestRun | null
  onRerun: () => void
  rerunning: boolean
  autoExpandFail?: boolean
}) {
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    if (autoExpandFail && test && (test.status === 'fail' || test.status === 'error')) {
      setExpanded(true)
    }
  }, [test?.id, test?.status, autoExpandFail])

  if (!test) {
    return (
      <div className="flex items-center justify-between rounded-md ring-1 ring-border bg-bg px-3 py-2.5">
        <div className="flex items-center gap-2 t-small text-ink-2">
          <Circle className="h-3.5 w-3.5 text-ink-3" />
          No tests run yet
        </div>
        <Btn variant="outline" size="sm" onClick={onRerun} disabled={rerunning}>
          {rerunning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          Run tests
        </Btn>
      </div>
    )
  }

  const pill = (() => {
    switch (test.status) {
      case 'running': return <StatusPill kind="info"><Loader2 className="h-3 w-3 animate-spin" /> Running tests</StatusPill>
      case 'pass':    return <StatusPill kind="success"><Check className="h-3 w-3" /> Tests passed</StatusPill>
      case 'fail':    return <StatusPill kind="danger"><X className="h-3 w-3" /> Tests failed</StatusPill>
      case 'skip':    return <StatusPill kind="info">Tests skipped</StatusPill>
      case 'error':   return <StatusPill kind="danger"><X className="h-3 w-3" /> Test runner error</StatusPill>
    }
  })()

  const meta = [
    test.framework && `${test.framework}`,
    test.summary && `· ${test.summary}`,
    test.duration_ms != null && `· ${(test.duration_ms / 1000).toFixed(1)}s`,
    test.triggered_by && test.triggered_by !== 'auto' && `· ${test.triggered_by}`,
  ].filter(Boolean).join(' ')

  const outputLines = test.output ? test.output.split('\n') : []
  const shownLines = expanded ? outputLines : outputLines.slice(-30)
  const hasMore = outputLines.length > 30

  return (
    <div className="rounded-md ring-1 ring-border bg-surface overflow-hidden">
      <div className="flex items-center justify-between gap-3 px-3 py-2.5">
        <div className="flex items-center gap-2 min-w-0">
          {pill}
          {meta && <span className="t-small text-ink-2 truncate">{meta}</span>}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {test.output && (
            <Btn variant="ghost" size="sm" onClick={() => setExpanded(e => !e)}>
              {expanded ? 'Hide output' : 'View output'}
            </Btn>
          )}
          <Btn variant="outline" size="sm" onClick={onRerun} disabled={rerunning || test.status === 'running'}>
            {rerunning || test.status === 'running'
              ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
              : <RefreshCw className="h-3.5 w-3.5" />}
            Re-run
          </Btn>
        </div>
      </div>
      {test.command && (
        <div className="px-3 py-1.5 border-t border-surface-3 t-mono-11 text-ink-2 truncate">
          $ {test.command}
        </div>
      )}
      {test.output && expanded && (
        <pre className="bg-zinc-950 text-zinc-100 px-3 py-2.5 t-mono-12 leading-relaxed whitespace-pre-wrap break-words max-h-72 overflow-y-auto">
{shownLines.join('\n')}
        </pre>
      )}
      {test.output && !expanded && hasMore && test.status !== 'fail' && test.status !== 'error' && (
        <pre className="bg-zinc-950 text-zinc-100 px-3 py-2.5 t-mono-12 leading-relaxed whitespace-pre-wrap break-words max-h-40 overflow-y-auto opacity-80">
{shownLines.join('\n')}
        </pre>
      )}
    </div>
  )
}

function ResourceMetrics({
  activity, stageResources, status,
}: {
  activity: A[]; stageResources?: SR; status?: string
}) {
  const sr = stageResources
  const r = (activity || []).filter(a => a.action === 'resource')
  const hasLive = r.length > 0 && status === 'running'
  const hasFinished = sr && sr.buckets.length > 0
  const hasLegacyTotal = !hasFinished && sr && sr.total.cpu > 0

  if (!hasLive && !hasFinished && !hasLegacyTotal) return null

  const stageLabels: Record<string, string> = {
    clarification: 'Clarification',
    implementation: 'Implementation',
    pr_opened: 'PR Processing',
  }
  const labelForStage = (s: string) => stageLabels[s] || s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, ' ')

  const p = (s: string) => Object.fromEntries(s.split(' ').map(x => x.split('=')))
  const cur = r.length ? p(r[0].detail) : null
  const cpu = parseFloat(cur?.cpu) || 0
  const mem = parseFloat(cur?.mem) || 0
  const el = parseInt(cur?.elapsed) || 1
  const cores = parseInt(cur?.ncores) || 8
  const prev = r.length > 1 ? p(r[1].detail) : null
  const dt = (el - (parseInt(prev?.elapsed) || 0)) || 3
  const rate = prev ? (cpu - (parseFloat(prev?.cpu) || 0)) / dt : cpu / el
  const cpuPct = Math.min(rate / cores * 100, 100)
  const peakMem = Math.max(...r.map(e => parseFloat(p(e.detail).mem) || 0), mem)
  const memPct = Math.min((mem / (peakMem || 1)) * 100, 100)
  // Find the baseline resource event from BEFORE the current run started.
  // Run-start markers in the activity log separate runs; the resource event
  // immediately after (older than) the most recent marker is the last sample
  // from the previous run.  The delta from that baseline to the current event
  // gives cost/tokens for just this run, excluding global opencode stats.
  const runStartMarkers = new Set(['answer_process', 'implement_start', 'pr_tasks_start', 'continued'])
  let liveBaseline = null
  const act = activity || []
  const startIdx = act.findIndex(a => runStartMarkers.has(a.action))
  if (startIdx >= 0) {
    for (let i = startIdx + 1; i < act.length; i++) {
      if (act[i].action === 'resource') { liveBaseline = p(act[i].detail); break }
    }
  }
  // Fall back to the oldest resource entry when there's no start marker
  // (e.g. first ever run — bucket everything).
  if (!liveBaseline && r.length > 1) liveBaseline = p(r[r.length - 1].detail)
  const liveTokensIn = liveBaseline ? Math.max(0, parseToken(cur?.tokens_in) - parseToken(liveBaseline?.tokens_in)) : (parseToken(cur?.tokens_in) || 0)
  const liveTokensOut = liveBaseline ? Math.max(0, parseToken(cur?.tokens_out) - parseToken(liveBaseline?.tokens_out)) : (parseToken(cur?.tokens_out) || 0)
  const liveCost = liveBaseline ? Math.max(0, parseCost(cur?.cost) - parseCost(liveBaseline?.cost)) : (parseCost(cur?.cost) || 0)

  const renderBucket = (label: string, s: S | null) => {
    if (!s || s.cpu === 0) return null
    const tag = s.calls > 1 ? `${s.calls} calls` : '1 call'
    return (
      <div className="space-y-1">
        <h5 className="t-meta text-ink-2 uppercase tracking-wider flex items-baseline gap-1.5">
          {label} <span className="normal-case tracking-normal font-normal text-ink-3">{tag}</span>
        </h5>
        <div className="grid grid-cols-2 gap-2">
          <MetricCompact label="CPU"     value={`${fmtNum(s.cpu)}s`} />
          <MetricCompact label="Elapsed" value={`${s.elapsed}s`} />
          <MetricCompact label="Memory"  value={`${s.peak_mem.toFixed(0)} MB`} />
          <MetricCompact label="Cost"    value={fmtCost(s.cost)} />
          {s.tokens_in > 0 && <MetricCompact label="Tokens" value={`${fmtToken(s.tokens_in)} in · ${fmtToken(s.tokens_out)} out`} />}
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {/* Per-stage breakdown */}
      {hasFinished && sr.buckets.map(b => (
        b.cpu > 0 && renderBucket(labelForStage(b.stage), b)
      ))}

      {/* Legacy total (old tickets without per-stage tags) */}
      {hasLegacyTotal && (
        <div className="grid grid-cols-2 gap-2">
          <MetricCompact label="CPU total"   value={`${fmtNum(sr.total.cpu)}s`} />
          <MetricCompact label="Elapsed"     value={`${sr.total.elapsed}s`} />
          <MetricCompact label="Memory peak" value={`${sr.total.peak_mem.toFixed(0)} MB`} />
          <MetricCompact label="Cost"        value={fmtCost(sr.total.cost)} />
          {sr.total.tokens_in > 0 && <MetricCompact label="Tokens" value={`${fmtToken(sr.total.tokens_in)} in · ${fmtToken(sr.total.tokens_out)} out`} />}
        </div>
      )}

      {/* Running metrics (live) shown below per-stage totals */}
      {hasLive && (
        <div className="space-y-1">
          <h5 className="t-meta text-ink-2 uppercase tracking-wider">Live</h5>
          <div className="grid grid-cols-2 gap-2">
            <MetricCompact label="CPU rate" value={`${fmtNum(rate)}/${cores} cores`} />
            <MetricCompact label="Memory"   value={`${mem.toFixed(0)} MB`} />
            <MetricCompact label="Threads"  value={cur?.threads || '—'} />
            <MetricCompact label="Elapsed"  value={`${el}s`} />
            {liveTokensIn > 0 && <MetricCompact label="Tokens" value={`${fmtToken(liveTokensIn)} in · ${fmtToken(liveTokensOut)} out`} />}
            {liveCost > 0 && <MetricCompact label="Cost" value={fmtCost(liveCost)} />}
            {cpuPct !== undefined && (
              <div className="col-span-2">
                <div className="flex items-baseline justify-between t-meta text-ink-2 uppercase tracking-wider font-medium">
                  <span>CPU util</span>
                  <span className="t-mono-11 text-ink-3">{cpuPct.toFixed(0)}%</span>
                </div>
                <div className="mt-1 h-1 rounded-full bg-surface-3 overflow-hidden">
                  <div className="h-full bg-zinc-900" style={{ width: cpuPct + '%' }} />
                </div>
              </div>
            )}
            <div className="col-span-2">
              <div className="flex items-baseline justify-between t-meta text-ink-2 uppercase tracking-wider font-medium">
                <span>Memory util</span>
                <span className="t-mono-11 text-ink-3">{mem.toFixed(0)} / {peakMem.toFixed(0)} MB</span>
              </div>
              <div className="mt-1 h-1 rounded-full bg-surface-3 overflow-hidden">
                <div className="h-full bg-zinc-900" style={{ width: memPct + '%' }} />
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Grand total (shown when there's per-stage data) */}
      {hasFinished && (
        <div className="border-t border-border pt-3 grid grid-cols-2 gap-2">
          <MetricCompact label="CPU total"   value={`${fmtNum(sr.total.cpu)}s`} />
          <MetricCompact label="Elapsed"     value={`${sr.total.elapsed}s`} />
          <MetricCompact label="Memory peak" value={`${sr.total.peak_mem.toFixed(0)} MB`} />
          <MetricCompact label="Cost"        value={fmtCost(sr.total.cost)} />
          {sr.total.tokens_in > 0 && <MetricCompact label="Tokens" value={`${fmtToken(sr.total.tokens_in)} in · ${fmtToken(sr.total.tokens_out)} out`} />}
        </div>
      )}
    </div>
  )
}

function MetricCompact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-x-2">
      <span className="t-meta text-ink-2 uppercase tracking-wider font-medium shrink-0">{label}</span>
      <span className="t-mono-11 text-ink-2 text-right break-words">{value}</span>
    </div>
  )
}

function Metric({ label, value, pct, barClass, sub }:
  { label: string; value: string; pct?: number; barClass?: string; sub?: string }) {
  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:items-baseline sm:justify-between gap-y-0.5 sm:gap-x-2">
        <span className="t-meta text-ink-2 uppercase tracking-wider font-medium">{label}</span>
        <span className="t-mono-11 text-ink-2 sm:text-right break-words">{value}</span>
      </div>
      {pct !== undefined && (
        <div className="mt-1 h-1 rounded-full bg-surface-3 overflow-hidden">
          <div className={`h-full ${barClass}`} style={{ width: pct + '%' }} />
        </div>
      )}
      {sub && <div className="t-mono-11 text-ink-3 mt-0.5">{sub}</div>}
    </div>
  )
}

/* ─────────────────────────────────────────────────────────
   JSON helper
   ───────────────────────────────────────────────────────── */
function fetchJSON<T = any>(url: string, opts?: RequestInit): Promise<T> {
  return fetch(url, opts).then(r =>
    r.ok ? r.json() : r.json().then(e => { throw new Error(e.error || 'Request failed') })
  )
}

/* ─────────────────────────────────────────────────────────
   Browser notifications
   ───────────────────────────────────────────────────────── */
let notifyPerm: NotificationPermission | '' = ''
function ensureNotifyPerm() {
  if (!('Notification' in window)) return
  if (Notification.permission === 'granted') { notifyPerm = 'granted'; return }
  if (Notification.permission === 'denied') return
  Notification.requestPermission().then(p => { notifyPerm = p })
}
function notify(title: string, body: string) {
  if (notifyPerm !== 'granted' || document.visibilityState === 'visible') return
  try { new Notification(title, { body, icon: '/favicon.ico' }) } catch {}
}

/* ─────────────────────────────────────────────────────────
   App
   ───────────────────────────────────────────────────────── */
interface ClientConfig { projectName: string; remoteHost: string; explorer: { url: string; owner: string; repo: string }; testEnabled: boolean; branchDefault?: string; mergeStrategy?: string }

export default function App() {
  const [tickets, setTickets] = useState<T[]>([])
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [creating, setCreating] = useState(false)
  const [sel, setSel] = useState<T | null>(null)
  const [error, setError] = useState('')
  const [answers, setAnswers] = useState<Record<number, string>>({})
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [out, setOut] = useState({ open: false, title: '', text: '', status: '' })
  const [machineChecks, setMachineChecks] = useState<{ name: string; status: string; detail: string }[]>([])
  const [machineChecksLoading, setMachineChecksLoading] = useState(true)
  const [suggestions, setSuggestions] = useState<Sug[]>([])
  const [suggestionsLoading, setSuggestionsLoading] = useState(true)
  const [suggestionsFailed, setSuggestionsFailed] = useState(false)
  const [loadingId, setLoadingId] = useState<string | null>(null)
  const abort = useRef<AbortController | null>(null)
  const [theme, setTheme] = useState<'auto' | 'dark' | 'light'>(
    (typeof localStorage !== 'undefined' && localStorage.getItem('theme') as any) || 'auto'
  )
  const [cfg, setCfg] = useState<ClientConfig>({ projectName: 'Board', remoteHost: 'example-claw', explorer: { url: '', owner: '', repo: '' }, testEnabled: false })
  const [diff, setDiff] = useState('')
  const [diffFiles, setDiffFiles] = useState<{ path: string; explorer_prefix: string | null }[]>([])
  const [diffCommitSha, setDiffCommitSha] = useState('')
  const [todoItems, setTodoItems] = useState<{ done: boolean; text: string }[]>([])
  const [stdoutLines, setStdoutLines] = useState<string[]>([])
  const [copied, setCopied] = useState(false)
  const [testExpanded, setTestExpanded] = useState(false)
  const [testReRunning, setTestReRunning] = useState(false)
  const [rebaseLoading, setRebaseLoading] = useState(false)
  const poll = useRef<EventSource>()
  const lastUpd = useRef('')
  const [highlightedIds, setHighlightedIds] = useState<Set<string>>(new Set())
  const prevTicketsRef = useRef<Map<string, T>>(new Map())

  const load = useCallback(async () => {
    try {
      const d = await fetchJSON<{ tickets: T[] }>('/api/tickets')
      const prev = prevTicketsRef.current
      const changed: string[] = []
      for (const t of d.tickets) {
        const old = prev.get(t.id)
        if (old && old.status === 'running' && t.status === 'idle' && old.stage !== t.stage && (t.stage === 'review' || t.stage === 'clarification' || t.stage === 'pr_opened' || t.stage === 'done')) changed.push(t.id)
      }
      prevTicketsRef.current = new Map(d.tickets.map(t => [t.id, t]))
      if (changed.length > 0) {
        setHighlightedIds(prev => { const next = new Set(prev); for (const id of changed) next.add(id); return next })
      }
      setTickets(d.tickets)
    } catch {}
  }, [])

  // Refs so the hash listener (registered once) sees the latest open/close.
  const selRef = useRef<T | null>(null)
  useEffect(() => { selRef.current = sel }, [sel])
  const openRef = useRef(open)
  useEffect(() => { openRef.current = open }, [open])

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const update = () => {
      const isDark = theme === 'dark' || (theme === 'auto' && mq.matches)
      document.documentElement.classList.toggle('dark', isDark)
    }
    update()
    mq.addEventListener('change', update)
    return () => mq.removeEventListener('change', update)
  }, [theme])

  function cycleTheme() {
    const next = theme === 'auto' ? 'dark' : theme === 'dark' ? 'light' : 'auto'
    setTheme(next)
    localStorage.setItem('theme', next)
  }

  useEffect(() => {
    fetchJSON<ClientConfig>('/api/config').then(setCfg).catch(() => {});
    fetchJSON<{ name: string; status: string; detail: string }[]>('/api/system/checks').then(d => { setMachineChecks(d); setMachineChecksLoading(false); }).catch(() => setMachineChecksLoading(false));
    load(); loadSuggestions(); ensureNotifyPerm(); const i = setInterval(load, 10000); return () => clearInterval(i)
  }, [load])

  // Open ticket from URL hash (#ticket/<id>) on mount, and react to hashchange.
  // Mobile / shared-link flow: pasting the URL opens the right ticket.
  useEffect(() => {
    const fromHash = () => {
      const m = location.hash.match(/^#ticket\/([\w-]+)/)
      const id = m?.[1]
      if (id) {
        if (id !== selRef.current?.id) openRef.current(id)
      } else if (selRef.current) {
        setSel(null)
        if (poll.current) { poll.current.close(); poll.current = undefined }
      }
    }
    fromHash()
    window.addEventListener('hashchange', fromHash)
    return () => window.removeEventListener('hashchange', fromHash)
  }, [])

  useEffect(() => {
    if (sel && location.hash !== '#ticket/' + sel.id) history.replaceState(null, '', '#ticket/' + sel.id)
  }, [sel])

  /* Open ticket — start SSE stream */
  async function open(id: string) {
    if (abort.current) { abort.current.abort(); abort.current = null }
    setLoadingId(id)
    const ac = new AbortController()
    abort.current = ac
    try {
      const t: T = await fetchJSON(`/api/tickets/${id}`, { signal: ac.signal })
      if (ac.signal.aborted) return
      abort.current = null; setLoadingId(null)
      setSel(t)
      setHighlightedIds(prev => { const next = new Set(prev); next.delete(id); return next })
      setTickets(p => p.map(x => (x.id === id ? t : x)))
      lastUpd.current = t.updated_at
      setAnswers({}); setDiff(''); setDiffFiles([]); setFeedback(''); setTodoItems([]); setStdoutLines([])
      setTestExpanded(false); setTestReRunning(false)
      if (poll.current) { poll.current.close(); poll.current = undefined }
      const es = new EventSource(`/api/tickets/${id}/stream`)
      poll.current = es

      es.addEventListener('resource', (e) => {
        try {
          const d = JSON.parse(e.data)
          if (d.detail) {
            setSel(p => p && p.id === id ? {
              ...p,
              activity: [{ id: -Date.now(), ticket_id: id, action: 'resource', detail: d.detail, time: new Date().toISOString(), stage: p.stage }, ...(p.activity || [])]
            } : p)
          }
        } catch {}
      })

      es.addEventListener('todo', (e) => {
        try {
          const d = JSON.parse(e.data)
          if (d.items) setTodoItems(d.items)
        } catch {}
      })

      es.addEventListener('stdout', (e) => {
        try {
          const d = JSON.parse(e.data)
          if (d.text) setStdoutLines(p => [...p.slice(-199), d.text])
        } catch {}
      })

      es.addEventListener('test_status', (e) => {
        try {
          const d = JSON.parse(e.data)
          // Refresh latest test from server (authoritative) and notify
          fetchJSON<TestRun>(`/api/tickets/${id}/tests`).then(({ latest }) => {
            setSel(p => p && p.id === id ? { ...p, latest_test: latest } : p)
            setTickets(p => p.map(x => x.id === id ? { ...x, latest_test: latest } : x))
            if (latest && latest.status !== 'running') {
              const stage = selRef.current?.stage || 'review'
              const label = latest.status === 'pass' ? 'tests passed'
                : latest.status === 'fail' ? 'tests failed'
                : latest.status === 'error' ? 'tests errored'
                : 'tests skipped'
              notify(`[${stage}] ${selRef.current?.title || id}`, label)
            }
          }).catch(() => {})
        } catch {}
      })

      es.addEventListener('ticket', (e) => {
        try {
          const f: T = JSON.parse(e.data)
          if (f.id === id) {
            const prev = selRef.current
            // Notify on meaningful transitions
            if (prev) {
              if (prev.status === 'running' && f.status === 'idle') {
                const label = f.stage === 'review' ? 'ready for review' :
                  f.stage === 'clarification' ? 'questions ready' :
                  'done'
                notify(f.title || f.id, `Stage: ${f.stage} — ${label}`)
              } else if (f.status === 'running' && prev.status !== 'running') {
                notify(f.title || f.id, `Started: ${f.stage}`)
              }
            }
            lastUpd.current = f.updated_at
            setTickets(p => p.map(x => (x.id === id ? f : x)))
            setSel(p => p && p.id === id ? f : p)
          }
        } catch {}
      })

      es.onerror = () => {} // auto-reconnect built into EventSource
    } catch (e: any) {
      if (e?.name === 'AbortError') return
      setError('Ticket not found')
    } finally {
      if (abort.current === ac) { abort.current = null; setLoadingId(null) }
    }
  }

  function close() {
    if (abort.current) { abort.current.abort(); abort.current = null; setLoadingId(null) }
    setSel(null)
    if (poll.current) { poll.current.close(); poll.current = undefined }
    if (location.hash.startsWith('#ticket/')) history.replaceState(null, '', ' ')
  }

  async function loadSuggestions() {
    setSuggestionsLoading(true); setSuggestionsFailed(false)
    let attempts = 0
    const poll = () => {
      if (++attempts > 15) { setSuggestionsLoading(false); setSuggestionsFailed(true); return }
      fetchJSON<Sug[]>('/api/suggestions').then(d => {
        if (d.length > 0) { setSuggestions(d); setSuggestionsLoading(false); return }
        setTimeout(poll, 3000)
      }).catch(() => setTimeout(poll, 3000))
    }
    poll()
  }

  async function acceptSuggestion(sug: Sug) {
    try {
      const t = await fetchJSON(`/api/suggestions/${sug.id}/accept`, { method: 'POST' })
      setSuggestions(p => p.filter(s => s.id !== sug.id))
      await fetchJSON(`/api/tickets/${t.id}/clarify`, { method: 'POST' })
      const u = await fetchJSON(`/api/tickets/${t.id}`)
      setSel(u); setTickets(p => [u, ...p])
      lastUpd.current = u.updated_at
    } catch (e: any) { setError(e.message) }
  }

  async function dismissSuggestion(sug: Sug) {
    try {
      await fetchJSON(`/api/suggestions/${sug.id}/dismiss`, { method: 'POST' })
      setSuggestions(p => p.filter(s => s.id !== sug.id))
    } catch {}
  }

  /* Board actions */
  async function create() {
    if (!title.trim()) { setError('Title required'); return }
    setCreating(true)
    try {
      const t: T = await fetchJSON('/api/tickets', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, content }),
      })
      setTitle(''); setContent(''); setError('')
      await fetchJSON(`/api/tickets/${t.id}/clarify`, { method: 'POST' })
      const u: T = await fetchJSON(`/api/tickets/${t.id}`)
      setSel(u); setTickets(p => [u, ...p.filter(x => x.id !== t.id)])
      lastUpd.current = u.updated_at
    } catch (e: any) { setError(e.message) } finally { setCreating(false) }
  }

  async function handlePrTasks(id: string) {
    setStdoutLines([])
    try {
      const t: T = await fetchJSON(`/api/tickets/${id}/pr-tasks`, { method: 'POST' })
      setSel(t); setTickets(p => p.map(x => (x.id === id ? t : x)))
      lastUpd.current = t.updated_at
    } catch (e: any) { setError(e.message) }
  }

  async function clarify(id: string) {
    try {
      const t: T = await fetchJSON(`/api/tickets/${id}/clarify`, { method: 'POST' })
      setSel(t); setTickets(p => p.map(x => (x.id === id ? t : x)))
      lastUpd.current = t.updated_at
    } catch (e: any) { setError(e.message) }
  }

  async function submit() {
    if (!sel) return
    const a: Record<string, string> = {}
    for (const q of sel.questions) {
      let v = answers[q.id] || q.answer || ''
      if (v.startsWith(OTHER_MARKER)) v = v.slice(OTHER_MARKER.length)
      if (v) a[String(q.id)] = v
    }
    if (!Object.keys(a).length) { setError('Answer at least one question'); return }
    setBusy(true)
    try {
      const d: any = await fetchJSON(`/api/tickets/${sel.id}/answer`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answers: a }),
      })
      if (d.clarified) {
        setSel(d.ticket); setTickets(p => p.map(x => (x.id === sel.id ? d.ticket : x)))
        lastUpd.current = d.ticket.updated_at
        setAnswers({}); impl(sel.id)
      } else {
        setSel(d); setTickets(p => p.map(x => (x.id === sel.id ? d : x)))
        lastUpd.current = d.updated_at
        setAnswers({})
      }
    } catch (e: any) { setError(e.message) } finally { setBusy(false) }
  }

  async function impl(id: string) {
    try {
      const d: any = await fetchJSON(`/api/tickets/${id}/implement`, { method: 'POST' })
      if (d.ticket) {
        setSel(d.ticket); setTickets(p => p.map(x => (x.id === id ? d.ticket : x)))
        lastUpd.current = d.ticket.updated_at
      } else if (d.error) {
        setError(d.error + (d.note ? ' — ' + d.note : ''))
      }
    } catch (e: any) { setError(e.message) }
  }

  async function sendFeedback() {
    if (!sel || !feedback.trim()) return
    setBusy(true)
    try {
      const d: any = await fetchJSON(`/api/tickets/${sel.id}/feedback`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ feedback }),
      })
      setFeedback(''); setSel(d.ticket); setTickets(p => p.map(x => (x.id === sel.id ? d.ticket : x)))
      lastUpd.current = d.ticket.updated_at
      await clarify(sel.id)
      const u: T = await fetchJSON(`/api/tickets/${sel.id}`)
      setSel(u); setTickets(p => p.map(x => (x.id === sel.id ? u : x)))
      lastUpd.current = u.updated_at
    } catch (e: any) { setError(e.message) } finally { setBusy(false) }
  }

  async function ready(id: string) {
    const action = cfg.mergeStrategy === 'pr' ? 'open a PR' : `cherry-pick into ${cfg.branchDefault || 'main'}`
    if (!confirm(`Commit, ${action}, and close?`)) return
    setBusy(true)
    try {
      const d: any = await fetchJSON(`/api/tickets/${id}/ready`, { method: 'POST' })
      setSel(d.ticket); setTickets(p => p.map(x => (x.id === id ? d.ticket : x)))
      lastUpd.current = d.ticket.updated_at
    } catch (e: any) { setError(e.message) } finally { setBusy(false) }
  }

  async function closeTicket(id: string) {
    if (!confirm('Close this ticket? Any running work is stopped and its worktree is released. This cannot be undone.')) return
    setBusy(true)
    try {
      const d: any = await fetchJSON(`/api/tickets/${id}/close`, { method: 'POST' })
      setSel(d.ticket); setTickets(p => p.map(x => (x.id === id ? d.ticket : x)))
      lastUpd.current = d.ticket.updated_at
    } catch (e: any) { setError(e.message) } finally { setBusy(false) }
  }

  async function rebaseTicket(id: string) {
    setRebaseLoading(true)
    try {
      const d: any = await fetchJSON(`/api/tickets/${id}/rebase`, { method: 'POST' })
      if (d.ticket) {
        setSel(d.ticket); setTickets(p => p.map(x => (x.id === id ? d.ticket : x)))
        lastUpd.current = d.ticket.updated_at
      }
      if (!d.success && d.error) {
        setError(d.ticket?.stage === 'clarification'
          ? 'Rebase conflicts could not be resolved — ticket moved to clarification'
          : d.error)
      }
    } catch (e: any) { setError(e.message) } finally { setRebaseLoading(false) }
  }

  async function viewDiff(id: string) {
    try {
      const d = await fetchJSON<{ diff: string; files?: string[]; explorer_prefix?: string | null; commitSha?: string }>(`/api/tickets/${id}/diff`)
      setDiff(d.diff || '(no changes)')
      setDiffFiles((d.files || []).map(p => ({ path: p, explorer_prefix: d.explorer_prefix || null })))
      setDiffCommitSha(d.commitSha || '')
    } catch (e: any) {
      setDiff(e?.message || 'Failed to load diff')
      setDiffFiles([])
    }
  }

  async function rerunTests(id: string) {
    setTestReRunning(true)
    try {
      await fetchJSON(`/api/tickets/${id}/tests/run`, { method: 'POST' })
      // The SSE test_status event will deliver the final result; we don't
      // need to poll here.  Mark in-flight in the ticket state so the
      // pill flips to "running" immediately.
      setSel(p => p && p.id === id
        ? { ...p, latest_test: { id: 0, ticket_id: id, status: 'running', framework: p.latest_test?.framework ?? null, command: null, exit_code: null, summary: null, output: '', duration_ms: null, triggered_by: 'manual', started_at: new Date().toISOString(), finished_at: null } }
        : p)
    } catch (e: any) {
      setError('Re-run failed: ' + e.message)
    } finally {
      setTestReRunning(false)
    }
  }

  async function runTest() {
    setOut({ open: true, title: 'Test Results', text: 'Running…', status: 'running' })
    try {
      const { runId } = await fetchJSON<{ runId: string }>('/api/test', { method: 'POST' })
      const poll = () => fetchJSON<{ output: string; status: string }>(`/api/run/${runId}`).then(d => {
        setOut({ open: true, title: 'Test Results', text: d.output || '', status: d.status })
        if (d.status === 'running') setTimeout(poll, 500)
      })
      poll()
    } catch (e: any) {
      setOut({ open: true, title: 'Test Results', text: 'Error: ' + e.message, status: 'fail' })
    }
  }
  async function runPrepush() {
    setOut({ open: true, title: 'Pre-push Check', text: 'Running…', status: 'running' })
    try {
      const { runId } = await fetchJSON<{ runId: string }>('/api/prepush', { method: 'POST' })
      const poll = () => fetchJSON<{ output: string; status: string }>(`/api/run/${runId}`).then(d => {
        setOut({ open: true, title: 'Pre-push Check', text: d.output || '', status: d.status })
        if (d.status === 'running') setTimeout(poll, 500)
      })
      poll()
    } catch (e: any) {
      setOut({ open: true, title: 'Pre-push Check', text: 'Error: ' + e.message, status: 'fail' })
    }
  }
  async function restartServer() {
    setOut({ open: true, title: 'Restart Server', text: 'Restarting…', status: 'running' })
    try {
      const { ok } = await fetchJSON<{ ok: boolean }>('/api/restart', { method: 'POST' })
      if (ok) setOut({ open: true, title: 'Restart Server', text: 'Server restarted successfully.\n\nThe page will reconnect automatically.', status: 'pass' })
    } catch (e: any) {
      setOut({ open: true, title: 'Restart Server', text: 'Error: ' + e.message, status: 'fail' })
    }
  }

  function copyUrl(id: string) {
    const url = location.origin + location.pathname + '#ticket/' + id
    const done = () => { setCopied(true); setTimeout(() => setCopied(false), 1200) }
    if (navigator.clipboard) {
      navigator.clipboard.writeText(url).then(done).catch(() => {
        // Fallback for non-HTTPS
        const ta = document.createElement('textarea')
        ta.value = url; ta.style.position = 'fixed'; ta.style.opacity = '0'
        document.body.appendChild(ta); ta.select()
        document.execCommand('copy'); document.body.removeChild(ta)
        done()
      })
    } else {
      const ta = document.createElement('textarea')
      ta.value = url; ta.style.position = 'fixed'; ta.style.opacity = '0'
      document.body.appendChild(ta); ta.select()
      document.execCommand('copy'); document.body.removeChild(ta)
      done()
    }
  }

  /* Group tickets by stage once */
  const byStage = useMemo(() => {
    const m: Record<Stage, T[]> = { clarification: [], implementation: [], review: [], pr_opened: [], done: [] }
    for (const t of tickets) {
      if (t.stage in m) (m as any)[t.stage].push(t)
    }
    return m
  }, [tickets])

  /* Filtered activity for the sidebar (drop noise) */
  const visibleActivity = useMemo(() => {
    if (!sel) return []
    return (sel.activity || []).filter(a => a.action !== 'resource' && a.action !== 'file_changed' && a.action !== 'rebase_coder_progress')
  }, [sel])

  return (
    <div className="min-h-screen bg-bg text-ink-1">
      {/* ── Header ── */}
      <header className="sticky top-0 z-30 bg-surface/85 backdrop-blur border-b border-border">
        <div className="max-w-[1440px] mx-auto px-4 sm:px-6 h-12 flex items-center justify-between gap-3">
          <div className="flex items-baseline gap-2 min-w-0">
            <h1 className="t-h-page text-ink-1 shrink-0">{cfg.projectName}</h1>
            <span className="t-small text-ink-2 hidden sm:inline truncate">Project tickets</span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {cfg.testEnabled && (
              <Btn variant="outline" size="sm" onClick={runTest} aria-label="Run Tests">
                <Play className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Run Tests</span>
              </Btn>
            )}
            <Btn variant="outline" size="sm" onClick={runPrepush} aria-label="Pre-push check">
              <Shield className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Pre-push</span>
            </Btn>
            <Btn variant="outline" size="sm" onClick={restartServer} aria-label="Restart server">
              <RefreshCw className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Restart</span>
            </Btn>
            <button onClick={cycleTheme} className="h-7 w-7 inline-flex items-center justify-center rounded-md text-ink-2 hover:text-ink-1 hover:bg-surface-3 transition-colors" aria-label={`Theme: ${theme}`}>
              {theme === 'dark' ? <Moon className="h-3.5 w-3.5" /> : theme === 'light' ? <Sun className="h-3.5 w-3.5" /> : <Monitor className="h-3.5 w-3.5" />}
            </button>
          </div>
        </div>
      </header>

      {/* ── Main ── */}
      <main className="max-w-[1440px] mx-auto px-4 sm:px-6 py-4 sm:py-5">
        {/* Inline new-ticket form */}
        <div className="bg-surface rounded-lg ring-1 ring-border p-3 mb-5 sm:mb-6">
          <div className="flex flex-col sm:flex-row gap-2.5 sm:items-center">
            <input
              value={title}
              onChange={e => { setTitle(e.target.value); setError('') }}
              name="ticket-title"
              placeholder="Ticket title…"
              className="w-full sm:w-[280px] h-10 sm:h-8 px-3 rounded-md ring-1 ring-border focus:ring-2 focus:ring-zinc-900/20 t-body text-ink-1 placeholder:text-ink-3 bg-surface"
            />
            <input
              value={content}
              onChange={e => setContent(e.target.value)}
              name="ticket-content"
              placeholder="Description (optional)"
              className="w-full sm:flex-1 h-10 sm:h-8 px-3 rounded-md ring-1 ring-border focus:ring-2 focus:ring-zinc-900/20 t-body text-ink-1 placeholder:text-ink-3 bg-surface"
            />
            <Btn onClick={create} disabled={creating} size="md" className="w-full sm:w-auto">
              {creating && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Create Ticket
            </Btn>
          </div>
          {error && !sel && (
            <p className="t-small text-red-600 mt-2 px-1">{error}</p>
          )}
        </div>

        {/* ── Machine checks ── */}
        {machineChecksLoading && (
          <div className="mb-5 sm:mb-6 flex items-center gap-2 text-ink-3 t-small">
            <Loader2 className="h-4 w-4 animate-spin" />
            Running machine checks…
          </div>
        )}
        {!machineChecksLoading && machineChecks.filter(c => c.status !== 'ok').length > 0 && (
          <div className="mb-5 sm:mb-6 space-y-2">
            {machineChecks.filter(c => c.status !== 'ok').map(c => (
              <div key={c.name} className="bg-surface rounded-lg ring-1 ring-border px-3.5 py-2.5 flex items-start gap-3">
                <StatusPill kind={c.status === 'fail' ? 'danger' : 'info'}>{c.status === 'fail' ? 'FAIL' : 'WARN'}</StatusPill>
                <div className="flex-1 min-w-0">
                  <p className="t-body font-medium text-ink-1">{c.name}</p>
                  <p className="t-small text-ink-2 mt-0.5">{c.detail}</p>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* ── Suggested tickets ── */}
        {suggestions.length > 0 && (
          <div className="mb-5 sm:mb-6">
            <p className="t-meta font-semibold text-ink-3 uppercase tracking-wider mb-2">Suggested</p>
            <div className="space-y-2">
              {suggestions.map(sug => (
                <SuggestionCard key={sug.id} sug={sug} onAccept={acceptSuggestion} onDismiss={dismissSuggestion} />
              ))}
            </div>
          </div>
        )}
        {suggestionsFailed && suggestions.length === 0 && (
          <div className="mb-5 sm:mb-6">
            <button onClick={loadSuggestions} className="t-small text-ink-3 hover:text-accent underline cursor-pointer">
              Failed to load suggestions — tap to retry
            </button>
          </div>
        )}
        {suggestionsLoading && suggestions.length === 0 && (
          <div className="mb-5 sm:mb-6 flex items-center gap-2 text-ink-3 t-small">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading suggestions…
          </div>
        )}

        {/* ── Board: active stages ── */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3 sm:gap-5">
          {STAGES.filter(s => s !== 'done').map(stage => {
            const items = byStage[stage]
            const meta = STAGE_META[stage]
            return (
              <section key={stage} className="min-w-0">
                <header className="flex items-center justify-between mb-2.5 px-1">
                  <div className="flex items-center gap-2">
                    <span className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} />
                    <h3 className="t-meta font-semibold text-ink-2 uppercase tracking-wider">
                      {meta.label}
                    </h3>
                  </div>
                  <span className="t-meta text-ink-3 bg-surface-3 px-1.5 py-0.5 rounded">
                    {items.length}
                  </span>
                </header>
                <div className="flex flex-col gap-2.5">
                  {items.length === 0 && (
                    <div className="rounded-lg border border-dashed border-border py-8 text-center t-small text-ink-3">
                      No tickets
                    </div>
                  )}
                  {items.map(t => <TicketCard key={t.id} t={t} onOpen={open} loading={loadingId === t.id} highlighted={highlightedIds.has(t.id)} />)}
                </div>
              </section>
            )
          })}
        </div>

        {/* ── Board: done row ── */}
        {(() => {
          const items = byStage.done
          const meta = STAGE_META.done
          return (
            <section className="mt-3 sm:mt-5">
              <header className="flex items-center justify-between mb-2.5 px-1">
                <div className="flex items-center gap-2">
                  <span className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} />
                  <h3 className="t-meta font-semibold text-ink-2 uppercase tracking-wider">
                    {meta.label}
                  </h3>
                </div>
                <span className="t-meta text-ink-3 bg-surface-3 px-1.5 py-0.5 rounded">
                  {items.length}
                </span>
              </header>
              {items.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border py-8 text-center t-small text-ink-3">
                  No tickets
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3 sm:gap-5">
                  {items.map(t => <TicketCard key={t.id} t={t} onOpen={open} loading={loadingId === t.id} highlighted={highlightedIds.has(t.id)} />)}
                </div>
              )}
            </section>
          )
        })()}
      </main>

      {/* ── Ticket popup ── */}
      {loadingId && !sel && (
        <Dialog onClose={close}>
          <div className="flex items-center justify-center gap-2 p-8 text-ink-3 t-body">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading ticket…
          </div>
        </Dialog>
      )}
      {sel && (
        <Dialog onClose={close}>
          <DialogHeader>
            <div className="min-w-0 flex-1 pr-2 sm:pr-4">
              <div className="flex items-center gap-2 sm:gap-2.5 t-meta text-ink-2 flex-wrap">
                <span className="t-mono-11 truncate max-w-[140px] sm:max-w-none">{sel.id}</span>
                <span className="text-ink-3">·</span>
                <StagePill stage={sel.stage} />
                {sel.status === 'running' && (
                  <span className="inline-flex items-center gap-1 text-amber-600">
                    <Loader2 className="h-3 w-3 animate-spin" /> running
                  </span>
                )}
                {/* Compact test status indicator next to stage pill.
                    Visible whenever there's a test result (any non-running
                    stage with a worktree, plus done).  Click scrolls to
                    the test panel below — anchor via id. */}
                {sel.latest_test && (sel.stage === 'review' || sel.stage === 'done') && (
                  <a
                    href="#tests-panel"
                    onClick={e => {
                      e.preventDefault()
                      document.getElementById('tests-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                    }}
                    className="inline-flex items-center"
                    title={sel.latest_test.summary || sel.latest_test.status}
                  >
                    {sel.latest_test.status === 'pass' && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200 px-1.5 py-0.5 t-meta font-medium">
                        <Check className="h-3 w-3" /> tests
                      </span>
                    )}
                    {sel.latest_test.status === 'fail' && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-red-50 text-red-700 ring-1 ring-red-200 px-1.5 py-0.5 t-meta font-medium">
                        <X className="h-3 w-3" /> tests
                      </span>
                    )}
                    {sel.latest_test.status === 'error' && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-red-50 text-red-700 ring-1 ring-red-200 px-1.5 py-0.5 t-meta font-medium">
                        <X className="h-3 w-3" /> tests error
                      </span>
                    )}
                    {sel.latest_test.status === 'skip' && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-surface-3 text-ink-2 ring-1 ring-border px-1.5 py-0.5 t-meta font-medium">
                        tests skipped
                      </span>
                    )}
                    {sel.latest_test.status === 'running' && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-blue-50 text-blue-700 ring-1 ring-blue-200 px-1.5 py-0.5 t-meta font-medium">
                        <Loader2 className="h-3 w-3 animate-spin" /> testing…
                      </span>
                    )}
                  </a>
                )}
              </div>
              <h2 className="t-h text-ink-1 mt-1.5 clamp-2">{sel.title}</h2>
              <div className="mt-2 flex items-center gap-x-3 gap-y-1 t-meta text-ink-2 flex-wrap">
                <span>Created {timeAgo(sel.created_at)}</span>
                <span className="text-ink-3 hidden sm:inline">·</span>
                <span>Updated {timeAgo(sel.updated_at)}</span>
                <button
                  onClick={() => copyUrl(sel.id)}
                  className="inline-flex items-center gap-1 hover:text-ink-1 active:text-ink-2 transition-colors"
                >
                  {copied ? <Check className="h-3 w-3" /> : <LinkIcon className="h-3 w-3" />}
                  {copied ? 'Copied' : 'Copy link'}
                </button>
              </div>
            </div>
            <IconBtn label="Close" onClick={close}>
              <X className="h-4 w-4" />
            </IconBtn>
          </DialogHeader>

          {/* Body — single scroll context, no nested scrollbars */}
          <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain">
            <div className="px-4 sm:px-6 py-4 sm:py-5 flex flex-col lg:flex-row gap-4 lg:gap-6">
              {/* Main column */}
              <div className="flex-1 min-w-0 space-y-5">
                {sel.content && (
                  <Section title="Description">
                    <p className="t-body text-ink-2 leading-relaxed whitespace-pre-wrap">
                      {sel.content}
                    </p>
                  </Section>
                )}

                {sel.review_feedback && (
                  <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
                    <p className="t-meta font-semibold text-amber-700 uppercase tracking-wider mb-1">
                      {sel.review_feedback.match(/^PR #\d+/) ? 'PR Status' : 'Review feedback'}
                    </p>
                    <p className="t-body text-amber-900 leading-relaxed whitespace-pre-wrap">
                      {sel.review_feedback}
                    </p>
                  </div>
                )}

                {/* Generic worktree info — shown for any stage with an active worktree */}
                {sel.worktree_path && (
                  <Section title="Worktree">
                    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 t-mono-12">
                      <dt className="t-meta text-ink-2 uppercase tracking-wider self-center">Path</dt>
                      <dd className="text-ink-1 break-all">{sel.worktree_path}</dd>
                      <dt className="t-meta text-ink-2 uppercase tracking-wider self-center">Branch</dt>
                      <dd className="text-ink-1 break-all">{sel.branch_name || '—'}</dd>
                    </dl>
                    {sel.behind_count !== null && sel.behind_count !== undefined && (
                      <div className="mt-2">
                        {sel.behind_count === 0 ? (
                          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200 px-2 py-0.5 t-meta font-medium">
                            Up to date with {cfg.branchDefault || 'main'}
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 text-amber-700 ring-1 ring-amber-200 px-2 py-0.5 t-meta font-medium">
                            {sel.behind_count} commit{sel.behind_count === 1 ? '' : 's'} behind {cfg.branchDefault || 'main'}
                          </span>
                        )}
                      </div>
                    )}
                    <div className="mt-3 flex gap-2 flex-wrap">
                      <a
                        href={`vscode://vscode-remote/ssh-remote+${cfg.remoteHost}${sel.worktree_path}`}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md ring-1 ring-border hover:bg-bg t-small text-ink-2"
                      >
                        <ExternalLink className="h-3.5 w-3.5" /> Open in VSCode
                      </a>
                      <a
                        href={`cursor://ssh-remote+${cfg.remoteHost}${sel.worktree_path}`}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md ring-1 ring-border hover:bg-bg t-small text-ink-2"
                      >
                        <ExternalLink className="h-3.5 w-3.5" /> Open in Cursor
                      </a>
                      <Btn variant="outline" size="sm" onClick={() => viewDiff(sel.id)}>
                        View Diff
                      </Btn>
                    </div>
                  </Section>
                )}

                {/* Clarification — running (generating questions / processing answers) */}
                {sel.stage === 'clarification' && sel.status === 'running' && (
                  <Section title="Live status">
                    <div className="flex items-center gap-2 t-body text-ink-2 mb-3">
                      <Loader2 className="h-4 w-4 animate-spin text-amber-500" />
                      {sel.questions.length > 0 ? 'Processing answers…' : 'Generating questions…'}
                    </div>
                    <ResourceMetrics activity={sel.activity || []} stageResources={sel.stage_resources} status={sel.status} />
                    {stdoutLines.length > 0 && (
                      <div className="mt-3 rounded-md ring-1 ring-border bg-zinc-950 text-ink-3 p-3 max-h-64 overflow-y-auto t-mono-12 leading-relaxed whitespace-pre-wrap break-words">
                        {stdoutLines.join('')}
                      </div>
                    )}
                  </Section>
                )}

                {/* Clarification — Q&A rounds */}
                {sel.stage === 'clarification' && sel.questions.length > 0 && (
                  <Section title="Questions" hint={`${sel.questions.length} · round ${Math.max(...sel.questions.map(q => q.round))}`}>
                    <div className="space-y-5">
                      {[...new Set(sel.questions.map(q => q.round))].map(round => (
                        <div key={round}>
                          <p className="t-meta font-semibold text-ink-2 uppercase tracking-wider mb-2">
                            Round {round}
                          </p>
                          <div className="space-y-2">
                            {sel.questions.filter(q => q.round === round).map((q, i) => (
                              <QuestionCard
                                key={q.id}
                                q={q}
                                index={i + 1}
                                answer={answers[q.id] || ''}
                                onAnswer={v => setAnswers(s => ({ ...s, [q.id]: v }))}
                                disabled={busy}
                              />
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                    {error && <p className="t-small text-red-600 mt-2">{error}</p>}
                  </Section>
                )}

                {/* Implementation — plan + live status */}
                {sel.stage === 'implementation' && (
                  <>
                    {sel.plan && (
                      <Section
                        title="Implementation Plan"
                        hint={
                          sel.estimated_complexity
                            ? `complexity: ${sel.estimated_complexity}`
                            : undefined
                        }
                      >
                        <pre className="rounded-md bg-zinc-900 text-zinc-100 p-3.5 t-mono-12 leading-relaxed whitespace-pre-wrap break-words max-h-72 overflow-y-auto">
{sel.plan}
                        </pre>
                        {sel.plan_notes && (
                          <p className="t-small text-ink-3 mt-2 italic">{sel.plan_notes}</p>
                        )}
                      </Section>
                    )}
                    {sel.status === 'running' ? (
                      <Section title="Live status">
                        <div className="flex items-center gap-2 t-body text-ink-2">
                          <Loader2 className="h-4 w-4 animate-spin text-amber-500" />
                          Implementing…
                        </div>
                        <div className="mt-3 rounded-lg ring-1 ring-border p-3">
                          <ResourceMetrics activity={sel.activity || []} stageResources={sel.stage_resources} status={sel.status} />
                        </div>
                        {stdoutLines.length > 0 && (
                          <div className="mt-3 rounded-md ring-1 ring-border bg-zinc-950 text-ink-3 p-3 max-h-64 overflow-y-auto t-mono-12 leading-relaxed whitespace-pre-wrap break-words">
                            {stdoutLines.join('')}
                          </div>
                        )}
                        {todoItems.length > 0 && (
                          <div className="mt-3">
                            <p className="t-meta font-medium text-ink-2 uppercase tracking-wider mb-1.5">
                              Progress
                            </p>
                            <div className="rounded-md ring-1 ring-border divide-y divide-zinc-100">
                              {todoItems.map((item, i) => (
                                <div key={i} className={`flex items-center gap-2 px-3 py-1.5 t-body ${item.done ? 'text-ink-3 line-through' : 'text-ink-2'}`}>
                                  <span className={`shrink-0 h-3.5 w-3.5 rounded border-2 flex items-center justify-center ${item.done ? 'border-emerald-400 bg-emerald-50' : 'border-zinc-300'}`}>
                                    {item.done && <span className="h-1.5 w-1.5 rounded-sm bg-emerald-500" />}
                                  </span>
                                  {item.text}
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                        {(() => {
                          const f = (sel.activity || []).filter(a => a.action === 'file_changed')
                          if (!f.length) return null
                          return (
                            <div className="mt-3">
                              <p className="t-meta font-medium text-ink-2 uppercase tracking-wider mb-1.5">
                                Files modified · {f.length}
                              </p>
                              <div className="rounded-md ring-1 ring-border divide-y divide-zinc-100">
                                {f.slice(0, FILES_MODIFIED_MAX_VISIBLE).map((a, i) => (
                                  <p key={i} className="t-mono-12 text-ink-2 px-3 py-1.5">
                                    {a.detail}
                                  </p>
                                ))}
                              </div>
                            </div>
                          )
                        })()}
                      </Section>
                    ) : (
                      <div className="rounded-lg border border-dashed border-border p-6 text-center">
                        <p className="t-body text-ink-2">Ready to implement.</p>
                      </div>
                    )}
                  </>
                )}

                {/* Review */}
                {sel.stage === 'review' && (
                  <>
                    {sel.status === 'running' && (
                      <Section title="Live status">
                        <div className="flex items-center gap-2 t-body text-ink-2 mb-3">
                          <Loader2 className="h-4 w-4 animate-spin text-amber-500" />
                          {['pushing', 'branch_pushed'].includes((sel.activity || [])[0]?.action ?? '')
                            ? 'Pushing branch and opening PR…'
                            : 'Resolving rebase conflicts…'}
                        </div>
                        <div className="mt-3 rounded-lg ring-1 ring-border p-3">
                          <ResourceMetrics activity={sel.activity || []} stageResources={sel.stage_resources} status={sel.status} />
                        </div>
                        {stdoutLines.length > 0 && (
                          <div className="mt-3 rounded-md ring-1 ring-border bg-zinc-950 text-ink-3 p-3 max-h-64 overflow-y-auto t-mono-12 leading-relaxed whitespace-pre-wrap break-words">
                            {stdoutLines.join('')}
                          </div>
                        )}
                      </Section>
                    )}
                    {diff && (
                      <Section
                        title="Diff"
                        hint={
                          diffFiles.length > 0
                            ? `${diffFiles.length} file${diffFiles.length === 1 ? '' : 's'} · click to open in Explorer`
                            : undefined
                        }
                      >
                        {diffFiles.length > 0 && (() => {
                          const explorerPrefix = diffFiles[0]?.explorer_prefix
                          function explorerUrl(path: string) {
                            return cfg.explorer.url
                              .replace(/\{protocol\}/g, window.location.protocol)
                              .replace(/\{host\}/g, window.location.hostname)
                              .replace(/\{sha\}/g, diffCommitSha)
                              .replace(/\{path\}/g, encodeURI(path))
                              .replace(/\{prefix\}/g, encodeURI(explorerPrefix || ''))
                              .replace(/\{owner\}/g, encodeURI(cfg.explorer.owner))
                              .replace(/\{repo\}/g, encodeURI(cfg.explorer.repo))
                          }
                          return (
                            <div className="mb-3 rounded-md ring-1 ring-border divide-y divide-zinc-100 overflow-hidden">
                              {explorerPrefix && (
                                <a
                                  href={explorerUrl('')}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="flex items-center gap-2 px-3 py-1.5 t-small text-ink-2 hover:bg-bg"
                                >
                                  <ExternalLink className="h-3.5 w-3.5 text-ink-3" />
                                  Open worktree root in Explorer ↗
                                </a>
                              )}
                              {diffFiles.map(f => (
                                <a
                                  key={f.path}
                                  href={explorerUrl(f.path)}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="flex items-center gap-2 px-3 py-1.5 t-mono-12 text-ink-2 hover:bg-bg group"
                                  title={`Open ${f.path} in Explorer`}
                                >
                                  <ExternalLink className="h-3.5 w-3.5 text-ink-3 group-hover:text-ink-2 shrink-0" />
                                  <span className="truncate">{f.path}</span>
                                </a>
                              ))}
                            </div>
                          )
                        })()}
                        <pre className="rounded-md bg-zinc-900 text-zinc-100 p-3.5 t-mono-12 leading-relaxed whitespace-pre-wrap break-words max-h-80 overflow-y-auto">
{diff}
                        </pre>
                      </Section>
                    )}
                    {sel.worktree_path && (
                      <Section
                        title="Unit tests"
                        hint={sel.latest_test?.status === 'pass' ? 'passed' :
                              sel.latest_test?.status === 'fail' ? 'failed' :
                              sel.latest_test?.status === 'running' ? 'running…' :
                              sel.latest_test?.status === 'skip' ? 'skipped' : undefined}
                      >
                        <div id="tests-panel">
                        <TestReportPanel
                          test={sel.latest_test}
                          onRerun={() => rerunTests(sel.id)}
                          rerunning={testReRunning}
                        />
                        </div>
                      </Section>
                    )}
                    {sel.worktree_path && (
                      <Section title="Resource usage">
                        <div className="rounded-md ring-1 ring-border p-3">
                          <ResourceMetrics activity={sel.activity || []} stageResources={sel.stage_resources} status={sel.status} />
                        </div>
                      </Section>
                    )}
                  </>
                )}

                {(sel.stage === 'review' || sel.stage === 'pr_opened') && (
                  <Section title="Feedback (optional)">
                    <textarea
                      value={feedback}
                      onChange={e => setFeedback(e.target.value)}
                      name="fb"
                      placeholder="Send back to clarification with new questions…"
                      rows={3}
                      className="w-full rounded-md ring-1 ring-border focus:ring-2 focus:ring-zinc-900/20 px-3 py-2 t-body text-ink-1 placeholder:text-ink-3 resize-none"
                    />
                    {error && <p className="t-small text-red-600 mt-1.5">{error}</p>}
                  </Section>
                )}

                {/* Done / PR Opened */}
                {(sel.stage === 'done' || sel.stage === 'pr_opened') && (
                  <>
                    {cfg.mergeStrategy === 'pr' && resolvePrUrl(sel) ? (
                      <div className={`rounded-lg border p-3.5 flex items-start gap-2.5 ${
                        sel.pr_state === 'merged' ? 'border-violet-200 bg-violet-50' :
                        sel.pr_state === 'closed' ? 'border-red-200 bg-red-50' :
                        'border-emerald-200 bg-emerald-50'
                      }`}>
                        <GitPullRequest className={`h-4 w-4 mt-0.5 shrink-0 ${
                          sel.pr_state === 'merged' ? 'text-violet-600' :
                          sel.pr_state === 'closed' ? 'text-red-600' :
                          'text-emerald-600'
                        }`} />
                        <div className={`t-body ${
                          sel.pr_state === 'merged' ? 'text-violet-900' :
                          sel.pr_state === 'closed' ? 'text-red-900' :
                          'text-emerald-900'
                        }`}>
                          {sel.pr_state === 'merged' ? 'PR merged' : sel.pr_state === 'closed' ? 'PR closed' : 'PR opened'}
                          {' · '}
                          <a
                            href={resolvePrUrl(sel)!}
                            target="_blank"
                            rel="noreferrer"
                            className={`font-medium underline underline-offset-2 inline-flex items-center gap-1 ${
                              sel.pr_state === 'merged' ? 'text-violet-700 hover:text-violet-600' :
                              sel.pr_state === 'closed' ? 'text-red-700 hover:text-red-600' :
                              'text-emerald-700 hover:text-emerald-600'
                            }`}
                          >
                            {prNumberFromUrl(resolvePrUrl(sel)) != null
                              ? `#${prNumberFromUrl(resolvePrUrl(sel))}`
                              : 'View PR'}
                            <ExternalLink className="h-3 w-3" />
                          </a>
                          {' · Commit '}
                          <code className={`t-mono-12 ${
                            sel.pr_state === 'merged' ? 'text-violet-800' :
                            sel.pr_state === 'closed' ? 'text-red-800' :
                            'text-emerald-800'
                          }`}>{sel.commit_sha}</code>
                        </div>
                      </div>
                    ) : sel.commit_sha ? (
                      <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3.5 flex items-start gap-2.5">
                        <Check className="h-4 w-4 text-emerald-600 mt-0.5 shrink-0" />
                        <div className="t-body text-emerald-900">
                          Merged into main · Commit{' '}
                          <code className="t-mono-12 text-emerald-800">{sel.commit_sha}</code>
                        </div>
                      </div>
                    ) : null}
                    {sel.plan && (
                      <Section
                        title="Implementation Plan"
                        hint={
                          sel.estimated_complexity
                            ? `complexity: ${sel.estimated_complexity}`
                            : undefined
                        }
                      >
                        <pre className="rounded-md bg-zinc-900 text-zinc-100 p-3.5 t-mono-12 leading-relaxed whitespace-pre-wrap break-words max-h-72 overflow-y-auto">
{sel.plan}
                        </pre>
                        {sel.plan_notes && (
                          <p className="t-small text-ink-3 mt-2 italic">{sel.plan_notes}</p>
                        )}
                      </Section>
                    )}
                    {sel.latest_test && (
                      <Section
                        title="Unit tests"
                        hint={sel.latest_test.status === 'pass' ? 'passed' :
                              sel.latest_test.status === 'fail' ? 'failed' :
                              sel.latest_test.status === 'skip' ? 'skipped' : undefined}
                      >
                        <TestReportPanel
                          test={sel.latest_test}
                          onRerun={() => rerunTests(sel.id)}
                          rerunning={testReRunning}
                          autoExpandFail={false}
                        />
                      </Section>
                    )}
                    <Section title="Resource usage">
                      <div className="rounded-md ring-1 ring-border p-3">
                        <ResourceMetrics activity={sel.activity || []} stageResources={sel.stage_resources} status={sel.status} />
                      </div>
                    </Section>
                    {sel.questions.length > 0 && (
                      <Section title="Q&A history">
                        <div className="space-y-3">
                          {sel.questions.map((q, i) => (
                            <div key={q.id} className="t-body">
                              <p className="text-ink-1 leading-relaxed">
                                <span className="t-mono-11 text-ink-3 mr-2">Q{i + 1}</span>
                                {q.question}
                              </p>
                              {q.answer && (
                                <p className="text-ink-2 leading-relaxed mt-0.5 pl-5">
                                  <span className="t-mono-11 text-ink-3 mr-2">A{i + 1}</span>
                                  {q.answer}
                                </p>
                              )}
                            </div>
                          ))}
                        </div>
                      </Section>
                    )}
                  </>
                )}

                {(sel.stage === 'done' || sel.stage === 'pr_opened') && cfg.mergeStrategy === 'pr' && resolvePrUrl(sel) && (
                  <div className={`rounded-lg border p-3.5 flex items-start gap-2.5 ${
                    sel.pr_state === 'merged' ? 'border-violet-200 bg-violet-50' :
                    sel.pr_state === 'closed' ? 'border-red-200 bg-red-50' :
                    'border-border bg-surface-3'
                  }`}>
                    <GitPullRequest className={`h-4 w-4 mt-0.5 shrink-0 ${
                      sel.pr_state === 'merged' ? 'text-violet-600' :
                      sel.pr_state === 'closed' ? 'text-red-600' :
                      'text-ink-3'
                    }`} />
                    <div className={`t-body ${
                      sel.pr_state === 'merged' ? 'text-violet-900' :
                      sel.pr_state === 'closed' ? 'text-red-900' :
                      'text-ink-2'
                    }`}>
                      {sel.pr_state === 'merged' ? 'PR merged' : sel.pr_state === 'closed' ? 'PR closed' : 'PR'}{' · '}
                      <a
                        href={resolvePrUrl(sel)!}
                        target="_blank"
                        rel="noreferrer"
                        className="font-medium underline underline-offset-2 inline-flex items-center gap-1"
                      >
                        {prNumberFromUrl(resolvePrUrl(sel)) != null
                          ? `#${prNumberFromUrl(resolvePrUrl(sel))}`
                          : 'View PR'}
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    </div>
                  </div>
                )}

                {/* PR tasks touched checks */}
                {sel.stage === 'pr_opened' && sel.pr_touched_checks && sel.pr_touched_checks.length > 0 && (
                  <Section title="PR tasks — actions taken">
                    <div className="space-y-2">
                      {sel.pr_touched_checks.map((tc, i) => (
                        <div key={i} className="rounded-md ring-1 ring-border p-2.5">
                          <p className="t-meta font-semibold text-ink-2 uppercase tracking-wider mb-0.5">{tc.name}</p>
                          <p className="t-small text-ink-2"><span className="font-medium">Action:</span> {tc.action}</p>
                          <p className="t-small text-ink-3"><span className="font-medium">Result:</span> {tc.result}</p>
                        </div>
                      ))}
                    </div>
                  </Section>
                )}

                {/* PR tasks console output */}
                {sel.stage === 'pr_opened' && stdoutLines.length > 0 && (
                  <div className="mt-3 rounded-md ring-1 ring-border bg-zinc-950 text-ink-3 p-3 max-h-64 overflow-y-auto t-mono-12 leading-relaxed whitespace-pre-wrap break-words">
                    {stdoutLines.join('')}
                  </div>
                )}

              </div>

              {/* Activity sidebar — same scroll, no nested scrollbar */}
              <ActivitySidebar items={visibleActivity} />
            </div>
          </div>

          {/* Footer */}
          <DialogFooter>
            {sel.stage !== 'done' && (
              <Btn variant="danger" onClick={() => closeTicket(sel.id)} disabled={busy}>
                <Ban className="h-3.5 w-3.5" /> Close ticket
              </Btn>
            )}
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 w-full sm:w-auto sm:ml-auto">
            {sel.stage === 'clarification' && (
              <>
                {sel.worktree_path && sel.status !== 'running' && (
                  <Btn variant="outline" onClick={() => rebaseTicket(sel.id)} disabled={rebaseLoading}>
                    {rebaseLoading
                      ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      : <GitBranch className="h-3.5 w-3.5" />}
                    {rebaseLoading ? 'Rebasing…' : 'Rebase'}
                  </Btn>
                )}
                {sel.questions.length === 0 && (
                  <Btn variant="outline" onClick={() => clarify(sel.id)}>
                    <RefreshCw className="h-3.5 w-3.5" /> Retry
                  </Btn>
                )}
                {sel.questions.some(q => !q.answer) && (
                  <Btn onClick={submit} disabled={busy || sel.status === 'running'}>
                    {busy || sel.status === 'running' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                    Submit Answers (partial OK)
                  </Btn>
                )}
                {sel.questions.length > 0 && sel.questions.every(q => q.answer) && (
                  <Btn onClick={submit} disabled={busy || sel.status === 'running'}>
                    {busy || sel.status === 'running' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                    Process Answers
                  </Btn>
                )}
              </>
            )}
            {sel.stage === 'implementation' && sel.status !== 'running' && (
              <Btn onClick={() => impl(sel.id)}>
                Start Implementation <ArrowRight className="h-3.5 w-3.5" />
              </Btn>
            )}
            {sel.stage === 'pr_opened' && sel.status !== 'running' && cfg.mergeStrategy === 'pr' && (
              <>
                <Btn variant="secondary" onClick={sendFeedback} disabled={busy || !feedback.trim()}>
                  {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  Send Feedback
                </Btn>
                {sel.pr_rework_needed === 0 && (
                  <Btn variant="secondary" onClick={() => handlePrTasks(sel.id)} disabled={!sel.review_feedback}>
                    {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                    <ExternalLink className="h-3.5 w-3.5" /> Address PR
                  </Btn>
                )}
              </>
            )}
            {sel.stage === 'ready' && sel.worktree_path && sel.status !== 'running' && (
              <Btn variant="outline" onClick={() => rebaseTicket(sel.id)} disabled={rebaseLoading}>
                {rebaseLoading
                  ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  : <GitBranch className="h-3.5 w-3.5" />}
                {rebaseLoading ? 'Rebasing…' : 'Rebase'}
              </Btn>
            )}
            {sel.stage === 'review' && (
              <>
                <Btn variant="outline" onClick={() => impl(sel.id)}>
                  <RefreshCw className="h-3.5 w-3.5" /> Continue
                </Btn>
                <Btn variant="outline" onClick={() => rebaseTicket(sel.id)} disabled={rebaseLoading || busy}>
                  {rebaseLoading
                    ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    : <GitBranch className="h-3.5 w-3.5" />}
                  {rebaseLoading ? 'Rebasing…' : 'Rebase'}
                </Btn>
                <Btn variant="secondary" onClick={sendFeedback} disabled={busy || !feedback.trim()}>
                  {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  Send Feedback
                </Btn>
                <Btn onClick={() => ready(sel.id)} disabled={busy}>
                  Ready <ArrowRight className="h-3.5 w-3.5" /> {cfg.mergeStrategy === 'pr' ? 'PR' : 'Cherry-pick'}
                </Btn>
              </>
            )}
            </div>
          </DialogFooter>
        </Dialog>
      )}

      {/* Output modal (test / prepush) */}
      {out.open && (
        <Dialog onClose={() => setOut({ open: false, title: '', text: '', status: '' })} size="md">
          <DialogHeader>
            <h2 className="t-h text-ink-1">{out.title}</h2>
            <IconBtn label="Close" onClick={() => setOut({ open: false, title: '', text: '', status: '' })}>
              <X className="h-4 w-4" />
            </IconBtn>
          </DialogHeader>
          <div className="flex-1 min-h-0 overflow-y-auto px-6 pb-5">
            <div className="mb-3">
              {out.status === 'pass' && <StatusPill kind="success">Passed</StatusPill>}
              {out.status === 'fail' && <StatusPill kind="danger">Failed</StatusPill>}
              {out.status === 'running' && (
                <StatusPill kind="info"><Loader2 className="h-3 w-3 animate-spin" /> Running…</StatusPill>
              )}
            </div>
            <pre className="rounded-md bg-zinc-900 text-zinc-100 p-3.5 t-mono-12 leading-relaxed whitespace-pre-wrap break-words">
{out.text}
            </pre>
          </div>
        </Dialog>
      )}
    </div>
  )
}

/* ─────────────────────────────────────────────────────────
   Dialog primitives — single scroll context, large enough.
   ───────────────────────────────────────────────────────── */
function Dialog({
  children, onClose, size = 'lg',
}: {
  children: React.ReactNode; onClose: () => void; size?: 'md' | 'lg'
}) {
  // Mobile: full-screen sheet (no padding, no rounding, fills viewport).
  // sm+: centered card with viewport padding, rounded, max-w constrained.
  return (
    <div className="fixed inset-0 z-40 sm:flex sm:items-start sm:justify-center sm:pt-[4vh] sm:pb-[4vh]">
      <div className="fixed inset-0 bg-black/40 sm:backdrop-blur-[2px]" onClick={onClose} />
      <div
        className={[
          'relative z-50 bg-surface sm:rounded-xl sm:shadow-2xl sm:ring-1 sm:ring-border',
          'flex flex-col h-full sm:h-auto sm:max-h-[92vh]',
          size === 'lg'
            ? 'w-full sm:w-[95vw] sm:max-w-[1024px]'
            : 'w-full sm:w-[95vw] sm:max-w-[720px]',
        ].join(' ')}
      >
        {children}
      </div>
    </div>
  )
}

function DialogHeader({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`flex items-start justify-between px-4 sm:px-6 pt-4 sm:pt-5 pb-3 sm:pb-4 border-b border-surface-3 ${className}`}>
      {children}
    </div>
  )
}

function DialogFooter({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-end gap-2 px-4 sm:px-6 py-3 sm:py-3.5 border-t border-surface-3 bg-bg/50 sm:rounded-b-xl">
      {children}
    </div>
  )
}

function Section({
  title, hint, children,
}: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section>
      <div className="flex items-baseline justify-between mb-2.5">
        <h3 className="t-meta font-semibold text-ink-2 uppercase tracking-wider">
          {title}
        </h3>
        {hint && <span className="t-meta text-ink-3">{hint}</span>}
      </div>
      {children}
    </section>
  )
}

function StatusPill({
  kind, children,
}: { kind: 'success' | 'danger' | 'info'; children: React.ReactNode }) {
  const cls = {
    success: 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200',
    danger:  'bg-red-50 text-red-700 ring-1 ring-red-200',
    info:    'bg-blue-50 text-blue-700 ring-1 ring-blue-200',
  }[kind]
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 t-meta font-medium ${cls}`}>
      {children}
    </span>
  )
}
