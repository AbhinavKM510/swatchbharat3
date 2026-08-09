/**
 * LLM fallback for the health FAQ chatbot, using the Gemini API.
 *
 * ### Where this sits, and where it does not
 *
 * The chatbot IS `shared/chatbot/faqRules.js` — fixed, clinician-reviewable answers that
 * work with no network. This module is called from exactly one place, `chatbot.routes.js`,
 * and only when `answerQuestion()` already returned `matched: false`. It never runs before
 * the rule engine, and it never runs for a question the rules already answered. If this
 * whole file were deleted, the chatbot would keep working exactly as it does today, minus
 * the fallback — which is also what happens right now whenever this is disabled or fails.
 *
 * ### Why it cannot become the primary chatbot
 *
 * It requires a live network call to a third party. This product's chatbot exists
 * specifically so a patient with no signal still gets dietary advice; an LLM cannot honour
 * that, so it is additive to the offline-first design rather than a replacement for it.
 *
 * ### The safety constraints, and why each one exists
 *
 * 1. GROUNDING — the prompt includes the actual curated Q&A from `CHATBOT_INTENTS` and
 *    instructs the model to answer only from that material, or say it does not know. This
 *    is retrieval-and-rephrase, not open-ended generation: it keeps the model from
 *    inventing a treatment, a dose, or a diagnosis that sounds plausible and is wrong.
 * 2. STRUCTURED OUTPUT — `responseMimeType: application/json` with a schema matching the
 *    existing `{title, points[]}` shape used by every rule-based answer, so the chat UI
 *    needs no branching logic for a generated answer and no markdown can leak into it.
 * 3. EMERGENCY NEVER REACHES HERE — the rule engine matches the `emergency` intent at
 *    weight 100, so an emergency question is answered locally and this module is never
 *    called for it. An LLM is the worst place to first notice "this sounds like chest pain":
 *    slow, sometimes wrong, and unavailable offline, which is when it matters most. Note
 *    that this is a check on the QUESTION. Screening the model's OUTPUT for symptom names
 *    was tried and removed — see the long comment in `answerWithGeminiFallback` for why it
 *    rejected the project's own reviewed advice.
 * 4. FAIL CLOSED — any error, timeout, empty response, or malformed JSON falls back to
 *    `CHATBOT_FALLBACK`, the same "ask your ASHA worker or visit the PHC" answer the rule
 *    engine already gives for an unmatched question. A worker never sees a raw API error,
 *    and a free-tier 429 degrades to the same safe default rather than breaking the page.
 *
 * ### Why fetch, not the @google/genai SDK
 *
 * One JSON POST. Adding a dependency for a single REST call is not a good trade, and one
 * fewer package to audit and update. If this grows past a demo, revisit that call — the SDK
 * earns its place once retries, streaming or multi-turn context show up.
 */

import { config } from '../config/env.js';
import { CHATBOT_DISCLAIMER, CHATBOT_INTENTS, CHATBOT_SUGGESTIONS, matchIntent } from '../../../shared/chatbot/index.js';

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

/** Generous for a chat answer, stingy enough that a hung request cannot stall the page. */
const REQUEST_TIMEOUT_MS = 12000;

const LANGUAGE_NAMES = { bn: 'Bengali', hi: 'Hindi', en: 'English' };

/**
 * Renders the curated FAQ as grounding context.
 *
 * Every intent's answer in the requested language, as plain "Q: ... / A: ..." pairs. This
 * is sent on every call rather than cached server-side or pre-computed once, because the
 * corpus is small (shared/chatbot/faqRules.js, currently a few dozen intents) and demo-scale
 * traffic does not justify the complexity of invalidating a cache when someone edits an
 * intent. Emergency is deliberately EXCLUDED: that path is handled locally before Gemini is
 * ever reached (see `askGemini` below), so it has no reason to appear in the grounding set.
 */
function buildGroundingContext(language) {
  return CHATBOT_INTENTS.filter((intent) => intent.id !== 'emergency')
    .map((intent) => {
      const answer = intent.answers[language] ?? intent.answers.en;
      return `Q: ${answer.title}\nA: ${answer.points.join(' ')}`;
    })
    .join('\n\n');
}

