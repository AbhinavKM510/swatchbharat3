/**
 * Microphone button that dictates a number into a field.
 *
 * Behaviour that matters for the target user:
 *
 * - **The value always lands in a visible input.** Voice never submits anything. The
 *   worker sees the number, in a large tabular font, and can correct it. Given that
 *   speech recognition quality on a cheap Android in a noisy courtyard is unpredictable,
 *   confirmation is not optional.
 *
 * - **Unsupported is a first-class state, not an error.** Firefox on Android has no
 *   SpeechRecognition at all. The button hides itself and typing continues to work, rather
 *   than presenting a control that does nothing.
 *
 * - **Failure tells the worker what to do next.** "I did not catch a number, please try
 *   again" and "type it instead", not "SpeechRecognitionError: no-speech".
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '@/i18n';
import {
  isSpeechRecognitionSupported,
  startNumberDictation,
  type DictationSession,
  type SpeechErrorCode,
} from '@/lib/speech';

export interface VoiceInputButtonProps {
  /** Called with the parsed number once the worker finishes speaking. */
  onValue: (value: number) => void;
  /** Announced/displayed prompt, e.g. "Say the blood sugar reading". */
  promptKey:
    | 'voice.speakAge'
    | 'voice.speakGlucose'
    | 'voice.speakBp'
    | 'voice.speakHeight'
    | 'voice.speakWeight'
    | 'voice.speakNumber';
  allowDecimal?: boolean;
  disabled?: boolean;
  /** Accessible name, since the button itself is only a microphone glyph. */
  fieldLabel: string;
}

export function VoiceInputButton({
  onValue,
  promptKey,
  allowDecimal = false,
  disabled = false,
  fieldLabel,
}: VoiceInputButtonProps) {
  const { t, speechLocale } = useI18n();
  const [supported] = useState(() => isSpeechRecognitionSupported());
  const [listening, setListening] = useState(false);
  const [status, setStatus] = useState<{ text: string; isError: boolean } | null>(null);
  const sessionRef = useRef<DictationSession | null>(null);

  useEffect(
    () => () => {
      // Abort rather than stop on unmount: stop() would still fire a final result into a
      // component that no longer exists.
      sessionRef.current?.abort();
    },
    [],
  );

  const describeError = useCallback(
    (code: SpeechErrorCode) => {
      switch (code) {
        case 'unsupported':
          return t('voice.unsupported');
        case 'permission-denied':
          return t('voice.permissionDenied');
        case 'no-speech':
        case 'no-number':
          return t('voice.noNumber');
        case 'aborted':
          return '';
        default:
          return t('voice.error');
      }
    },
    [t],
  );

  const start = useCallback(() => {
    if (listening) {
      sessionRef.current?.stop();
      return;
    }

    setStatus({ text: t('voice.listening'), isError: false });

    sessionRef.current = startNumberDictation(
      speechLocale,
      {
        onStart: () => setListening(true),
        onInterim: (transcript) => {
          if (transcript.trim()) setStatus({ text: t('voice.heard', { text: transcript }), isError: false });
        },
        onFinal: ({ transcript, parsed }) => {
          setListening(false);
          if (parsed) {
            onValue(parsed.value);
            setStatus({ text: t('voice.heard', { text: String(parsed.value) }), isError: false });
          } else {
            // Deliberately does NOT fill the field. A half-understood number is worse than
            // no number: see the safety note in lib/speech.ts.
            setStatus({
              text: transcript ? `${t('voice.noNumber')} (${transcript})` : t('voice.noNumber'),
              isError: true,
            });
          }
        },
        onError: (code) => {
          setListening(false);
          const text = describeError(code);
          setStatus(text ? { text, isError: true } : null);
        },
        onEnd: () => setListening(false),
      },
      { allowDecimal },
    );
  }, [allowDecimal, describeError, listening, onValue, speechLocale, t]);

  // No API on this browser: say nothing, show nothing, let them type.
  if (!supported) return null;

  return (
    <>
      <button
        type="button"
        className={`voice-button${listening ? ' voice-button--listening' : ''}`}
        onClick={start}
        disabled={disabled}
        aria-label={`${listening ? t('voice.stop') : t('voice.start')}: ${fieldLabel}`}
        aria-pressed={listening}
        title={t(promptKey)}
      >
        <span aria-hidden="true">{listening ? '\u25a0' : '\u{1F3A4}'}</span>
      </button>
      {status ? (
        <p
          className={`voice-status${status.isError ? ' voice-status--error' : ''}`}
          role="status"
          aria-live="polite"
          style={{ flexBasis: '100%' }}
        >
          {status.text}
        </p>
      ) : null}
    </>
  );
}
