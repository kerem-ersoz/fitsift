// Copilot presets in the chat model picker. The server runs its long-context presets with
// `--context long_context` (Claude Opus 5.5's is the 1M-token window).

/** New Copilot conversations start on this preset. */
export const DEFAULT_COPILOT_MODEL = 'claude-opus-5.5'

export const MODEL_LABELS: Record<string, string> = {
  'claude-opus-5.5': 'Claude Opus 5.5 · 1M context · max default',
  'gpt-5.6-sol': 'GPT-5.6 Sol · Long context',
  'gpt-5.6-sol-fast': 'GPT-5.6 Sol Fast · Long context · xhigh default',
  'claude-opus-5': 'Claude Opus 5 · Long context',
}

/** Reasoning effort applied when a preset is selected. */
export const MODEL_DEFAULT_EFFORTS: Record<string, string> = {
  'claude-opus-5.5': 'max',
  'gpt-5.6-sol-fast': 'xhigh',
}