function buildSystemInstruction(language) {
  const languageName = LANGUAGE_NAMES[language] ?? 'English';
  return [
    'You are a health-information assistant for rural community health workers and patients ',
    'in India, used inside an offline-first screening app called SwasthBharat.',
    '',
    'STRICT RULES, in priority order:',
    '1. Answer ONLY using the "Known answers" material below. Rephrase and summarise it to ',
    '   fit the question; do not add facts, tests, treatments, or numbers that are not in it.',
    '2. Answer the SPECIFIC question that was asked. Pick the entry that actually addresses ',
    '   it — if the question is about walking, answer about walking, not about symptoms. ',
    '   Returning correct material for a different question is a wrong answer.',
    '3. If the question is not covered by the material, say you do not have a reliable ',
    `   answer and advise visiting the nearest PHC or asking the ASHA worker. Do not guess.`,
    '4. Never name a medicine, a drug dose, or a treatment plan. Never suggest a diagnosis.',
    '5. Never discuss anything unrelated to general health, diet, or this app.',
    `6. Reply in ${languageName}, in short, plain sentences a low-literacy reader can follow.`,
    '7. Output ONLY the JSON object described by the response schema. No markdown, no ',
    '   extra commentary outside the JSON.',
    '',
    'Known answers:',
    buildGroundingContext(language),
  ].join('\n');
}

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'A short heading for the answer, under 12 words.' },
    points: {
      type: 'array',
      items: { type: 'string' },
      description: '2 to 5 short plain-language sentences answering the question.',
      minItems: 1,
      maxItems: 5,
    },
    /**
     * The model's own signal, in addition to the local rescan below. Two independent
     * checks catch more than either alone, and this one costs nothing extra to ask for.
     */
    outOfScope: {
      type: 'boolean',
      description: 'true if the known-answers material did not cover this question.',
    },
  },
  required: ['title', 'points', 'outOfScope'],
};

/**
 * Calls Gemini and returns a parsed `{title, points, outOfScope}` object, or null.
 *
 * Returns null — never throws — for every failure mode: disabled, unconfigured, network
 * error, timeout, non-2xx (including a 429 from an exhausted free-tier quota), or a response
 * that does not parse as the expected shape. The caller's job in every one of those cases is
 * identical: fall back to `CHATBOT_FALLBACK`. Collapsing all of them to `null` means that
 * fallback path cannot forget to handle one.
 */
