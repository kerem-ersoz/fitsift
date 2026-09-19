import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { clsx } from 'clsx'
import {
  Check,
  ChevronLeft,
  Clock,
  Layers,
  Loader2,
  MessageSquare,
  Paperclip,
  Pencil,
  Plus,
  Search,
  Send,
  SlidersHorizontal,
  Sparkles,
  Square,
  Trash2,
  X,
} from 'lucide-react'
import { api, type MapStep } from '../../lib/api'
import { sportMeta } from '../../lib/sport'
import { formatDate } from '../../lib/format'
import { useVisualViewportFrame } from '../../lib/useVisualViewportFrame'
import { Button } from '../../components/ui/Button'
import { MarkdownView } from '../../components/ui/Markdown'
import { Sheet } from '../../components/ui/Sheet'
import { ThinkingDisclosure } from '../../components/ui/ThinkingDisclosure'
import { InfographicView } from '../analyze/InfographicView'
import { CUSTOM_MODEL, useChat, type Msg } from './ChatProvider'

const selectClass =
  'h-8 max-w-[10rem] rounded-lg border border-divider bg-surface px-2 text-base text-strong focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50 sm:text-xs'

const MODEL_LABELS: Record<string, string> = {
  'gpt-5.6-sol': 'GPT-5.6 Sol · Long context',
  'gpt-5.6-sol-fast': 'GPT-5.6 Sol Fast · Long context · xhigh default',
  'claude-opus-5': 'Claude Opus 5 · Long context',
}

const MODEL_DEFAULT_EFFORTS: Record<string, string> = {
  'gpt-5.6-sol-fast': 'xhigh',
}

function backendOptions(copilot: boolean) {
  const opts = [
    { v: 'ollama', label: 'Ollama (local)' },
    { v: 'lmstudio', label: 'LM Studio (local)' },
  ]
  if (copilot) opts.unshift({ v: 'copilot', label: 'Copilot CLI' })
  return opts
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const diff = Date.now() - then
  const min = Math.round(diff / 60000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.round(hr / 24)
  if (day < 7) return `${day}d ago`
  return formatDate(iso)
}

interface ChatSummaryLite {
  id: string
  title: string
  updated_at: string
  message_count: number
  activity_ids: string[]
  analysis_status?: string | null
}

/** Bucket chats by recency so a long history stays scannable. Input is newest-first. */
function groupByRecency(chats: ChatSummaryLite[]) {
  const now = new Date()
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const startWeek = startToday - 6 * 86_400_000
  const buckets: Record<string, ChatSummaryLite[]> = { today: [], week: [], older: [] }
  for (const c of chats) {
    const t = new Date(c.updated_at).getTime()
    if (!Number.isNaN(t) && t >= startToday) buckets.today.push(c)
    else if (!Number.isNaN(t) && t >= startWeek) buckets.week.push(c)
    else buckets.older.push(c)
  }
  return [
    { key: 'today', label: 'Today', items: buckets.today },
    { key: 'week', label: 'Previous 7 days', items: buckets.week },
    { key: 'older', label: 'Older', items: buckets.older },
  ].filter((g) => g.items.length > 0)
}

const CHART_BLOCK = /```(?:fitsift-chart|vega-lite|vegalite)[^\n]*\n[\s\S]*?```/gi

function infographicTranscript(messages: Msg[]): string {
  let lastAssistant = -1
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'assistant' && messages[i].content.trim()) {
      lastAssistant = i
      break
    }
  }
  if (lastAssistant < 0) return ''

  const turns = messages
    .slice(0, lastAssistant + 1)
    .filter((message) => message.content.trim())
    .map((message) => {
      const content = message.content.replace(CHART_BLOCK, '[Chart omitted from transcript]').trim()
      return `[${message.role === 'user' ? 'Athlete' : 'Coach'}]\n${content}`
    })

  return [
    'Chronological training conversation. Later coach responses may correct earlier claims.',
    ...turns,
  ].join('\n\n')
}

type ChatSurfaceMode = 'drawer' | 'workspace'

