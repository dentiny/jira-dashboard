import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { timeAgo } from './lib/utils'
import {
  Loader2, Link as LinkIcon, ExternalLink, Play, Shield,
  RefreshCw, ArrowRight, X, ChevronRight, Circle, Copy, Check
} from 'lucide-react'

/* ─────────────────────────────────────────────────────────
   Domain types
   ───────────────────────────────────────────────────────── */
interface Q { id: number; question: string; answer: string | null; round: number }
interface A { action: string; detail: string; time: string }
interface T {
  id: string; title: string; content: string; stage: string; status?: string
  plan: string | null; worktree_path: string | null; branch_name: string | null
  commit_sha: string | null; review_feedback: string | null
  questions: Q[]; activity: A[]; created_at: string; updated_at: string
  total_cpu?: string; total_elapsed?: string
}

/* ─────────────────────────────────────────────────────────
   Stage vocabulary — single source of truth.
   Order in the board, label, color, accent dot.
   ───────────────────────────────────────────────────────── */
type Stage = 'clarification' | 'implementation' | 'review' | 'done'

const STAGES: Stage[] = ['clarification', 'implementation', 'review', 'done']

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
  done: {
    label: 'Done',
    dot:   'bg-zinc-400',
    pill:  'bg-zinc-100 text-zinc-600 ring-1 ring-zinc-200',
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
    default:    'bg-zinc-900 text-white hover:bg-zinc-800',
    outline:    'bg-white text-zinc-700 ring-1 ring-zinc-200 hover:bg-zinc-50 hover:text-zinc-900',
    ghost:      'text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900',
    secondary:  'bg-zinc-100 text-zinc-700 hover:bg-zinc-200',
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
  if (!m) return <span className="t-meta text-zinc-500">{stage}</span>
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
      className="h-10 w-10 sm:h-7 sm:w-7 inline-flex items-center justify-center rounded-md text-zinc-500 hover:text-zinc-900 hover:bg-zinc-100 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900/20"
      {...rest}
    >
      {children}
    </button>
  )
}

/* ─────────────────────────────────────────────────────────
   Card
   ───────────────────────────────────────────────────────── */
