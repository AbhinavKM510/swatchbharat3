/**
 * Rule-based health FAQ.
 *
 * ### Why it answers locally first
 *
 * The rules live in `@shared/chatbot`, which is bundled into the app. So the chatbot is
 * answered on-device, instantly, with no request. The API call that follows is
 * fire-and-forget analytics — it exists so the team can read the questions the rules failed
 * to match and write new intents.
 *
 * That ordering means a patient standing in a courtyard with no signal still gets dietary
 * advice. Making the answer depend on a round trip would have made the single most
 * network-dependent-looking feature the least useful one in the field.
 *
 * ### Why it is rule-based and not a language model
 *
 * Three reasons, in order: it must work offline; a health bot for low-literacy users must
 * never improvise medical advice; and every answer here is a fixed string a clinician can
 * review before it ships.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { Notice } from '@/components/ui';
import { useI18n } from '@/i18n';
import { answerQuestion, CHATBOT_SUGGESTIONS } from '@shared/chatbot/index.js';
import type { ChatbotAnswer, ChatbotLanguage } from '@shared/chatbot/index.js';
import { api } from '@/lib/api';
import { saveChatQuestion } from '@/lib/db';
import {
  isSpeechRecognitionSupported,
  startNumberDictation,
} from '@/lib/speech';
import { useAuth } from '@/state/AuthContext';
import { useSyncState } from '@/state/useSyncState';

interface Turn {
  id: number;
  question: string;
  answer: ChatbotAnswer;
  answeredOffline: boolean;
}

export function ChatbotPage() {
  const { t, language, speechLocale } = useI18n();
  const { user } = useAuth();
  const sync = useSyncState();

  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState('');
  const [listening, setListening] = useState(false);
  const nextId = useRef(1);
  const logEnd = useRef<HTMLDivElement | null>(null);
  const voiceSupported = useRef(isSpeechRecognitionSupported());

  useEffect(() => {
    logEnd.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [turns]);

  const ask = useCallback(
    async (question: string) => {
      const trimmed = question.trim();
      if (!trimmed) return;

      // Answer immediately from the bundled rules. No await, no network.
      const answer = answerQuestion(trimmed, language as ChatbotLanguage);
      const wasOffline = !sync.online;

      setTurns((current) => [
        ...current,
        { id: nextId.current++, question: trimmed, answer, answeredOffline: wasOffline },
      ]);
      setDraft('');

      // Log it. Queued locally when offline so the unmatched-question backlog stays complete;
      // failures here are swallowed because analytics must never break health advice.
      if (wasOffline) {
        await saveChatQuestion({
          userId: user?.id ?? null,
          question: trimmed,
          language: answer.language,
          intentId: answer.intentId,
          matched: answer.matched,
          askedAt: new Date().toISOString(),
          answeredOffline: true,
          synced: 0,
        }).catch(() => undefined);
      } else {
        void api.chatbot.ask(trimmed, language as ChatbotLanguage).catch(() => undefined);
      }
    },
    [language, sync.online, user],
  );

  /**
   * Voice for the chatbot reuses the dictation helper but takes the raw transcript rather
   * than a parsed number — a question is free text, so there is nothing to validate.
   */
  const startVoiceQuestion = useCallback(() => {
    if (listening) return;
    setListening(true);

    startNumberDictation(speechLocale, {
      onInterim: (transcript) => setDraft(transcript),
      onFinal: ({ transcript }) => {
        setListening(false);
        if (transcript.trim()) {
          setDraft(transcript);
          void ask(transcript);
        }
      },
      onError: () => setListening(false),
      onEnd: () => setListening(false),
    });
  }, [ask, listening, speechLocale]);

  const suggestions = CHATBOT_SUGGESTIONS[language as ChatbotLanguage] ?? CHATBOT_SUGGESTIONS.en;

  return (
    <AppShell title={t('chatbot.title')} subtitle={t('chatbot.subtitle')}>
      <div className="stack">
        {turns.length === 0 ? (
          <Notice tone="info">{t('chatbot.empty')}</Notice>
        ) : null}

        <div className="chat-log">
          {turns.map((turn) => (
            <div key={turn.id} className="chat-log" style={{ gap: 'var(--space-2)' }}>
              <div className="chat-bubble chat-bubble--user">{turn.question}</div>

              <div
                className={`chat-bubble ${
                  turn.answer.escalate ? 'chat-bubble--emergency' : 'chat-bubble--bot'
                }`}
                // Emergency answers interrupt; ordinary ones are announced politely.
                role={turn.answer.escalate ? 'alert' : 'status'}
              >
                <div className="chat-bubble__title">
                  {turn.answer.escalate ? `\u26a0 ${turn.answer.title}` : turn.answer.title}
                  {/*
                    Only ever set by the server's Gemini fallback (see ChatbotAnswer.source
                    in shared/chatbot/index.d.ts) — never by the local rule engine, which has
                    no network and cannot produce it. So this badge is never shown for an
                    offline answer or a clinician-reviewed one, only for a generated one.
                  */}
                  {turn.answer.source === 'gemini' ? (
                    <span className="chat-bubble__ai-badge">{t('chatbot.aiGenerated')}</span>
                  ) : null}
                </div>

                <ul className="chat-bubble__points">
                  {turn.answer.points.map((point) => (
                    <li key={point}>{point}</li>
                  ))}
                </ul>

                {turn.answer.escalate ? (
                  <a
                    className="button button--danger button--block"
                    style={{ marginTop: 'var(--space-3)' }}
                    href="tel:108"
                  >
                    {t('chatbot.callAmbulance')}
                  </a>
                ) : null}

                <div className="chat-bubble__disclaimer">
                  {turn.answer.disclaimer}
                  {turn.answeredOffline ? ` \u00b7 ${t('chatbot.answeredOffline')}` : ''}
                </div>
              </div>
            </div>
          ))}
          <div ref={logEnd} />
        </div>

        {/* Tappable starter questions: typing Bengali on a phone keyboard is slow, and a
            low-literacy user may not be able to compose a question at all. */}
        <section>
          <h2 className="section-title">{t('chatbot.suggestionsTitle')}</h2>
          <div className="suggestion-row">
            {suggestions.map((suggestion) => (
              <button
                key={suggestion}
                type="button"
                className="suggestion"
                onClick={() => void ask(suggestion)}
              >
                {suggestion}
              </button>
            ))}
          </div>
        </section>

        <form
          className="chat-composer"
          onSubmit={(event) => {
            event.preventDefault();
            void ask(draft);
          }}
        >
          <label className="grow">
            <span className="sr-only">{t('chatbot.placeholder')}</span>
            <input
              className="input"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder={t('chatbot.placeholder')}
              enterKeyHint="send"
            />
          </label>

          {voiceSupported.current ? (
            <button
              type="button"
              className={`voice-button${listening ? ' voice-button--listening' : ''}`}
              onClick={startVoiceQuestion}
              aria-label={t('chatbot.listen')}
              aria-pressed={listening}
            >
              <span aria-hidden="true">{listening ? '\u25a0' : '\u{1F3A4}'}</span>
            </button>
          ) : null}

          <button type="submit" className="button" disabled={!draft.trim()}>
            {t('chatbot.send')}
          </button>
        </form>
      </div>
    </AppShell>
  );
}
