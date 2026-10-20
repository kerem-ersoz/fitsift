import { expect, test, type Page } from '@playwright/test'

const COPILOT_MODELS = ['auto', 'claude-opus-5.5', 'gpt-5.6-sol', 'gpt-5.6-sol-fast', 'claude-opus-5']
const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

interface StartedAnalysis {
  backend?: string
  model?: string
  reasoning_effort?: string
}

async function mockApi(page: Page) {
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url())
    let json: unknown = {}

    if (url.pathname.endsWith('/config')) {
      json = {
        brand: { name: 'FitSift', tagline: 'Sift your workouts into insight' },
        backends: { copilot: true, default: 'copilot' },
        library_dir: '',
        memory_dir: '',
        chats_dir: '',
        base_path: '',
        workout_prompt_default: '',
      }
    } else if (url.pathname.endsWith('/activities')) {
      json = []
    } else if (url.pathname.endsWith('/chats')) {
      json = { chats: [] }
    } else if (url.pathname.endsWith('/models')) {
      const backend = url.searchParams.get('backend')
      json =
        backend === 'copilot'
          ? { backend, models: COPILOT_MODELS, efforts: EFFORTS, allow_custom: true, reachable: true }
          : { backend, models: ['llama3.1', 'qwen3'], efforts: [], allow_custom: true, reachable: true }
    }

    await route.fulfill({ json })
  })
}

async function captureAnalysisStarts(page: Page): Promise<StartedAnalysis[]> {
  const started: StartedAnalysis[] = []
  await page.route('**/api/analysis-runs', async (route) => {
    const body = route.request().postDataJSON() as { run_id: string; analysis: StartedAnalysis }
    started.push(body.analysis)
    await route.fulfill({
      json: {
        id: body.run_id,
        status: 'running',
        error: null,
        last_event_id: 0,
        created_at: new Date().toISOString(),
        finished_at: null,
      },
    })
  })
  await page.route('**/api/analysis-runs/*/events?*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body:
        'id: 1\nevent: start\ndata: {"backend":"copilot"}\n\n' +
        'id: 2\nevent: replace\ndata: {"text":"Done."}\n\n' +
        'id: 3\nevent: done\ndata: {"chars":5,"saved":null,"backend":"copilot"}\n\n',
    })
  })
  return started
}

function pickers(page: Page) {
  return {
    backend: page.getByRole('combobox', { name: 'Model backend' }),
    model: page.getByRole('combobox', { name: 'Model', exact: true }),
    effort: page.getByRole('combobox', { name: 'Reasoning effort' }),
  }
}

test.beforeEach(async ({ page }) => {
  await mockApi(page)
})

test('starts Copilot chats on Claude Opus 5.5 with max reasoning', async ({ page }) => {
  const started = await captureAnalysisStarts(page)
  const { model, effort } = pickers(page)

  await page.goto('/analyze')
  await expect(model).toHaveValue('claude-opus-5.5')
  await expect(model.locator('option:checked')).toHaveText('Claude Opus 5.5 · 1M context · max default')
  await expect(effort).toHaveValue('max')

  await page.getByRole('textbox', { name: 'Message' }).fill('Review my week')
  await page.getByRole('button', { name: 'Send' }).click()

  await expect.poll(() => started.length).toBe(1)
  expect(started[0]).toMatchObject({
    backend: 'copilot',
    model: 'claude-opus-5.5',
    reasoning_effort: 'max',
  })
})

test('resets a changed Copilot model when a new chat starts', async ({ page }) => {
  const { model, effort } = pickers(page)

  await page.goto('/analyze')
  await expect(model).toHaveValue('claude-opus-5.5')
  await model.selectOption('gpt-5.6-sol')
  await effort.selectOption('high')
  await expect(model).toHaveValue('gpt-5.6-sol')
  await expect(effort).toHaveValue('high')

  await page.getByRole('button', { name: 'New chat' }).click()
  await expect(model).toHaveValue('claude-opus-5.5')
  await expect(effort).toHaveValue('max')
})

test('keeps a restored chat on its saved model until a new chat starts', async ({ page }) => {
  const timestamp = '2026-08-06T20:00:00Z'
  const savedChat = {
    id: 'chat-saved',
    title: 'Saved chat',
    created_at: timestamp,
    updated_at: timestamp,
    backend: 'copilot',
    model: 'claude-opus-5',
    reasoning_effort: 'high',
    activity_ids: [],
    messages: [
      { id: 'saved-user', role: 'user', content: 'Saved question' },
      { id: 'saved-assistant', role: 'assistant', content: 'Saved answer' },
    ],
    analysis_run: null,
  }
  await page.addInitScript((chatId) => {
    localStorage.setItem('fitsift-active-chat', chatId)
  }, savedChat.id)
  await page.route('**/api/chats/*', async (route) => {
    await route.fulfill({ json: savedChat })
  })
  const { model, effort } = pickers(page)

  await page.goto('/analyze')
  await expect(page.getByText('Saved answer')).toBeVisible()
  await expect(model).toHaveValue('claude-opus-5')
  await expect(effort).toHaveValue('high')

  await page.getByRole('button', { name: 'New chat' }).click()
  await expect(page.getByText('Saved answer')).toBeHidden()
  await expect(model).toHaveValue('claude-opus-5.5')
  await expect(effort).toHaveValue('max')
})

test('does not send Copilot reasoning effort to local backends', async ({ page }) => {
  const started = await captureAnalysisStarts(page)
  const { backend, model, effort } = pickers(page)

  await page.goto('/analyze')
  await expect(effort).toHaveValue('max')
  await backend.selectOption('ollama')
  await expect(model).toHaveValue('llama3.1')
  await expect(effort).toHaveCount(0)

  await page.getByRole('textbox', { name: 'Message' }).fill('Quick check')
  await page.getByRole('button', { name: 'Send' }).click()
  await expect.poll(() => started.length).toBe(1)
  expect(started[0]).toMatchObject({ backend: 'ollama', model: 'llama3.1' })
  expect(started[0].reasoning_effort).toBeUndefined()

  await expect(backend).toBeEnabled()
  await backend.selectOption('copilot')
  await expect(model).toHaveValue('claude-opus-5.5')
  await expect(effort).toHaveValue('max')
})
