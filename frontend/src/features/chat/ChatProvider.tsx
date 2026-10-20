import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  api,
  cancelAnalysisRun,
  newAnalysisRunId,
  startAnalysisRun,
  streamAnalysisRun,
  type AnalysisRunInfo,
  type ChatSummary,
  type MapStep,
} from '../../lib/api'
import { DEFAULT_COPILOT_MODEL, MODEL_DEFAULT_EFFORTS } from './modelPresets'

/** A single conversation turn as held in memory (map steps are live-only). */
export interface Msg {
  id: string
  role: 'user' | 'assistant'
  content: string
  thinkingSummary?: string
  thinking?: string
  steps?: MapStep[]
}

export const CUSTOM_MODEL = '__custom__'
const ACTIVE_KEY = 'fitsift-active-chat'

/** A frozen copy of the settings a turn was sent with, so a later save can't pick up
 *  state that changed (or belongs to another chat) while the request was in flight. */
interface SaveSnapshot {
  title: string
  backend: string
  model: string
  reasoning_effort: string
  activity_ids: string[]
}

let seq = 0
const uid = () => {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return `m-${crypto.randomUUID()}`
  return `m-${Date.now()}-${++seq}-${Math.random().toString(36).slice(2, 8)}`
}

function newChatId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `chat-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

interface ChatContextValue {
  // Panel visibility
  open: boolean
  setOpen: (open: boolean) => void
  toggleOpen: () => void

  // Active conversation
  chatId: string | null
  title: string
  messages: Msg[]
  running: boolean
  stopping: boolean
  error: string | null

  // Attached workouts — the single source of truth, shared with the Analyze page.
  activityIds: string[]
  setActivityIds: (ids: string[]) => void
  toggleActivity: (id: string) => void

  // Per-chat settings (persisted so a resumed chat restores them).
  backend: string
  setBackend: (v: string) => void
  modelSel: string
  setModelSel: (v: string) => void
  customModel: string
  setCustomModel: (v: string) => void
  effort: string
  setEffort: (v: string) => void
  workoutPrompt: string | null
  setWorkoutPrompt: (v: string) => void
  effectiveModel: string

  // History
  chats: ChatSummary[]
  chatsLoading: boolean

  // Actions
  send: (text: string) => Promise<void>
  stop: () => void
  newChat: () => void
  resumeChat: (id: string, options?: { openPanel?: boolean }) => Promise<void>
  deleteChat: (id: string) => Promise<void>
  renameChat: (title: string) => Promise<void>
}

const ChatContext = createContext<ChatContextValue | null>(null)
const CHAT_SYNC_INTERVAL_MS = 2_000

export function ChatProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient()
  const { data: config } = useQuery({ queryKey: ['config'], queryFn: api.config })

  const [open, setOpen] = useState(false)
  const [chatId, setChatId] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [messages, setMessages] = useState<Msg[]>([])
  const [running, setRunning] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activityIds, setActivityIdsState] = useState<string[]>([])

  const [backend, setBackend] = useState('')
  // '' until the model picker resolves it to the backend's default.
  const [modelSel, setModelSel] = useState('')
  const [customModel, setCustomModel] = useState('')
  const [effort, setEffort] = useState('')
  const [workoutPrompt, setWorkoutPrompt] = useState<string | null>(null)

  const abortRef = useRef<AbortController | null>(null)
  const runIdRef = useRef<string | null>(null)
  const assistantIdRef = useRef<string | null>(null)
  const loadGenerationRef = useRef(0)
  const committedRef = useRef<{ messageId: string; content: string } | null>(null)
  const chatVersionRef = useRef<string | null>(null)
  const syncingVersionRef = useRef<string | null>(null)
  // A requested switch must outrank summary polling for the chat being left.
  const pendingChatLoadGenerationRef = useRef<number | null>(null)
  // Tracks the currently-active chat so a background save that resolves after the user
  // switched chats doesn't write its result onto the wrong conversation.
  const chatIdRef = useRef<string | null>(null)
  useEffect(() => {
    chatIdRef.current = chatId
  }, [chatId])

  const {
    data: chatList,
    dataUpdatedAt: chatListUpdatedAt,
    isLoading: chatsLoading,
  } = useQuery({
    queryKey: ['chats'],
    queryFn: api.chats,
    // Lightweight summaries let every open client discover runs started elsewhere.
    refetchInterval: CHAT_SYNC_INTERVAL_MS,
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: 'always',
  })
  const chats = chatList?.chats ?? []

  // Seed defaults from server config once it arrives.
  useEffect(() => {
    if (!backend && config?.backends.default) setBackend(config.backends.default)
  }, [config, backend])
  useEffect(() => {
    if (workoutPrompt === null && config?.workout_prompt_default) {
      setWorkoutPrompt(config.workout_prompt_default)
    }
  }, [config, workoutPrompt])

  // Unmounting detaches this browser subscriber; the server-owned run continues.
  useEffect(() => () => abortRef.current?.abort(), [])

  const effectiveModel = modelSel === CUSTOM_MODEL ? customModel.trim() : modelSel

  const setActivityIds = useCallback((ids: string[]) => setActivityIdsState(ids), [])
  const toggleActivity = useCallback((id: string) => {
    setActivityIdsState((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }, [])

  const rememberActive = (id: string | null) => {
    try {
      if (id) localStorage.setItem(ACTIVE_KEY, id)
      else localStorage.removeItem(ACTIVE_KEY)
    } catch {
      /* ignore storage failures (private mode, etc.) */
    }
  }

  const persist = useCallback(
    async (id: string, msgs: Msg[], snap: SaveSnapshot) => {
      const cleaned = msgs.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        thinking_summary: m.thinkingSummary,
        thinking: m.thinking,
      }))
      const firstUser = cleaned.find((m) => m.role === 'user')?.content ?? ''
      try {
        const saved = await api.saveChat(id, {
          title: snap.title || firstUser || undefined,
          backend: snap.backend || undefined,
          model: snap.model || undefined,
          reasoning_effort: snap.reasoning_effort || undefined,
          activity_ids: snap.activity_ids,
          messages: cleaned,
        })
        // Only reflect the saved title if this chat is still the active one.
        if (chatIdRef.current === id) setTitle(saved.title)
        queryClient.invalidateQueries({ queryKey: ['chats'] })
      } catch {
        /* a failed save shouldn't disrupt the live conversation */
      }
    },
    [queryClient],
  )

  const followRun = useCallback(
    async (id: string, runId: string, asstId: string, controller: AbortController) => {
      let resolvedBackend = ''
      const isCurrent = () => chatIdRef.current === id && runIdRef.current === runId
      const settle = () => {
        if (runIdRef.current === runId) {
          runIdRef.current = null
          assistantIdRef.current = null
        }
        if (abortRef.current === controller) abortRef.current = null
        queryClient.invalidateQueries({ queryKey: ['chats'] })
      }

      await streamAnalysisRun(
        runId,
        {
          onStart: (value) => {
            resolvedBackend = value
          },
          onStep: (step) => {
            if (!isCurrent()) return
            setMessages((current) =>
              current.map((message) => {
                if (message.id !== asstId) return message
                const steps = [...(message.steps ?? [])]
                const index = steps.findIndex((item) => item.index === step.index)
                if (index === -1) steps.push(step)
                else steps[index] = step
                steps.sort((a, b) => a.index - b.index)
                return { ...message, steps }
              }),
            )
          },
          onThinking: (info) => {
            if (!isCurrent()) return
            setMessages((current) =>
              current.map((message) =>
                message.id === asstId
                  ? {
                      ...message,
                      thinkingSummary: info.summary || undefined,
                      thinking: info.text || undefined,
                    }
                  : message,
              ),
            )
          },
          onDelta: (text) => {
            if (!isCurrent()) return
            setMessages((current) =>
              current.map((message) => {
                if (message.id !== asstId) return message
                const content = message.content + text
                if (resolvedBackend !== 'copilot') {
                  committedRef.current = { messageId: asstId, content }
                }
                return { ...message, content }
              }),
            )
          },
          onReplace: (text) => {
            if (!isCurrent()) return
            committedRef.current = { messageId: asstId, content: text }
            setMessages((current) =>
              current.map((message) =>
                message.id === asstId ? { ...message, content: text } : message,
              ),
            )
          },
          onDone: () => {
            if (isCurrent()) {
              setRunning(false)
              setStopping(false)
              setError(null)
              committedRef.current = null
            }
            settle()
          },
          onError: (message) => {
            if (isCurrent()) {
              const committed =
                committedRef.current?.messageId === asstId
                  ? committedRef.current.content
                  : ''
              setRunning(false)
              setStopping(false)
              setError(message)
              setMessages((current) =>
                current
                  .map((item) =>
                    item.id === asstId ? { ...item, content: committed } : item,
                  )
                  .filter(
                  (item) =>
                    !(item.id === asstId && item.content === '' && !(item.steps?.length)),
                ),
              )
              committedRef.current = null
            }
            settle()
          },
          onCancelled: () => {
            if (isCurrent()) {
              const committed =
                committedRef.current?.messageId === asstId
                  ? committedRef.current.content
                  : ''
              setRunning(false)
              setStopping(false)
              setMessages((current) =>
                current
                  .map((item) =>
                    item.id === asstId ? { ...item, content: committed } : item,
                  )
                  .filter(
                  (item) =>
                    !(item.id === asstId && item.content === '' && !(item.steps?.length)),
                ),
              )
              committedRef.current = null
            }
            settle()
          },
          onMissing: async () => {
            if (!isCurrent()) return
            try {
              const durable = await api.chat(id)
              if (!isCurrent()) return
              setMessages(
                durable.messages.map((message) => ({
                  id: message.id || uid(),
                  role: message.role,
                  content: message.content,
                  thinkingSummary: message.thinking_summary || undefined,
                  thinking: message.thinking || undefined,
                })),
              )
              const status = durable.analysis_run
              setError(
                status?.status === 'failed'
                  ? status.error || 'The analysis was interrupted.'
                  : null,
              )
              setRunning(false)
              setStopping(false)
              committedRef.current = null
            } catch (cause) {
              if (isCurrent()) {
                setRunning(false)
                setStopping(false)
                committedRef.current = null
                setError(
                  (cause as Error)?.message ??
                    'The analysis could not be restored after the server restarted.',
                )
              }
            }
            settle()
          },
        },
        controller.signal,
      )
      if (abortRef.current === controller) abortRef.current = null
    },
    [queryClient],
  )

  const send = useCallback(
    async (text: string) => {
      const q = text.trim()
      if (!q || running) return
      loadGenerationRef.current += 1
      pendingChatLoadGenerationRef.current = null

      const id = chatId ?? newChatId()
      if (!chatId) {
        setChatId(id)
        rememberActive(id)
        chatVersionRef.current = null
      }
      // Mark this chat active immediately so a fast-completing save targets it correctly.
      chatIdRef.current = id

      const prior = messages
      const userMsg: Msg = { id: uid(), role: 'user', content: q }
      const asstId = uid()
      committedRef.current = { messageId: asstId, content: '' }
      setMessages([...prior, userMsg, { id: asstId, role: 'assistant', content: '', steps: [] }])
      setRunning(true)
      setStopping(false)
      setError(null)

      const controller = new AbortController()
      abortRef.current = controller
      const runId = newAnalysisRunId()
      runIdRef.current = runId
      assistantIdRef.current = asstId

      // Freeze the settings this turn is sent with; the save uses these, not live state.
      const snap: SaveSnapshot = {
        title,
        backend,
        model: effectiveModel,
        reasoning_effort: effort,
        activity_ids: activityIds,
      }

      const transcript = prior.map((m) => `${m.role === 'user' ? 'Me' : 'Coach'}: ${m.content}`).join('\n\n')
      const prompt = transcript
        ? `Here is our conversation so far:\n\n${transcript}\n\nNow respond to my next message:\n\n${q}`
        : q
      const model = !effectiveModel || effectiveModel === 'auto' ? undefined : effectiveModel

      let started: AnalysisRunInfo
      try {
        started = await startAnalysisRun(
          {
            run_id: runId,
            analysis: {
              activity_ids: activityIds,
              prompt,
              workout_prompt:
                workoutPrompt && workoutPrompt.trim() ? workoutPrompt : undefined,
              backend: backend || undefined,
              model,
              reasoning_effort: effort || undefined,
              no_memory: true,
            },
            chat_id: id,
            assistant_message_id: asstId,
            chat: {
              title: snap.title || undefined,
              backend: snap.backend || undefined,
              model: snap.model || undefined,
              reasoning_effort: snap.reasoning_effort || undefined,
              activity_ids: snap.activity_ids,
              messages: [...prior, userMsg].map((message) => ({
                id: message.id,
                role: message.role,
                content: message.content,
                thinking_summary: message.thinkingSummary,
                thinking: message.thinking,
              })),
            },
          },
          controller.signal,
        )
      } catch (cause) {
        if (controller.signal.aborted) return
        const message = (cause as Error)?.message ?? 'Analysis could not be started.'
        setRunning(false)
        setStopping(false)
        setError(message)
        setMessages((current) => current.filter((item) => item.id !== asstId))
        runIdRef.current = null
        assistantIdRef.current = null
        if (abortRef.current === controller) abortRef.current = null
        await persist(id, [...prior, userMsg], snap)
        return
      }

      if (started.status === 'completed' || started.status === 'failed' || started.status === 'cancelled') {
        try {
          const durable = await api.chat(id)
          if (chatIdRef.current === id && runIdRef.current === runId) {
            setTitle(durable.title)
            setMessages(
              durable.messages.map((message) => ({
                id: message.id || uid(),
                role: message.role,
                content: message.content,
                thinkingSummary: message.thinking_summary || undefined,
                thinking: message.thinking || undefined,
              })),
            )
            setRunning(false)
            setStopping(false)
            setError(started.status === 'failed' ? started.error || 'Analysis failed.' : null)
            runIdRef.current = null
            assistantIdRef.current = null
            committedRef.current = null
            if (abortRef.current === controller) abortRef.current = null
          }
        } catch (cause) {
          if (chatIdRef.current === id && runIdRef.current === runId) {
            setRunning(false)
            setStopping(false)
            setError((cause as Error)?.message ?? 'The finished analysis could not be restored.')
            runIdRef.current = null
            assistantIdRef.current = null
            committedRef.current = null
            if (abortRef.current === controller) abortRef.current = null
          }
        }
        queryClient.invalidateQueries({ queryKey: ['chats'] })
        return
      }

      if (!snap.title) {
        setTitle(q.length > 80 ? `${q.slice(0, 80)}…` : q)
      }
      queryClient.invalidateQueries({ queryKey: ['chats'] })
      await followRun(id, runId, asstId, controller)
    },
    [
      running,
      chatId,
      messages,
      activityIds,
      workoutPrompt,
      backend,
      effectiveModel,
      effort,
      title,
      persist,
      queryClient,
      followRun,
    ],
  )

  const stop = useCallback(() => {
    const runId = runIdRef.current
    if (!runId || stopping) return
    setStopping(true)
    void cancelAnalysisRun(runId)
      .then(() => queryClient.invalidateQueries({ queryKey: ['chats'] }))
      .catch((cause) => {
        if (runIdRef.current === runId) {
          setStopping(false)
          setError((cause as Error)?.message ?? 'The analysis could not be stopped.')
        }
      })
  }, [queryClient, stopping])

  const newChat = useCallback(() => {
    // Starting another conversation only detaches; any active analysis keeps running.
    loadGenerationRef.current += 1
    pendingChatLoadGenerationRef.current = null
    abortRef.current?.abort()
    abortRef.current = null
    runIdRef.current = null
    assistantIdRef.current = null
    committedRef.current = null
    chatVersionRef.current = null
    syncingVersionRef.current = null
    setRunning(false)
    setStopping(false)
    setChatId(null)
    chatIdRef.current = null
    setTitle('')
    setMessages([])
    setError(null)
    rememberActive(null)
    // Attachments and other settings carry over, so it's easy to ask a fresh question about
    // the same workouts. A Copilot model pick resets to the default preset.
    if (backend === 'copilot') {
      setModelSel(DEFAULT_COPILOT_MODEL)
      setEffort(MODEL_DEFAULT_EFFORTS[DEFAULT_COPILOT_MODEL] ?? '')
    }
  }, [backend])

  const loadChat = useCallback(
    async (id: string, openPanel: boolean, forgetOnFailure = true) => {
      const generation = ++loadGenerationRef.current
      pendingChatLoadGenerationRef.current = generation
      abortRef.current?.abort()
      abortRef.current = null
      runIdRef.current = null
      assistantIdRef.current = null
      committedRef.current = null
      chatVersionRef.current = null
      setRunning(false)
      setStopping(false)
      setError(null)
      try {
        const chat = await api.chat(id)
        if (generation !== loadGenerationRef.current) return
        chatVersionRef.current = `${chat.id}:${chat.updated_at}:${chat.analysis_run?.status ?? ''}:${chat.messages.length}`
        chatIdRef.current = chat.id
        setChatId(chat.id)
        setTitle(chat.title)
        const loaded: Msg[] = chat.messages.map((message) => ({
          id: message.id || uid(),
          role: message.role,
          content: message.content,
          thinkingSummary: message.thinking_summary || undefined,
          thinking: message.thinking || undefined,
        }))
        const run = chat.analysis_run
        const active =
          run != null &&
          (run.status === 'running' || run.status === 'cancelling') &&
          !!run.assistant_message_id
        if (active && run.assistant_message_id) {
          const pending = loaded.find((message) => message.id === run.assistant_message_id)
          if (pending) pending.steps = []
          else {
            loaded.push({
              id: run.assistant_message_id,
              role: 'assistant',
              content: '',
              steps: [],
            })
          }
        }
        setMessages(loaded)
        setActivityIdsState(chat.activity_ids ?? [])
        if (chat.backend) setBackend(chat.backend)
        setEffort(chat.reasoning_effort ?? '')
        setModelSel(chat.model || 'auto')
        setCustomModel('')
        rememberActive(chat.id)
        if (openPanel) setOpen(true)

        if (active && run?.assistant_message_id) {
          const controller = new AbortController()
          abortRef.current = controller
          runIdRef.current = run.id
          assistantIdRef.current = run.assistant_message_id
          committedRef.current = { messageId: run.assistant_message_id, content: '' }
          setRunning(true)
          setStopping(run.status === 'cancelling')
          void followRun(chat.id, run.id, run.assistant_message_id, controller)
        } else if (run?.status === 'failed' && run.error) {
          setError(run.error)
        }
      } catch {
        if (generation !== loadGenerationRef.current) return
        if (forgetOnFailure) {
          // A user-selected chat that is gone should not keep restoring on startup.
          rememberActive(null)
        }
      } finally {
        if (pendingChatLoadGenerationRef.current === generation) {
          pendingChatLoadGenerationRef.current = null
        }
      }
    },
    [followRun],
  )

  const activeChatSummary = chatId ? chats.find((chat) => chat.id === chatId) : undefined
  const activeChatVersion = activeChatSummary
    ? `${activeChatSummary.id}:${activeChatSummary.updated_at}:${activeChatSummary.analysis_status ?? ''}:${activeChatSummary.message_count}`
    : null
  useEffect(() => {
    if (!chatId || !activeChatVersion) return

    const version = activeChatVersion
    if (
      version === chatVersionRef.current ||
      version === syncingVersionRef.current ||
      pendingChatLoadGenerationRef.current !== null ||
      running ||
      runIdRef.current
    ) {
      return
    }

    syncingVersionRef.current = version
    void loadChat(chatId, false, false).finally(() => {
      if (syncingVersionRef.current === version) syncingVersionRef.current = null
    })
  }, [
    activeChatVersion,
    chatId,
    chatListUpdatedAt,
    loadChat,
    running,
  ])

  const resumeChat = useCallback(
    (id: string, options?: { openPanel?: boolean }) => loadChat(id, options?.openPanel ?? true),
    [loadChat],
  )

  const deleteChat = useCallback(
    async (id: string) => {
      try {
        await api.deleteChat(id)
      } catch {
        /* ignore — refetch below reflects the true server state */
      }
      queryClient.invalidateQueries({ queryKey: ['chats'] })
      if (id === chatId) newChat()
    },
    [queryClient, chatId, newChat],
  )

  const renameChat = useCallback(
    async (next: string) => {
      const trimmed = next.trim()
      if (!chatId || !trimmed) return
      setTitle(trimmed)
      try {
        await api.renameChat(chatId, trimmed)
        queryClient.invalidateQueries({ queryKey: ['chats'] })
      } catch {
        /* ignore */
      }
    },
    [chatId, queryClient],
  )

  // Restore the last active conversation on load (without popping the panel open),
  // so a refresh doesn't lose your place.
  const restoredRef = useRef(false)
  useEffect(() => {
    if (restoredRef.current) return
    restoredRef.current = true
    let last: string | null = null
    try {
      last = localStorage.getItem(ACTIVE_KEY)
    } catch {
      last = null
    }
    if (last) void loadChat(last, false)
  }, [loadChat])

  const value = useMemo<ChatContextValue>(
    () => ({
      open,
      setOpen,
      toggleOpen: () => setOpen((o) => !o),
      chatId,
      title,
      messages,
      running,
      stopping,
      error,
      activityIds,
      setActivityIds,
      toggleActivity,
      backend,
      setBackend,
      modelSel,
      setModelSel,
      customModel,
      setCustomModel,
      effort,
      setEffort,
      workoutPrompt,
      setWorkoutPrompt,
      effectiveModel,
      chats,
      chatsLoading,
      send,
      stop,
      newChat,
      resumeChat,
      deleteChat,
      renameChat,
    }),
    [
      open,
      chatId,
      title,
      messages,
      running,
      stopping,
      error,
      activityIds,
      setActivityIds,
      toggleActivity,
      backend,
      modelSel,
      customModel,
      effort,
      workoutPrompt,
      effectiveModel,
      chats,
      chatsLoading,
      send,
      stop,
      newChat,
      resumeChat,
      deleteChat,
      renameChat,
    ],
  )

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>
}

export function useChat(): ChatContextValue {
  const ctx = useContext(ChatContext)
  if (!ctx) throw new Error('useChat must be used within a ChatProvider')
  return ctx
}
