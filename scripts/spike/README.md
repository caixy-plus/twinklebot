# TwinkleBot Phase 0 Spike

This directory contains throwaway verification scripts for Phase 0 of the TwinkleBot project.

## Scripts

- `api-check.mjs`: Tests `@google/genai` Interactions API against `gemini-4-argon` and verifies the four technical questions (computer use, custom functions, multi-turn input with `store: false`, and thoughts/token usage).

## Running the Spike

Ensure `.env` exists with `GEMINI_API_KEY`:

```bash
node --env-file=.env scripts/spike/api-check.mjs
```

## Summary of Findings

1. **Computer Use on `gemini-4-argon`**:
   - `gemini-4-argon` is recognized by the API, but requires a paid tier (Free Tier has a limit of 0 input tokens/minute, returning `429 Rate limit exceeded`).
   - In `@google/genai` Interactions API, computer use tools are declared via `{ type: "computer_use", environment: "desktop" }` and action invocations are returned as standard `function_call` steps (`click`, `type`, etc.).

2. **Custom Function Tool & Result Shapes**:
   - Declared with `{ type: "function", name: "...", description: "...", parameters: {...} }`.
   - Results sent back via `{ type: "function_result", call_id: "...", name: "...", result: "..." }`.
   - Images cannot be placed directly in `function_result.result` (the API rejects them with `400 Request contains an invalid argument`) and must be sent as an immediately following `user_input` step with `content: [{ type: "image", data: "...", mime_type: "image/png" }]`.

3. **Multi-Turn Steps with `store: false`**:
   - `InteractionsInput` accepts `Array<Step>` containing the full conversation history.
   - Any previous `thought` steps must retain their opaque `signature` fields.
   - Fallback is `store: true` with `previous_interaction_id` (spec §6.1).

4. **Thoughts and Token Usage**:
   - Thought summaries appear in `steps` with `type: "thought"`, `summary: [{ type: "text", text: "..." }]`, and `signature`.
   - Token usage appears on the interaction root object under `usage` (`total_input_tokens`, `total_output_tokens`, `total_thought_tokens`, `input_tokens_by_modality`, `output_tokens_by_modality`).

5. **Desktop Browser (`DISPLAY=:1`)**:
   - Ubuntu snap Firefox (`/usr/bin/firefox`) successfully installed and launched a window on `DISPLAY=:1` (1440x900).
   - Launch command: `DISPLAY=:1 nohup firefox >/dev/null 2>&1 &` (or `DISPLAY=:1 firefox <url>`).

6. **Chinese + Emoji Input**:
   - Verified via `xclip -selection clipboard` + `xdotool key --clearmodifiers ctrl+v` after installing `fonts-noto-cjk` and `fonts-noto-color-emoji`.
   - Text `你好 TwinkleBot 🙂` rendered clearly in the address bar without tofu boxes.