/** The primary Analyze experience: a persistent conversation with room for long answers. */
export function ChatWorkspace({
  className,
  contextCount,
  contextOpen,
  onOpenContext,
}: {
  className?: string
  contextCount: number
  contextOpen: boolean
  onOpenContext: () => void
}) {
  return (
    <section
      aria-label="Training conversation"
      className={clsx(
        'flex min-h-0 flex-col overflow-hidden overscroll-none rounded-xl border border-divider bg-surface',
        className,
      )}
    >
      <ChatSurface
        mode="workspace"
        contextCount={contextCount}
        contextOpen={contextOpen}
        onOpenContext={onOpenContext}
      />
    </section>
  )
}

/** Global, resumable conversation pane used as a drawer outside the Analyze workspace. */
export function ChatDock() {
  const chat = useChat()
  const { open, setOpen } = chat
  // `mounted` keeps the drawer in the DOM briefly while it animates out; `shown` drives
  // the slide/fade. When neither is set the drawer renders nothing at all — so a closed
  // pane can never affect layout, scroll width, or intercept clicks in any engine.
  const [mounted, setMounted] = useState(open)
  const [shown, setShown] = useState(open)
  const drawerRef = useRef<HTMLElement>(null)
  useVisualViewportFrame(drawerRef, mounted || open)

  useEffect(() => {
    if (open) {
      setMounted(true)
      // Next frame: flip to the on-screen state so the transition runs.
      const raf = requestAnimationFrame(() => setShown(true))
      return () => cancelAnimationFrame(raf)
    }
    setShown(false)
    const t = window.setTimeout(() => setMounted(false), 220) // after the 200ms transition
    return () => window.clearTimeout(t)
  }, [open])

  // Close on Escape.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
    }
  }, [open, setOpen])

  // Fully absent when closed — no fixed overlay left behind.
  if (!mounted && !open) return null

  return (
    <>
      {/* Scrim — dims the app and closes on click. */}
      <div
        onClick={() => setOpen(false)}
        aria-hidden="true"
        className={`fixed inset-0 z-40 bg-backdrop-subtle transition-opacity duration-200 motion-reduce:transition-none ${
          shown ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
      />

      <aside
        ref={drawerRef}
        role="dialog"
        aria-modal="true"
        aria-label="Chat"
        className={`fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l border-divider bg-surface shadow-xl transition-transform duration-200 ease-out motion-reduce:transition-none sm:max-w-[30rem] ${
          shown ? 'translate-x-0' : 'translate-x-full'
        }`}
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        <ChatSurface mode="drawer" active={open} onClose={() => setOpen(false)} />
      </aside>
    </>
  )
}

function ChatSurface({
  mode,
  active = false,
  contextCount = 0,
  contextOpen = false,
  onOpenContext,
  onClose,
}: {
  mode: ChatSurfaceMode
  active?: boolean
  contextCount?: number
  contextOpen?: boolean
  onOpenContext?: () => void
  onClose?: () => void
}) {
  const [view, setView] = useState<'chat' | 'history'>('chat')
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (!active) return
    setView('chat')
    const t = window.setTimeout(() => inputRef.current?.focus(), 60)
    return () => window.clearTimeout(t)
  }, [active])

  return view === 'history' ? (
    <HistoryView mode={mode} onClose={() => setView('chat')} />
  ) : (
    <ChatView
      mode={mode}
      inputRef={inputRef}
      contextCount={contextCount}
      contextOpen={contextOpen}
      onOpenContext={onOpenContext}
      onShowHistory={() => setView('history')}
      onClose={onClose}
    />
  )
}

function ChatView({
  mode,
  inputRef,
  contextCount,
  contextOpen,
  onOpenContext,
  onShowHistory,
  onClose,
}: {
  mode: ChatSurfaceMode
  inputRef: React.RefObject<HTMLTextAreaElement>
  contextCount: number
  contextOpen: boolean
  onOpenContext?: () => void
  onShowHistory: () => void
  onClose?: () => void
}) {
  const chat = useChat()
  const isWorkspace = mode === 'workspace'
  const { data: config } = useQuery({ queryKey: ['config'], queryFn: api.config })
  const { data: activities } = useQuery({ queryKey: ['activities'], queryFn: api.activities })

  const { data: modelInfo } = useQuery({
    queryKey: ['models', chat.backend],
    queryFn: () => api.models(chat.backend),
    enabled: !!chat.backend && (chat.open || isWorkspace),
  })

  const [input, setInput] = useState('')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [showInfographic, setShowInfographic] = useState(false)
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const transcriptRef = useRef<HTMLDivElement>(null)

  // Keep the model selection valid for the chosen backend.
  useEffect(() => {
    if (!modelInfo) return
    if (chat.modelSel === CUSTOM_MODEL) return
    if (modelInfo.models.includes(chat.modelSel)) return
    chat.setModelSel(modelInfo.models[0] ?? (modelInfo.allow_custom ? CUSTOM_MODEL : ''))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelInfo])

  useEffect(() => {
    const reduce =
      typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const transcript = transcriptRef.current
    if (!transcript) return
    transcript.scrollTo({
      top: transcript.scrollHeight,
      behavior: reduce ? 'auto' : 'smooth',
    })
  }, [chat.messages])

  const attached = useMemo(
    () => (activities ?? []).filter((a) => chat.activityIds.includes(a.id)),
    [activities, chat.activityIds],
  )
  const attachedCount = chat.activityIds.length
  const efforts = modelInfo?.efforts ?? []
  const infographicSource = useMemo(() => infographicTranscript(chat.messages), [chat.messages])

  const suggestions = useMemo(() => {
    if (attachedCount > 1)
      return ['Compare these workouts — what stands out?', 'How is my fitness trending across these?', 'Which was the hardest effort, and why?']
    if (attachedCount === 1)
      return ["Give me a coach's summary.", 'Analyze my pacing and heart-rate strategy.', 'Any signs of fatigue or overreaching?']
    return ['Compare my last 3 long runs', 'How did my running go this month?', 'Summarize this week of training']
  }, [attachedCount])

  const submit = useCallback(
    (text: string) => {
      if (chat.running) return // don't clear/drop a follow-up typed mid-stream
      if (!text.trim()) return
      setInput('')
      void chat.send(text)
    },
    [chat.running, chat.send],
  )

  const commitTitle = () => {
    setEditingTitle(false)
    if (titleDraft.trim() && titleDraft.trim() !== chat.title) void chat.renameChat(titleDraft)
  }

  return (
    <>
      {/* Header */}
      <div
        className={clsx(
          'flex shrink-0 items-center gap-1 border-b border-divider-soft sm:gap-2',
          isWorkspace ? 'px-4 py-3 sm:px-5' : 'px-3 py-2.5',
        )}
      >
        {isWorkspace ? (
          <span className="hidden h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent-tint text-accent-strong sm:flex">
            <MessageSquare className="h-4 w-4" />
          </span>
        ) : (
          <MessageSquare className="h-4 w-4 shrink-0 text-accent" />
        )}
        <div className="min-w-0 flex-1">
          {editingTitle ? (
            <input
              value={titleDraft}
              autoFocus
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={commitTitle}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitTitle()
                if (e.key === 'Escape') setEditingTitle(false)
              }}
              aria-label="Chat title"
              className="w-full rounded border border-divider px-1.5 py-0.5 text-base font-semibold text-ink focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent sm:text-sm"
            />
          ) : (
            <button
              type="button"
              onClick={() => {
                if (!chat.chatId) return
                setTitleDraft(chat.title)
                setEditingTitle(true)
              }}
              disabled={!chat.chatId}
              title={chat.chatId ? 'Rename chat' : undefined}
              className="group flex w-full min-w-0 items-center gap-1.5 rounded text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              <span className="truncate text-sm font-semibold text-ink">
                {chat.title || 'New conversation'}
              </span>
              {chat.chatId && (
                <Pencil className="h-3 w-3 shrink-0 text-disabled group-hover:text-muted" />
              )}
            </button>
          )}
          {isWorkspace && (
            <p className="mt-0.5 hidden text-xs text-muted sm:block">
              {chat.running
                ? 'Analysis continues if you leave this screen'
                : 'Private · saved automatically'}
            </p>
          )}
        </div>
        {isWorkspace && onOpenContext && (
          <IconButton
            label={
              contextCount > 0
                ? `Workout context, ${contextCount} ${contextCount === 1 ? 'workout' : 'workouts'} attached`
                : 'Add workout context'
            }
            onClick={onOpenContext}
            dialog
            expanded={contextOpen}
          >
            <Paperclip className="h-4 w-4" />
          </IconButton>
        )}
        {infographicSource && (
          <IconButton
            label="Conversation infographic"
            onClick={() => setShowInfographic(true)}
            disabled={chat.running}
            dialog
            expanded={showInfographic}
          >
            <Layers className="h-4 w-4" />
          </IconButton>
        )}
        <IconButton label="Chat history" onClick={onShowHistory}>
          <Clock className="h-4 w-4" />
        </IconButton>
        <IconButton label="New chat" onClick={() => chat.newChat()}>
          <Plus className="h-4 w-4" />
        </IconButton>
        {onClose && (
          <IconButton label="Close chat" onClick={onClose}>
            <X className="h-4 w-4" />
          </IconButton>
        )}
      </div>

      {/* Settings */}
      <div
        className={clsx(
          'shrink-0 space-y-2 border-b border-divider-soft',
          isWorkspace ? 'px-4 py-2.5 sm:px-5' : 'px-3 py-2.5',
        )}
      >
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={chat.backend}
            onChange={(e) => chat.setBackend(e.target.value)}
            disabled={chat.running}
            aria-label="Model backend"
            className={selectClass}
          >
            {backendOptions(config?.backends.copilot ?? false).map((o) => (
              <option key={o.v} value={o.v}>
                {o.label}
              </option>
            ))}
          </select>
          <select
            value={chat.modelSel}
            onChange={(e) => {
              const model = e.target.value
              chat.setModelSel(model)
              const defaultEffort = MODEL_DEFAULT_EFFORTS[model]
              if (defaultEffort) chat.setEffort(defaultEffort)
            }}
            disabled={chat.running || !modelInfo}
            aria-label="Model"
            className={selectClass}
          >
            {(modelInfo?.models ?? ['auto']).map((m) => (
              <option key={m} value={m}>
                {MODEL_LABELS[m] ?? m}
              </option>
            ))}
            {modelInfo?.allow_custom && <option value={CUSTOM_MODEL}>Custom…</option>}
          </select>
          {chat.modelSel === CUSTOM_MODEL && (
            <input
              value={chat.customModel}
              onChange={(e) => chat.setCustomModel(e.target.value)}
              disabled={chat.running}
              placeholder="model id"
              aria-label="Custom model id"
              className="h-8 w-32 rounded-lg border border-divider bg-surface px-2 text-base text-ink placeholder:text-muted focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent sm:text-xs"
            />
          )}
          {efforts.length > 0 && (
            <select
              value={chat.effort}
              onChange={(e) => chat.setEffort(e.target.value)}
              disabled={chat.running}
              aria-label="Reasoning effort"
              className={selectClass}
            >
              <option value="">Effort: auto</option>
              {efforts.map((e) => (
                <option key={e} value={e}>
                  Effort: {e}
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            onClick={() => setShowAdvanced((v) => !v)}
            aria-expanded={showAdvanced}
            className="inline-flex min-h-8 items-center gap-1 rounded px-1 text-xs font-medium text-muted hover:text-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <SlidersHorizontal className="h-3.5 w-3.5" /> Analysis prompt
          </button>
          {modelInfo && !modelInfo.reachable && (
            <span className="text-xs font-medium text-warning">
              {chat.backend === 'copilot' ? 'Copilot CLI not found' : `${chat.backend} not reachable`}
            </span>
          )}
        </div>
        {showAdvanced && (
          <div className="space-y-1">
            <textarea
              value={chat.workoutPrompt ?? ''}
              onChange={(e) => chat.setWorkoutPrompt(e.target.value)}
              rows={3}
              aria-label="Per-workout analysis prompt"
              className="w-full resize-none rounded-lg border border-divider p-2 text-base text-strong focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent sm:resize-y sm:text-xs"
            />
            <div className="flex items-center justify-between gap-2">
              <p className="text-[11px] text-muted">
                Prompt for each per-workout analysis when comparing 2+ workouts.
              </p>
              {config?.workout_prompt_default && chat.workoutPrompt !== config.workout_prompt_default && (
                <button
                  type="button"
                  onClick={() => chat.setWorkoutPrompt(config.workout_prompt_default)}
                  className="shrink-0 rounded text-[11px] font-medium text-accent-strong hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                >
                  Reset
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Attached workouts */}
      {attachedCount > 0 && (
        <div
          className={clsx(
            'flex shrink-0 flex-wrap items-center gap-1.5 border-b border-divider-soft py-2',
            isWorkspace ? 'px-4 sm:px-5' : 'px-3',
          )}
        >
          {attached.map((a) => {
            const { label } = sportMeta(a.sport)
            return (
              <span
                key={a.id}
                className="inline-flex items-center gap-1 rounded-full bg-accent-tint py-0.5 pl-2 pr-1 text-xs font-medium text-accent-strong"
              >
                {label} · {formatDate(a.start_time)}
                <button
                  type="button"
                  onClick={() => chat.toggleActivity(a.id)}
                  aria-label={`Detach ${label}`}
                  className="rounded-full p-0.5 text-accent-subdued hover:bg-accent-tint-strong hover:text-accent-deep focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            )
          })}
          {/* Ids whose activity summary isn't loaded still count as attached. */}
          {attachedCount > attached.length && (
            <span className="text-xs text-muted">
              +{attachedCount - attached.length} more
            </span>
          )}
        </div>
      )}

      <ChatTranscript
        messages={chat.messages}
        running={chat.running}
        error={chat.error}
        attachedCount={attachedCount}
        suggestions={suggestions}
        onSubmit={submit}
        isWorkspace={isWorkspace}
        scrollRef={transcriptRef}
      />

      {/* Composer */}
      {isWorkspace ? (
        <div className="shrink-0 border-t border-divider-soft bg-surface-muted p-3 sm:p-4">
          <div className="mx-auto max-w-3xl">
            <div className="rounded-xl border border-divider-strong bg-surface p-2 transition-colors focus-within:border-accent focus-within:ring-1 focus-within:ring-accent motion-reduce:transition-none">
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault()
                    submit(input)
                  }
                }}
                rows={2}
                placeholder={
                  attachedCount > 0
                    ? 'Ask a question about the workouts in context…'
                    : 'Ask anything about your training…'
                }
                aria-label="Message"
                className="max-h-40 min-h-[4.5rem] w-full resize-none border-0 bg-transparent px-2 py-1.5 text-base text-ink placeholder:text-muted focus:outline-none sm:resize-y sm:text-sm"
              />
              <div className="flex items-center justify-between gap-3 border-t border-divider-soft px-1 pt-2">
                <span className="text-xs text-muted">Enter to send · Shift+Enter for a new line</span>
                {chat.running ? (
                  <Button
                    variant="secondary"
                    onClick={() => chat.stop()}
                    disabled={chat.stopping}
                  >
                    <Square className="h-4 w-4" />
                    {chat.stopping ? 'Stopping…' : 'Stop'}
                  </Button>
                ) : (
                  <Button onClick={() => submit(input)} disabled={!input.trim()}>
                    <Send className="h-4 w-4" />
                    Send
                  </Button>
                )}
              </div>
            </div>
            {chat.running && (
              <p className="mt-2 flex items-center gap-1.5 text-xs text-muted">
                <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
                {chat.stopping ? 'Stopping analysis…' : 'Running in the background…'}
              </p>
            )}
          </div>
        </div>
      ) : (
        <div className="shrink-0 border-t border-divider-soft p-3">
          <div className="flex items-end gap-2">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  submit(input)
                }
              }}
              rows={1}
              placeholder={
                attachedCount > 0
                  ? 'Ask a question…'
                  : 'Ask anything — e.g. “compare my last 3 long runs”'
              }
              aria-label="Message"
              className="max-h-32 min-h-[44px] flex-1 resize-none rounded-lg border border-divider p-2.5 text-base placeholder:text-muted focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent sm:resize-y sm:text-sm"
            />
            {chat.running ? (
              <Button
                variant="secondary"
                onClick={() => chat.stop()}
                disabled={chat.stopping}
                aria-label={chat.stopping ? 'Stopping' : 'Stop'}
              >
                <Square className="h-4 w-4" />
              </Button>
            ) : (
              <Button onClick={() => submit(input)} disabled={!input.trim()} aria-label="Send">
                <Send className="h-4 w-4" />
              </Button>
            )}
          </div>
          {chat.running && (
            <p className="mt-1.5 flex items-center gap-1.5 text-xs text-muted">
              <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
              {chat.stopping ? 'Stopping analysis…' : 'Running in the background…'}
            </p>
          )}
        </div>
      )}

      {showInfographic && (
        <Sheet
          title="Conversation infographic"
          subtitle="A current visual summary; later corrections override earlier claims"
          icon={
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent-tint text-accent-strong">
              <Layers className="h-4 w-4" />
            </span>
          }
          size="wide"
          onClose={() => setShowInfographic(false)}
          contentClassName="scrollbar-hidden flex-1 overflow-y-auto bg-surface-muted p-4"
        >
          <InfographicView
            source={{
              kind: 'ephemeral',
              analysis: infographicSource,
              backend: chat.backend || undefined,
              model:
                !chat.effectiveModel || chat.effectiveModel === 'auto'
                  ? undefined
                  : chat.effectiveModel,
              reasoningEffort: chat.effort || undefined,
            }}
          />
        </Sheet>
      )}
    </>
  )
}

interface ChatTranscriptProps {
  messages: Msg[]
  running: boolean
  error: string | null
  attachedCount: number
  suggestions: string[]
  onSubmit: (text: string) => void
  isWorkspace: boolean
  scrollRef: React.RefObject<HTMLDivElement>
}

const ChatTranscript = memo(function ChatTranscript({
  messages,
  running,
  error,
  attachedCount,
  suggestions,
  onSubmit,
  isWorkspace,
  scrollRef,
}: ChatTranscriptProps) {
  return (
    <div
      ref={scrollRef}
      aria-live="polite"
      className={clsx(
        'min-h-0 flex-1 overscroll-contain overflow-y-auto',
        isWorkspace ? 'px-4 py-6 sm:px-6 sm:py-8' : 'px-3 py-4',
      )}
    >
      <div className={clsx('h-full', isWorkspace && 'mx-auto max-w-3xl')}>
        {messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <div
              className={clsx(
                'flex items-center justify-center rounded-full bg-accent-tint text-accent-strong',
                isWorkspace ? 'h-14 w-14' : 'h-12 w-12',
              )}
            >
              <Sparkles className={isWorkspace ? 'h-6 w-6' : 'h-5 w-5'} />
            </div>
            <p className={clsx('font-semibold text-ink', isWorkspace ? 'text-base' : 'text-sm')}>
              {attachedCount > 0
                ? attachedCount === 1
                  ? 'What do you want to understand about this workout?'
                  : `What do you want to understand about these ${attachedCount} workouts?`
                : 'What do you want to understand about your training?'}
            </p>
            <p className={clsx('text-sm text-muted', isWorkspace ? 'max-w-md' : 'max-w-xs')}>
              {attachedCount > 0
                ? 'Ask in your own words. The analysis keeps running if you leave, and the conversation stays available for later.'
                : isWorkspace
                  ? 'Ask across your full training history, or attach specific workouts from the context panel for a focused comparison.'
                  : 'Describe the workouts in your question, or attach specific sessions from Analyze.'}
            </p>
            <div className="mt-2 flex max-w-xl flex-wrap justify-center gap-2">
              {suggestions.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  onClick={() => onSubmit(suggestion)}
                  className="min-h-11 rounded-full border border-divider bg-surface-muted px-4 py-2 text-xs font-medium text-copy transition-colors hover:bg-hover hover:text-ink-soft focus:outline-none focus-visible:ring-2 focus-visible:ring-accent motion-reduce:transition-none"
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="space-y-5">
            {messages.map((message) => (
              <MessageBubble
                key={message.id}
                msg={message}
                running={running && message.id === messages[messages.length - 1]?.id}
              />
            ))}
            {error && (
              <div role="alert" className="rounded-lg border border-danger-divider bg-danger-tint p-3 text-sm text-danger-strong">
                {error}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
})

function HistoryView({ mode, onClose }: { mode: ChatSurfaceMode; onClose: () => void }) {
  const chat = useChat()
  const [query, setQuery] = useState('')
  const [confirmId, setConfirmId] = useState<string | null>(null)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? chat.chats.filter((c) => c.title.toLowerCase().includes(q)) : chat.chats
  }, [chat.chats, query])

  const groups = useMemo(() => groupByRecency(filtered), [filtered])
  const showSearch = chat.chats.length > 5

  const del = (id: string) => {
    setConfirmId(null)
    void chat.deleteChat(id)
  }

  return (
    <>
      <div className="flex items-center gap-1 border-b border-divider-soft px-2 py-2.5">
        <IconButton label="Back to conversation" onClick={onClose}>
          <ChevronLeft className="h-4 w-4" />
        </IconButton>
        <span className="flex-1 text-sm font-semibold text-ink">Saved chats</span>
        <IconButton
          label="New chat"
          onClick={() => {
            chat.newChat()
            onClose()
          }}
        >
          <Plus className="h-4 w-4" />
        </IconButton>
      </div>

      {showSearch && (
        <div className="border-b border-divider-soft px-3 py-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-faint" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search chats…"
              aria-label="Search saved chats"
              className="h-9 w-full rounded-lg border border-divider bg-surface pl-8 pr-2 text-base text-ink placeholder:text-muted focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent sm:text-sm"
            />
          </div>
        </div>
      )}

      <div className="min-h-0 flex-1 overscroll-contain overflow-y-auto">
        {chat.chatsLoading ? (
          <div className="space-y-2 p-3">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="h-12 animate-pulse rounded-lg bg-skeleton" />
            ))}
          </div>
        ) : chat.chats.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center">
            <div className="flex h-11 w-11 items-center justify-center rounded-full border border-divider-soft bg-surface-subtle text-faint">
              <MessageSquare className="h-5 w-5" />
            </div>
            <p className="text-sm font-medium text-strong">No saved chats yet</p>
            <p className="text-sm text-muted">
              Every conversation you start is saved here automatically so you can pick it up later.
            </p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-1 px-8 text-center">
            <p className="text-sm font-medium text-strong">No matches</p>
            <p className="text-sm text-muted">No saved chats contain “{query.trim()}”.</p>
          </div>
        ) : (
          <div className="pb-3">
            {groups.map((g) => (
              <section key={g.key}>
                <h3 className="sticky top-0 z-10 bg-chrome px-3 pb-1 pt-3 text-xs font-medium text-muted backdrop-blur">
                  {g.label}
                </h3>
                <ul className="divide-y divide-divider-soft">
                  {g.items.map((c) => (
                    <ChatRow
                      key={c.id}
                      chat={c}
                      active={c.id === chat.chatId}
                      confirming={confirmId === c.id}
                      onResume={() => {
                        chat.resumeChat(c.id, { openPanel: mode === 'drawer' })
                        onClose() // return to the conversation view, not just load it in the background
                      }}
                      onAskDelete={() => setConfirmId(c.id)}
                      onCancelDelete={() => setConfirmId(null)}
                      onConfirmDelete={() => del(c.id)}
                    />
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
      </div>
    </>
  )
}

function ChatRow({
  chat: c,
  active,
  confirming,
  onResume,
  onAskDelete,
  onCancelDelete,
  onConfirmDelete,
}: {
  chat: ChatSummaryLite
  active: boolean
  confirming: boolean
  onResume: () => void
  onAskDelete: () => void
  onCancelDelete: () => void
  onConfirmDelete: () => void
}) {
  return (
    <li className={active ? 'bg-accent-tint' : ''}>
      <div className="group flex items-stretch transition-colors hover:bg-hover motion-reduce:transition-none">
        <button
          type="button"
          onClick={onResume}
          className="min-w-0 flex-1 px-3 py-2.5 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
        >
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-ink-soft">{c.title}</span>
            {active && (
              <span className="shrink-0 rounded-full bg-accent-tint-strong px-1.5 py-px text-xs font-semibold text-accent-strong">
                Current
              </span>
            )}
            {(c.analysis_status === 'running' || c.analysis_status === 'cancelling') && (
              <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-slate-100 px-1.5 py-px text-xs font-medium text-slate-600">
                <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" />
                Running
              </span>
            )}
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted">
            <span>{relativeTime(c.updated_at)}</span>
            <span aria-hidden="true">·</span>
            <span>
              {c.message_count} {c.message_count === 1 ? 'message' : 'messages'}
            </span>
            {c.activity_ids.length > 0 && (
              <span className="inline-flex items-center gap-0.5" title={`${c.activity_ids.length} workouts attached`}>
                <Paperclip className="h-3 w-3" />
                {c.activity_ids.length}
              </span>
            )}
          </div>
        </button>

        <div className="flex shrink-0 items-center pr-2">
          {confirming ? (
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={onConfirmDelete}
                className="rounded-md px-2 py-1 text-xs font-semibold text-danger hover:bg-danger-tint focus:outline-none focus-visible:ring-2 focus-visible:ring-danger-soft"
              >
                Delete
              </button>
              <button
                type="button"
                onClick={onCancelDelete}
                className="rounded-md px-2 py-1 text-xs font-medium text-muted hover:bg-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={onAskDelete}
              aria-label={`Delete chat: ${c.title}`}
              className="rounded-md p-1.5 text-disabled transition-colors hover:bg-hover hover:text-danger focus:text-danger focus:outline-none focus-visible:ring-2 focus-visible:ring-accent motion-reduce:transition-none"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>
    </li>
  )
}

function IconButton({
  label,
  onClick,
  disabled = false,
  dialog = false,
  expanded,
  children,
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  dialog?: boolean
  expanded?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-haspopup={dialog ? 'dialog' : undefined}
      aria-expanded={dialog ? expanded : undefined}
      title={label}
      className="inline-flex h-11 w-11 items-center justify-center rounded-lg text-muted hover:bg-hover hover:text-ink-soft focus:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-40"
    >
      {children}
    </button>
  )
}

function StepList({ steps, running }: { steps: MapStep[]; running: boolean }) {
  const allDone = steps.length > 0 && steps.every((s) => s.state === 'done')
  return (
    <div className="mb-2 space-y-1 rounded-lg border border-divider-soft bg-surface-muted p-2.5">
      {steps.map((s) => (
        <div key={s.index} className="flex items-center gap-2 text-xs">
          {s.state === 'done' ? (
            <Check className="h-3.5 w-3.5 shrink-0 text-accent" />
          ) : (
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-faint motion-reduce:animate-none" />
          )}
          <span className="truncate text-copy">
            {s.state === 'done' ? (s.reused ? 'Reused' : 'Analyzed') : 'Analyzing'} {s.label}
          </span>
        </div>
      ))}
      {allDone && running && (
        <div className="flex items-center gap-2 text-xs">
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-faint motion-reduce:animate-none" />
          <span className="text-copy">Synthesizing across {steps.length} workouts…</span>
        </div>
      )}
    </div>
  )
}

const MessageBubble = memo(function MessageBubble({
  msg,
  running,
}: {
  msg: Msg
  running: boolean
}) {
  if (msg.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] whitespace-pre-wrap rounded-xl rounded-br-sm bg-action px-3.5 py-2 text-sm text-on-action">
          {msg.content}
        </div>
      </div>
    )
  }
  return (
    <div className="min-w-0">
      {msg.steps && msg.steps.length > 0 && <StepList steps={msg.steps} running={running} />}
      <ThinkingDisclosure
        summary={msg.thinkingSummary}
        thinking={msg.thinking}
        running={running}
        className="mb-3"
      />
      {msg.content ? (
        <MarkdownView>{msg.content}</MarkdownView>
      ) : !msg.steps?.length && running ? (
        <p className="text-sm text-muted">Analysis is running in the background…</p>
      ) : null}
    </div>
  )
})