function TicketCard({ t, onOpen }: { t: T; onOpen: (id: string) => void }) {
  const meta = STAGE_META[t.stage as Stage]
  const running = t.status === 'running'
  const qaCount = t.questions?.length || 0
  return (
    <button
      onClick={() => onOpen(t.id)}
      className="group w-full text-left bg-white rounded-lg ring-1 ring-zinc-200 hover:ring-zinc-300 hover:shadow-sm active:bg-zinc-50 transition-all p-3.5 flex flex-col gap-2.5"
    >
      <div className="flex items-center justify-between">
        <span className="t-mono-11 text-zinc-400 truncate">{t.id}</span>
        {running && <Loader2 className="h-3.5 w-3.5 text-amber-500 animate-spin" />}
      </div>
      <p className="t-body font-medium text-zinc-900 clamp-2 leading-snug">{t.title}</p>
      <div className="flex items-center justify-between pt-1 border-t border-zinc-100">
        <div className="flex items-center gap-1.5 t-meta text-zinc-500 min-w-0">
          {meta && <span className={`h-1.5 w-1.5 rounded-full ${meta.dot} shrink-0`} />}
          <span className="truncate">{timeAgo(t.updated_at)}</span>
        </div>
        {qaCount > 0 && (
          <span className="t-meta text-zinc-500 bg-zinc-100 px-1.5 py-0.5 rounded shrink-0 ml-2">
            {qaCount} Q&amp;A
          </span>
        )}
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
  const long = q.question.length > 110
  return (
    <div className="rounded-lg ring-1 ring-zinc-200 bg-white p-3.5">
      <div className="flex gap-3">
        <span className="t-mono-11 text-zinc-400 shrink-0 mt-0.5 w-6">Q{index}</span>
        <div className="flex-1 min-w-0">
          <p
            className={`t-body text-zinc-900 leading-relaxed ${!expanded && long ? 'clamp-3' : ''}`}
            title={q.question}
          >
            {q.question}
          </p>
          {long && (
            <button
              onClick={() => setExpanded(s => !s)}
              className="t-meta text-zinc-500 hover:text-zinc-900 mt-1 font-medium"
            >
              {expanded ? 'Show less' : 'Read more'}
            </button>
          )}

          {q.answer ? (
            <div className="mt-2 flex gap-2.5 pl-3 border-l-2 border-emerald-300 bg-emerald-50/50 rounded-r py-1.5 pr-2">
              <span className="t-mono-11 text-emerald-600 shrink-0 mt-0.5">A{index}</span>
              <p className="t-body text-emerald-900 leading-relaxed">{q.answer}</p>
            </div>
          ) : (
            <input
              value={answer}
              onChange={e => onAnswer(e.target.value)}
              name={`a-${q.id}`}
              placeholder="Type your answer (optional)…"
              disabled={disabled}
              className="mt-2 w-full h-8 px-2.5 rounded-md ring-1 ring-zinc-200 focus:ring-2 focus:ring-zinc-900/20 t-small text-zinc-900 placeholder:text-zinc-400 bg-white"
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
      <aside className="w-full lg:w-[240px] shrink-0 border-t lg:border-t-0 lg:border-l border-zinc-200 pt-4 lg:pt-0 lg:pl-4">
        <h4 className="t-meta font-semibold text-zinc-500 uppercase tracking-wider mb-3">Activity</h4>
        <p className="t-small text-zinc-400">No activity yet.</p>
      </aside>
    )
  }
  return (
    <aside className="w-full lg:w-[240px] shrink-0 border-t lg:border-t-0 lg:border-l border-zinc-200 pt-4 lg:pt-0 lg:pl-4">
      <h4 className="t-meta font-semibold text-zinc-500 uppercase tracking-wider mb-3">
        Activity
        <span className="ml-1.5 text-zinc-400 normal-case tracking-normal font-normal">
          {items.length}
        </span>
      </h4>
      <ol className="space-y-1.5">
        {items.slice(0, 24).map((a, i) => (
          <li key={i}>
            <button
              onClick={() => setExpanded(s => ({ ...s, [i]: !s[i] }))}
              className="w-full text-left rounded px-2 py-2 sm:px-1.5 sm:py-1 -mx-2 sm:-mx-1.5 hover:bg-zinc-50 active:bg-zinc-100 transition-colors"
            >
              <div className="flex items-baseline gap-2">
                <span className="t-mono-11 text-zinc-400 shrink-0 w-14 sm:w-12">{timeAgo(a.time)}</span>
                <span className="t-small font-medium text-zinc-700 truncate">{a.action}</span>
              </div>
              {expanded[i] && a.detail && (
                <div className="mt-1 ml-14 pl-2 border-l border-zinc-200">
                  <p className="t-mono-11 text-zinc-500 break-words leading-relaxed whitespace-pre-wrap">
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
function ResourceMetrics({
  activity, totalCpu, totalElapsed,
}: { activity: A[]; totalCpu?: string; totalElapsed?: string }) {
  const r = (activity || []).filter(a => a.action === 'resource')
  if (!r.length && !totalCpu && !totalElapsed) return null
  const p = (s: string) => Object.fromEntries(s.split(' ').map(x => x.split('=')))
  const cur = r.length ? p(r[0].detail) : null
  const cpu = parseFloat(cur?.cpu) || 0
  const mem = parseFloat(cur?.mem) || 0
  const el = parseInt(cur?.elapsed) || 1
  const cores = parseInt(cur?.ncores) || 8
  const prev = r.length > 1 ? p(r[1].detail) : null
  const dt = (el - (parseInt(prev?.elapsed) || 0)) || 3
  const dcpu = (cpu - (parseFloat(prev?.cpu) || 0))
  const rate = prev ? dcpu / dt : 0
  const allMem = r.map(a => parseFloat(p(a.detail).mem) || 0)
  const peak = Math.max(...allMem, mem)
  const finished = !!(totalCpu || totalElapsed)
  const cpuPct = Math.min(rate / cores * 100, 100)
  const memPct = peak ? (mem / peak) * 100 : 0

  return (
    <div className="grid grid-cols-2 gap-3 t-small">
      {finished ? (
        <>
          <Metric label="CPU total"   value={totalCpu || '—'} />
          <Metric label="Elapsed"     value={totalElapsed || '—'} />
          <Metric label="Memory peak" value={`${peak.toFixed(0)} MB`} barClass="bg-emerald-500" pct={100} />
          {cur && <Metric label="Threads" value={cur.threads || '—'} />}
          {cur?.tokens_in && <Metric label="Tokens" value={`${cur.tokens_in} in · ${cur.tokens_out} out`} />}
          {cur?.cost && <Metric label="Cost" value={cur.cost} />}
        </>
      ) : (
        <>
          <Metric label="CPU rate"   value={`${rate > 0 ? rate.toFixed(1) : (cpu/el).toFixed(2)}/${cores} cores`} pct={cpuPct} barClass="bg-zinc-900" />
          <Metric label="Memory"     value={`${mem.toFixed(0)} MB`}                                       pct={memPct} barClass="bg-emerald-500" sub={`peak ${peak.toFixed(0)}`} />
          <Metric label="Threads"    value={cur?.threads || '—'} />
          <Metric label="Elapsed"    value={`${cur?.elapsed || '—'}s`} />
          {cur?.tokens_in && <Metric label="Tokens" value={`${cur.tokens_in} in · ${cur.tokens_out} out`} />}
          {cur?.cost && <Metric label="Cost" value={cur.cost} />}
        </>
      )}
    </div>
  )
}

function Metric({ label, value, pct, barClass, sub }:
  { label: string; value: string; pct?: number; barClass?: string; sub?: string }) {
  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:items-baseline sm:justify-between gap-y-0.5 sm:gap-x-2">
        <span className="t-meta text-zinc-500 uppercase tracking-wider font-medium">{label}</span>
        <span className="t-mono-11 text-zinc-700 sm:text-right break-words">{value}</span>
      </div>
      {pct !== undefined && (
        <div className="mt-1 h-1 rounded-full bg-zinc-100 overflow-hidden">
          <div className={`h-full ${barClass}`} style={{ width: pct + '%' }} />
        </div>
      )}
      {sub && <div className="t-mono-11 text-zinc-400 mt-0.5">{sub}</div>}
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
   App
   ───────────────────────────────────────────────────────── */
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
  const [diff, setDiff] = useState('')
  const [copied, setCopied] = useState(false)
  const poll = useRef<ReturnType<typeof setInterval>>()
  const lastUpd = useRef('')

  const load = useCallback(async () => {
    try {
      const d = await fetchJSON<{ tickets: T[] }>('/api/tickets')
      setTickets(d.tickets)
    } catch {}
  }, [])

  // Refs so the hash listener (registered once) sees the latest open/close.
  const selRef = useRef<T | null>(null)
  useEffect(() => { selRef.current = sel }, [sel])
  const openRef = useRef(open)
  useEffect(() => { openRef.current = open }, [open])

  useEffect(() => { load(); const i = setInterval(load, 10000); return () => clearInterval(i) }, [load])

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
        if (poll.current) { clearInterval(poll.current); poll.current = undefined }
      }
    }
    fromHash()
    window.addEventListener('hashchange', fromHash)
    return () => window.removeEventListener('hashchange', fromHash)
  }, [])

  useEffect(() => {
    if (sel && location.hash !== '#ticket/' + sel.id) history.replaceState(null, '', '#ticket/' + sel.id)
  }, [sel])

  /* Open ticket — start polling */
  async function open(id: string) {
    try {
      const t: T = await fetchJSON(`/api/tickets/${id}`)
      setSel(t)
      setTickets(p => p.map(x => (x.id === id ? t : x)))
      lastUpd.current = t.updated_at
      setAnswers({}); setDiff(''); setFeedback('')
      if (poll.current) clearInterval(poll.current)
      poll.current = setInterval(async () => {
        try {
          const f: T = await fetchJSON(`/api/tickets/${id}`)
          if (f.updated_at !== lastUpd.current) {
            lastUpd.current = f.updated_at
            setTickets(p => p.map(x => (x.id === id ? f : x)))
            setSel(f)
          }
        } catch {}
      }, 2000)
    } catch {
      setError('Ticket not found')
    }
  }

  function close() {
    setSel(null)
    if (poll.current) { clearInterval(poll.current); poll.current = undefined }
    if (location.hash.startsWith('#ticket/')) history.replaceState(null, '', ' ')
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
      if (answers[q.id]) a[String(q.id)] = answers[q.id]
      else if (q.answer) a[String(q.id)] = q.answer
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
      }
    } catch (e: any) { setError(e.message) } finally { setBusy(false) }
  }

  async function impl(id: string) {
    try {
      const d: any = await fetchJSON(`/api/tickets/${id}/implement`, { method: 'POST' })
      if (d.ticket) {
        setSel(d.ticket); setTickets(p => p.map(x => (x.id === id ? d.ticket : x)))
        lastUpd.current = d.ticket.updated_at
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
    if (!confirm('Commit, cherry-pick into main, and close?')) return
    setBusy(true)
    try {
      const d: any = await fetchJSON(`/api/tickets/${id}/ready`, { method: 'POST' })
      setSel(d.ticket); setTickets(p => p.map(x => (x.id === id ? d.ticket : x)))
      lastUpd.current = d.ticket.updated_at
    } catch (e: any) { setError(e.message) } finally { setBusy(false) }
  }

  async function viewDiff(id: string) {
    try { const d = await fetchJSON<{ diff: string }>(`/api/tickets/${id}/diff`); setDiff(d.diff || '(no changes)') }
    catch { setDiff('Failed to load diff') }
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

  function copyUrl(id: string) {
    navigator.clipboard.writeText(location.origin + location.pathname + '#ticket/' + id)
      .then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200) })
      .catch(() => {})
  }

  /* Group tickets by stage once */
  const byStage = useMemo(() => {
    const m: Record<Stage, T[]> = { clarification: [], implementation: [], review: [], done: [] }
    for (const t of tickets) {
      if (t.stage in m) (m as any)[t.stage].push(t)
    }
    return m
  }, [tickets])

  /* Filtered activity for the sidebar (drop noise) */
  const visibleActivity = useMemo(() => {
    if (!sel) return []
    return (sel.activity || []).filter(a => a.action !== 'resource' && a.action !== 'file_changed')
  }, [sel])

  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900">
      {/* ── Header ── */}
      <header className="sticky top-0 z-30 bg-white/85 backdrop-blur border-b border-zinc-200">
        <div className="max-w-[1440px] mx-auto px-4 sm:px-6 h-12 flex items-center justify-between gap-3">
          <div className="flex items-baseline gap-2 min-w-0">
            <h1 className="t-h-page text-zinc-900 shrink-0">Pyxen Board</h1>
            <span className="t-small text-zinc-500 hidden sm:inline truncate">Project tickets</span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Btn variant="outline" size="sm" onClick={runTest} aria-label="Run Tests">
              <Play className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Run Tests</span>
            </Btn>
            <Btn variant="outline" size="sm" onClick={runPrepush} aria-label="Pre-push check">
              <Shield className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Pre-push</span>
            </Btn>
          </div>
        </div>
      </header>

      {/* ── Main ── */}
      <main className="max-w-[1440px] mx-auto px-4 sm:px-6 py-4 sm:py-5">
        {/* Inline new-ticket form */}
        <div className="bg-white rounded-lg ring-1 ring-zinc-200 p-3 mb-5 sm:mb-6">
          <div className="flex flex-col sm:flex-row gap-2.5 sm:items-center">
            <input
              value={title}
              onChange={e => { setTitle(e.target.value); setError('') }}
              name="ticket-title"
              placeholder="Ticket title…"
              className="w-full sm:w-[280px] h-10 sm:h-8 px-3 rounded-md ring-1 ring-zinc-200 focus:ring-2 focus:ring-zinc-900/20 t-body text-zinc-900 placeholder:text-zinc-400 bg-white"
            />
            <input
              value={content}
              onChange={e => setContent(e.target.value)}
              name="ticket-content"
              placeholder="Description (optional)"
              className="w-full sm:flex-1 h-10 sm:h-8 px-3 rounded-md ring-1 ring-zinc-200 focus:ring-2 focus:ring-zinc-900/20 t-body text-zinc-900 placeholder:text-zinc-400 bg-white"
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

        {/* ── Board ── */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3 sm:gap-5">
          {STAGES.map(stage => {
            const items = byStage[stage]
            const meta = STAGE_META[stage]
            return (
              <section key={stage} className="min-w-0">
                <header className="flex items-center justify-between mb-2.5 px-1">
                  <div className="flex items-center gap-2">
                    <span className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} />
                    <h3 className="t-meta font-semibold text-zinc-500 uppercase tracking-wider">
                      {meta.label}
                    </h3>
                  </div>
                  <span className="t-meta text-zinc-400 bg-zinc-100 px-1.5 py-0.5 rounded">
                    {items.length}
                  </span>
                </header>
                <div className="flex flex-col gap-2.5">
                  {items.length === 0 && (
                    <div className="rounded-lg border border-dashed border-zinc-200 py-8 text-center t-small text-zinc-400">
                      No tickets
                    </div>
                  )}
                  {items.map(t => <TicketCard key={t.id} t={t} onOpen={open} />)}
                </div>
              </section>
            )
          })}
        </div>
      </main>

      {/* ── Ticket popup ── */}
      {sel && (
        <Dialog onClose={close}>
          <DialogHeader>
            <div className="min-w-0 flex-1 pr-2 sm:pr-4">
              <div className="flex items-center gap-2 sm:gap-2.5 t-meta text-zinc-500 flex-wrap">
                <span className="t-mono-11 truncate max-w-[140px] sm:max-w-none">{sel.id}</span>
                <span className="text-zinc-300">·</span>
                <StagePill stage={sel.stage} />
                {sel.status === 'running' && (
                  <span className="inline-flex items-center gap-1 text-amber-600">
                    <Loader2 className="h-3 w-3 animate-spin" /> running
                  </span>
                )}
              </div>
              <h2 className="t-h text-zinc-900 mt-1.5 clamp-2">{sel.title}</h2>
              <div className="mt-2 flex items-center gap-x-3 gap-y-1 t-meta text-zinc-500 flex-wrap">
                <span>Created {timeAgo(sel.created_at)}</span>
                <span className="text-zinc-300 hidden sm:inline">·</span>
                <span>Updated {timeAgo(sel.updated_at)}</span>
                <button
                  onClick={() => copyUrl(sel.id)}
                  className="inline-flex items-center gap-1 hover:text-zinc-900 active:text-zinc-700 transition-colors"
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
                    <p className="t-body text-zinc-700 leading-relaxed whitespace-pre-wrap">
                      {sel.content}
                    </p>
                  </Section>
                )}

                {sel.review_feedback && (
                  <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
                    <p className="t-meta font-semibold text-amber-700 uppercase tracking-wider mb-1">
                      Review feedback
                    </p>
                    <p className="t-body text-amber-900 leading-relaxed whitespace-pre-wrap">
                      {sel.review_feedback}
                    </p>
                  </div>
                )}

                {/* Clarification — Q&A rounds */}
                {sel.stage === 'clarification' && sel.questions.length > 0 && (
                  <Section title="Questions" hint={`${sel.questions.length} · round ${Math.max(...sel.questions.map(q => q.round))}`}>
                    <div className="space-y-5">
                      {[...new Set(sel.questions.map(q => q.round))].map(round => (
                        <div key={round}>
                          <p className="t-meta font-semibold text-zinc-500 uppercase tracking-wider mb-2">
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
                      <Section title="Implementation Plan">
                        <pre className="rounded-md bg-zinc-900 text-zinc-100 p-3.5 t-mono-12 leading-relaxed whitespace-pre-wrap break-words max-h-72 overflow-y-auto">
{sel.plan}
                        </pre>
                      </Section>
                    )}
                    {sel.status === 'running' ? (
                      <Section title="Live status">
                        <div className="flex items-center gap-2 t-body text-zinc-700">
                          <Loader2 className="h-4 w-4 animate-spin text-amber-500" />
                          Implementing…
                        </div>
                        <div className="mt-3 rounded-lg ring-1 ring-zinc-200 p-3">
                          <ResourceMetrics activity={sel.activity || []} totalCpu={sel.total_cpu} totalElapsed={sel.total_elapsed} />
                        </div>
                        {(() => {
                          const f = (sel.activity || []).filter(a => a.action === 'file_changed')
                          if (!f.length) return null
                          return (
                            <div className="mt-3">
                              <p className="t-meta font-medium text-zinc-500 uppercase tracking-wider mb-1.5">
                                Files modified · {f.length}
                              </p>
                              <div className="rounded-md ring-1 ring-zinc-200 divide-y divide-zinc-100">
                                {f.slice(0, 12).map((a, i) => (
                                  <p key={i} className="t-mono-12 text-zinc-700 px-3 py-1.5">
                                    {a.detail}
                                  </p>
                                ))}
                              </div>
                            </div>
                          )
                        })()}
                      </Section>
                    ) : (
                      <div className="rounded-lg border border-dashed border-zinc-200 p-6 text-center">
                        <p className="t-body text-zinc-600 mb-3">Ready to implement.</p>
                        <Btn onClick={() => impl(sel.id)}>
                          Start Implementation <ArrowRight className="h-3.5 w-3.5" />
                        </Btn>
                      </div>
                    )}
                  </>
                )}

                {/* Review */}
                {sel.stage === 'review' && (
                  <>
                    {sel.worktree_path && (
                      <Section title="Worktree">
                        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 t-mono-12">
                          <dt className="t-meta text-zinc-500 uppercase tracking-wider self-center">Path</dt>
                          <dd className="text-zinc-800 break-all">{sel.worktree_path}</dd>
                          <dt className="t-meta text-zinc-500 uppercase tracking-wider self-center">Branch</dt>
                          <dd className="text-zinc-800 break-all">{sel.branch_name || '—'}</dd>
                        </dl>
                        <div className="mt-3 flex gap-2 flex-wrap">
                          <a
                            href={`vscode://vscode-remote/ssh-remote+cutuy-claw${sel.worktree_path}`}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md ring-1 ring-zinc-200 hover:bg-zinc-50 t-small text-zinc-700"
                          >
                            <ExternalLink className="h-3.5 w-3.5" /> Open in VSCode
                          </a>
                          <a
                            href={`cursor://ssh-remote+cutuy-claw${sel.worktree_path}`}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md ring-1 ring-zinc-200 hover:bg-zinc-50 t-small text-zinc-700"
                          >
                            <ExternalLink className="h-3.5 w-3.5" /> Open in Cursor
                          </a>
                          <Btn variant="outline" size="sm" onClick={() => viewDiff(sel.id)}>
                            View Diff
                          </Btn>
                        </div>
                      </Section>
                    )}
                    {diff && (
                      <Section title="Diff">
                        <pre className="rounded-md bg-zinc-900 text-zinc-100 p-3.5 t-mono-12 leading-relaxed whitespace-pre-wrap break-words max-h-80 overflow-y-auto">
{diff}
                        </pre>
                      </Section>
                    )}
                    {sel.worktree_path && (
                      <Section title="Resource usage">
                        <div className="rounded-md ring-1 ring-zinc-200 p-3">
                          <ResourceMetrics activity={sel.activity || []} totalCpu={sel.total_cpu} totalElapsed={sel.total_elapsed} />
                        </div>
                      </Section>
                    )}
                    <Section title="Feedback (optional)">
                      <textarea
                        value={feedback}
                        onChange={e => setFeedback(e.target.value)}
                        name="fb"
                        placeholder="Send back to clarification with new questions…"
                        rows={3}
                        className="w-full rounded-md ring-1 ring-zinc-200 focus:ring-2 focus:ring-zinc-900/20 px-3 py-2 t-body text-zinc-900 placeholder:text-zinc-400 resize-none"
                      />
                      {error && <p className="t-small text-red-600 mt-1.5">{error}</p>}
                    </Section>
                  </>
                )}

                {/* Done */}
                {sel.stage === 'done' && (
                  <>
                    <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3.5 flex items-start gap-2.5">
                      <Check className="h-4 w-4 text-emerald-600 mt-0.5 shrink-0" />
                      <div className="t-body text-emerald-900">
                        Merged into main · Commit{' '}
                        <code className="t-mono-12 text-emerald-800">{sel.commit_sha || 'N/A'}</code>
                      </div>
                    </div>
                    {sel.plan && (
                      <Section title="Implementation Plan">
                        <pre className="rounded-md bg-zinc-900 text-zinc-100 p-3.5 t-mono-12 leading-relaxed whitespace-pre-wrap break-words max-h-72 overflow-y-auto">
{sel.plan}
                        </pre>
                      </Section>
                    )}
                    <Section title="Resource usage">
                      <div className="rounded-md ring-1 ring-zinc-200 p-3">
                        <ResourceMetrics activity={sel.activity || []} totalCpu={sel.total_cpu} totalElapsed={sel.total_elapsed} />
                      </div>
                    </Section>
                    {sel.questions.length > 0 && (
                      <Section title="Q&A history">
                        <div className="space-y-3">
                          {sel.questions.map((q, i) => (
                            <div key={q.id} className="t-body">
                              <p className="text-zinc-900 leading-relaxed">
                                <span className="t-mono-11 text-zinc-400 mr-2">Q{i + 1}</span>
                                {q.question}
                              </p>
                              {q.answer && (
                                <p className="text-zinc-600 leading-relaxed mt-0.5 pl-5">
                                  <span className="t-mono-11 text-zinc-400 mr-2">A{i + 1}</span>
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
              </div>

              {/* Activity sidebar — same scroll, no nested scrollbar */}
              <ActivitySidebar items={visibleActivity} />
            </div>
          </div>

          {/* Footer */}
          <DialogFooter>
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 w-full sm:w-auto sm:ml-auto">
            {sel.stage === 'clarification' && (
              <>
                {sel.questions.length === 0 && (
                  <Btn variant="outline" onClick={() => clarify(sel.id)}>
                    <RefreshCw className="h-3.5 w-3.5" /> Retry
                  </Btn>
                )}
                {sel.questions.some(q => !q.answer) && (
                  <Btn onClick={submit} disabled={busy}>
                    {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                    Submit Answers (partial OK)
                  </Btn>
                )}
                {sel.questions.length > 0 && sel.questions.every(q => q.answer) && (
                  <Btn onClick={submit} disabled={busy}>
                    {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                    Process Answers
                  </Btn>
                )}
              </>
            )}
            {sel.stage === 'review' && (
              <>
                <Btn variant="outline" onClick={() => impl(sel.id)}>
                  <RefreshCw className="h-3.5 w-3.5" /> Continue
                </Btn>
                <Btn variant="secondary" onClick={sendFeedback} disabled={busy || !feedback.trim()}>
                  {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  Send Feedback
                </Btn>
                <Btn onClick={() => ready(sel.id)} disabled={busy}>
                  Ready <ArrowRight className="h-3.5 w-3.5" /> Cherry-pick
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
            <h2 className="t-h text-zinc-900">{out.title}</h2>
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
      <div className="fixed inset-0 bg-zinc-900/40 sm:backdrop-blur-[2px]" onClick={onClose} />
      <div
        className={[
          'relative z-50 bg-white sm:rounded-xl sm:shadow-2xl sm:ring-1 sm:ring-zinc-200',
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
    <div className={`flex items-start justify-between px-4 sm:px-6 pt-4 sm:pt-5 pb-3 sm:pb-4 border-b border-zinc-100 ${className}`}>
      {children}
    </div>
  )
}

function DialogFooter({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-end gap-2 px-4 sm:px-6 py-3 sm:py-3.5 border-t border-zinc-100 bg-zinc-50/50 sm:rounded-b-xl">
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
        <h3 className="t-meta font-semibold text-zinc-500 uppercase tracking-wider">
          {title}
        </h3>
        {hint && <span className="t-meta text-zinc-400">{hint}</span>}
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