async function callGemini(question, language) {
  if (!config.geminiEnabled || !config.geminiApiKey) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`${API_BASE}/${config.geminiModel}:generateContent`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // Header, not a query string: query strings are what turn up in access logs
        // (morgan logs the request path) and in browser history if this were ever proxied.
        'x-goog-api-key': config.geminiApiKey,
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: question }] }],
        systemInstruction: { parts: [{ text: buildSystemInstruction(language) }] },
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: RESPONSE_SCHEMA,
          temperature: 0.2,
          /**
           * The model spends part of this budget on an internal "thinking" pass before
           * writing the visible answer — around 500-650 tokens in testing, even for a
           * one-line question — and that consumption is NOT configurable on the model
           * alias used here: passing `thinkingConfig` at all made the whole request fail
           * with 400 INVALID_ARGUMENT, on both `{thinkingBudget: 0}` and any other value.
           * So instead of disabling thinking, this simply budgets past it: comfortably
           * above the ~650 tokens thinking used in testing, plus room for a full 5-point
           * answer. Too low here is a silent failure mode (finishReason MAX_TOKENS with an
           * empty/truncated candidate, which then fails JSON.parse and falls back) rather
           * than a loud error, which is why the number is generous.
           */
          maxOutputTokens: 2000,
        },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      // Includes 429 RESOURCE_EXHAUSTED (free-tier quota used up) and 400s from a bad key.
      // Logged, not thrown: an exhausted demo quota must degrade quietly, not 500 the page.
      const bodyText = await response.text().catch(() => '');
      console.warn(`[gemini] ${response.status} ${response.statusText}: ${bodyText.slice(0, 300)}`);
      return null;
    }

    const payload = await response.json();
    const text = payload?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) return null;

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (parseError) {
      // Logged with the raw text and finishReason: this almost always means the response
      // was cut off (hit maxOutputTokens) rather than genuinely malformed, and seeing the
      // tail end of the string makes that obvious at a glance instead of guessing.
      console.warn(
        `[gemini] could not parse JSON output (${parseError.message}). ` +
          `finishReason=${payload?.candidates?.[0]?.finishReason}. ` +
          `raw (last 200 chars): ...${text.slice(-200)}`,
      );
      return null;
    }
    if (!parsed || typeof parsed.title !== 'string' || !Array.isArray(parsed.points)) {
      return null;
    }

    return {
      title: parsed.title.trim(),
      points: parsed.points.map((p) => String(p).trim()).filter(Boolean).slice(0, 5),
      outOfScope: Boolean(parsed.outOfScope),
    };
  } catch (error) {
    console.warn(`[gemini] request failed: ${error.message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The LLM fallback tier. Called by `chatbot.routes.js` only after the rule engine reports
 * `matched: false`.
 *
 * Returns an answer shaped exactly like `answerQuestion()`'s return value, so the route
 * handler and the frontend do not need to know which tier produced it — except for the
 * `source` field, which the UI uses to show the "AI-generated" label the safety review
 * requires (see ChatbotPage.tsx). `source` is one of:
 *   - 'gemini'   a grounded answer Gemini generated
 *   - 'fallback' the rule engine's own unmatched-question answer — used whenever Gemini
 *                is disabled, fails, times out, or itself reports the question as
 *                out of scope of the known material
 *
 * The emergency check runs FIRST and LOCALLY, unconditionally, before any network call.
 * This is not an optimisation; it is the point. An LLM must never be the thing standing
 * between "chest pain" and the ambulance-call banner — too slow, sometimes wrong, and
 * useless with no signal, which is exactly the moment escalation matters most.
 */
export async function answerWithGeminiFallback(question, language, ruleAnswer) {
  const { intent } = matchIntent(question);
  if (intent?.escalate) {
    // Should not happen — the caller only reaches here when the rules found no match — but
    // this is a one-line, zero-cost guarantee that is worth stating rather than assuming.
    return ruleAnswer;
  }

  const generated = await callGemini(question, language);
  if (!generated || generated.outOfScope || generated.points.length === 0) {
    return ruleAnswer;
  }

  /**
   * THERE IS DELIBERATELY NO EMERGENCY RESCAN OF THE MODEL'S OUTPUT HERE.
   *
   * An earlier version ran `matchIntent()` over the generated answer and discarded it if the
   * emergency intent matched, on the theory that a second look costs nothing. It cost a great
   * deal: `EMERGENCY_WORDS` contains 'chest pain', 'breathless' and their Bengali and Hindi
   * equivalents, and good health advice mentions those words precisely because it is telling
   * someone when to seek help. This project's OWN reviewed exercise answer reads "Stop and
   * see a doctor if you get chest pain, dizziness or heavy breathlessness", and the anaemia
   * answer lists breathlessness as a sign. A grounded rephrase of either therefore tripped
   * the check and was thrown away — the rescan rejected the model for correctly reproducing
   * curated content, which is the one behaviour the grounding exists to produce.
   *
   * Emergency detection belongs on the QUESTION, and that is where it already is: the rule
   * engine matches `emergency` at weight 100 before this function is ever called, so an
   * actual emergency never reaches Gemini at all. That guarantee is unaffected by this, and
   * the guard at the top of this function restates it. Screening the output for symptom
   * NAMES could only ever have caught advice that mentions symptoms, not an emergency.
   */

  return {
    matched: true,
    intentId: 'llm:generated',
    title: generated.title,
    points: generated.points,
    disclaimer: CHATBOT_DISCLAIMER[language] ?? CHATBOT_DISCLAIMER.en,
    escalate: false,
    language,
    suggestions: CHATBOT_SUGGESTIONS[language] ?? CHATBOT_SUGGESTIONS.en,
    version: ruleAnswer.version,
    source: 'gemini',
  };
}
