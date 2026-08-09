/**
 * Voice input for numeric fields, using the browser-native Web Speech API.
 *
 * No API key, no install, no cloud service to pay for or fail — which is the whole reason
 * it was chosen. It also means quality varies by device and there is nothing we can do
 * about that, so every voice entry lands in a visible input the worker confirms.
 *
 * ### The safety rule that shapes this file
 *
 * A mis-heard number in a medical form is not a cosmetic bug. "165" heard as "100" changes
 * a HIGH RISK result into a LOW RISK one. So the parser is built to **fail closed**:
 *
 *   - Digits in the transcript are trusted (Latin, Bengali and Devanagari digits are all
 *     handled), because speech engines return numerals for spoken numbers in most cases.
 *   - Word-based parsing is only attempted when the transcript contains no digits, and it
 *     is accepted **only when every single token is recognised**. If one token is unknown,
 *     the whole parse is rejected.
 *
 * That last rule is the important one. Bengali "একশো পঁয়ষট্টি" (165) is "hundred" plus
 * "sixty-five". A lenient parser that understood "একশো" and skipped the unknown word would
 * confidently fill in **100** — a plausible-looking, silently wrong vital sign. Refusing to
 * parse and asking the worker to repeat or type is strictly safer than guessing.
 *
 * ### Known limitation, stated plainly
 *
 * The Bengali and Hindi word tables cover 0-20, the tens, and hundred. The irregular forms
 * between 21 and 99 are deliberately NOT included: transcribing ~160 irregular numerals
 * across two languages by hand is exactly the kind of task where a single wrong entry
 * becomes a wrong blood sugar reading. Those utterances fall back to digit recognition
 * (which usually works) or to typing. Extending the tables should be done with a native
 * speaker verifying every row.
 */

export type SpeechErrorCode =
  | 'unsupported'
  | 'permission-denied'
  | 'no-speech'
  | 'no-number'
  | 'aborted'
  | 'network'
  | 'unknown';

export interface ParsedNumber {
  value: number;
  /** How it was read: straight from digits, or reconstructed from number words. */
  source: 'digits' | 'words';
  transcript: string;
}

/* Digit handling ---------------------------------------------------------- */

const BENGALI_ZERO = 0x09e6; // ০
const DEVANAGARI_ZERO = 0x0966; // ०

/**
 * Unicode canonical composition.
 *
 * Indic scripts encode several letters two ways, and both are valid: Bengali `ড়` is either
 * precomposed U+09DC or decomposed U+09A1 + U+09BC (DA + NUKTA), and `য়` is either U+09DF
 * or U+09AF + U+09BC. Devanagari has the same split for `ज़`, `ड़`, `फ़` and others.
 *
 * Which form arrives depends on the keyboard, the OS and the speech engine — none of which
 * we control. Comparing an un-normalised transcript against an un-normalised word table
 * therefore misses real matches: "কুড়ি" (twenty) failed to parse for exactly this reason.
 *
 * NFC is applied to BOTH the transcript and every keyword, so the two always meet in the
 * same form.
 */
function toCanonicalForm(text: string): string {
  return text.normalize('NFC');
}

/** Rewrites Bengali and Devanagari digits as Latin digits, leaving everything else alone. */
export function normaliseDigits(text: string): string {
  return Array.from(text)
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      if (code >= BENGALI_ZERO && code <= BENGALI_ZERO + 9) return String(code - BENGALI_ZERO);
      if (code >= DEVANAGARI_ZERO && code <= DEVANAGARI_ZERO + 9) return String(code - DEVANAGARI_ZERO);
      return character;
    })
    .join('');
}

/* Word tables ------------------------------------------------------------- */

/**
 * Number words, keyed by the word itself.
 *
 * Only forms verified as standard are listed. See the limitation note at the top of the
 * file: 21-99 irregulars are intentionally absent rather than guessed at.
 */
const NUMBER_WORDS: Record<string, number> = {
  // English
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90,

  // Hindi 0-20
  'शून्य': 0, 'एक': 1, 'दो': 2, 'तीन': 3, 'चार': 4, 'पाँच': 5, 'पांच': 5, 'छह': 6, 'छः': 6,
  'सात': 7, 'आठ': 8, 'नौ': 9, 'दस': 10, 'ग्यारह': 11, 'बारह': 12, 'तेरह': 13, 'चौदह': 14,
  'पंद्रह': 15, 'पन्द्रह': 15, 'सोलह': 16, 'सत्रह': 17, 'अठारह': 18, 'उन्नीस': 19, 'बीस': 20,
  // Hindi tens
  'तीस': 30, 'चालीस': 40, 'पचास': 50, 'साठ': 60, 'सत्तर': 70, 'अस्सी': 80, 'नब्बे': 90,

  // Bengali 0-20
  'শূন্য': 0, 'এক': 1, 'দুই': 2, 'তিন': 3, 'চার': 4, 'পাঁচ': 5, 'ছয়': 6, 'সাত': 7, 'আট': 8,
  'নয়': 9, 'দশ': 10, 'এগারো': 11, 'বারো': 12, 'তেরো': 13, 'চোদ্দ': 14, 'পনেরো': 15,
  'ষোলো': 16, 'সতেরো': 17, 'আঠারো': 18, 'উনিশ': 19, 'বিশ': 20, 'কুড়ি': 20,
  // Bengali tens
  'ত্রিশ': 30, 'চল্লিশ': 40, 'পঞ্চাশ': 50, 'ষাট': 60, 'সত্তর': 70, 'আশি': 80, 'নব্বই': 90,
};

/**
 * Number words keyed in canonical (NFC) form, built once from the table above.
 *
 * Lookups must go through this map rather than `NUMBER_WORDS` directly, so that a keyword
 * typed in decomposed form in the source still matches a composed transcript.
 */
const NUMBER_WORDS_CANONICAL: Record<string, number> = Object.fromEntries(
  Object.entries(NUMBER_WORDS).map(([word, value]) => [toCanonicalForm(word), value]),
);

/** Multiplier words. `একশো` / `सौ` / `hundred` all mean x100. */
const HUNDRED_WORDS = new Set(
  ['hundred', 'सौ', 'शो', 'শো', 'শত', 'একশো', 'একশ', 'सौ।'].map(toCanonicalForm),
);

/** Tokens that carry no numeric meaning and can be ignored without ambiguity. */
const IGNORABLE_WORDS = new Set(
  [
    'and', 'point', 'is', 'the', 'a',
    'और', 'दशमलव', 'है', 'का', 'की',
    'আর', 'ও', 'দশমিক', 'হল', 'হবে',
  ].map(toCanonicalForm),
);

/**
 * Bengali "একশো" is written as one word meaning exactly 100, so it is both a multiplier and
 * a standalone value. Treat it as 100 when it is the only numeric token.
 */
const STANDALONE_HUNDRED = new Set(['একশো', 'একশ', 'সৌ'].map(toCanonicalForm));

/* Parsing ----------------------------------------------------------------- */

/**
 * Extracts a number from a speech transcript, or returns null if it cannot be trusted.
 *
 * @param rawTranscript what the speech engine heard
 * @param options.allowDecimal weight can be 62.5; blood sugar cannot be 165.5 on a
 *   glucometer, so the caller decides.
 */
export function parseSpokenNumber(
  rawTranscript: string,
  options: { allowDecimal?: boolean } = {},
): ParsedNumber | null {
  const { allowDecimal = false } = options;
  // NFC first: the word tables are canonical, so the transcript must be too.
  const transcript = toCanonicalForm(rawTranscript).trim();
  if (!transcript) return null;

  const normalised = normaliseDigits(transcript);

  /* Path 1: digits present. Trust them. -------------------------------- */
  const digitPattern = allowDecimal ? /\d+(?:[.,]\d+)?/g : /\d+/g;
  const digitMatches = normalised.match(digitPattern);

  if (digitMatches && digitMatches.length > 0) {
    // More than one number in one utterance is ambiguous ("one six five" can arrive as
    // "1 6 5"). Joining them would invent a value, so refuse and ask again.
    if (digitMatches.length > 1) return null;

    const value = Number.parseFloat(digitMatches[0].replace(',', '.'));
    if (!Number.isFinite(value)) return null;
    return { value, source: 'digits', transcript };
  }

  /* Path 2: no digits. Words only, and only if fully understood. -------- */
  const tokens = normalised
    .toLowerCase()
    .replace(/[?!.,;:()\[\]{}"'`\u0964]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .filter((token) => !IGNORABLE_WORDS.has(token));

  if (tokens.length === 0) return null;

  let total = 0;
  let current = 0;
  let sawNumber = false;

  for (const token of tokens) {
    if (HUNDRED_WORDS.has(token)) {
      if (current === 0 && STANDALONE_HUNDRED.has(token)) {
        // "একশো" alone is 100, and "একশো পাঁচ" is 105.
        current = 100;
      } else if (current === 0) {
        // "hundred" with nothing before it is not a number we can reconstruct.
        return null;
      } else {
        current *= 100;
      }
      sawNumber = true;
      continue;
    }

    const wordValue = NUMBER_WORDS_CANONICAL[token];
    if (wordValue === undefined) {
      // THE SAFETY RULE: one unrecognised token invalidates the whole parse. Partially
      // understanding "একশো পঁয়ষট্টি" (165) as 100 would be a silently wrong vital sign.
      return null;
    }

    // Additive within a hundred group: "একশো পাঁচ" -> 100 + 5.
    current += wordValue;
    sawNumber = true;
  }

  if (!sawNumber) return null;
  total += current;

  return { value: total, source: 'words', transcript };
}

/* Recognition ------------------------------------------------------------- */

/** Minimal typings: the Web Speech API is still unprefixed-and-prefixed and not in lib.dom. */
interface SpeechRecognitionAlternativeLike {
  transcript: string;
  confidence: number;
}
interface SpeechRecognitionResultLike {
  readonly length: number;
  isFinal: boolean;
  [index: number]: SpeechRecognitionAlternativeLike;
}
interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: { readonly length: number; [index: number]: SpeechRecognitionResultLike };
}
interface SpeechRecognitionErrorEventLike {
  error: string;
  message?: string;
}
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
}
type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

function getRecognitionConstructor(): SpeechRecognitionConstructor | null {
  if (typeof window === 'undefined') return null;
  const candidate =
    (window as unknown as { SpeechRecognition?: SpeechRecognitionConstructor }).SpeechRecognition ??
    (window as unknown as { webkitSpeechRecognition?: SpeechRecognitionConstructor })
      .webkitSpeechRecognition;
  return candidate ?? null;
}

export function isSpeechRecognitionSupported(): boolean {
  return getRecognitionConstructor() !== null;
}

export interface DictationHandlers {
  /** Fires with each interim transcript, so the UI can show what is being heard. */
  onInterim?: (transcript: string) => void;
  /** Fires once with the final transcript and the parsed value (null if untrustworthy). */
  onFinal: (result: { transcript: string; parsed: ParsedNumber | null }) => void;
  onError: (code: SpeechErrorCode, detail?: string) => void;
  onStart?: () => void;
  onEnd?: () => void;
}

export interface DictationSession {
  stop: () => void;
  abort: () => void;
}

/**
 * Starts a one-shot numeric dictation.
 *
 * @param locale BCP-47 tag, e.g. `bn-IN`, `hi-IN`, `en-IN`
 */
export function startNumberDictation(
  locale: string,
  handlers: DictationHandlers,
  options: { allowDecimal?: boolean } = {},
): DictationSession | null {
  const Recognition = getRecognitionConstructor();
  if (!Recognition) {
    handlers.onError('unsupported');
    return null;
  }

  const recognition = new Recognition();
  recognition.lang = locale;
  // One value per tap: continuous mode on a shared field phone picks up ambient
  // conversation and produces surprising values.
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.maxAlternatives = 3;

  let finished = false;

  recognition.onstart = () => handlers.onStart?.();

  recognition.onresult = (event) => {
    const result = event.results[event.results.length - 1];
    if (!result) return;

    if (!result.isFinal) {
      handlers.onInterim?.(result[0]?.transcript ?? '');
      return;
    }

    // Try every alternative the engine offers, best-ranked first, and take the first one
    // that yields a trustworthy number. A lower-ranked alternative containing clean digits
    // beats a top-ranked one that cannot be parsed.
    let parsed: ParsedNumber | null = null;
    let transcript = result[0]?.transcript ?? '';

    for (let index = 0; index < result.length; index += 1) {
      const alternative = result[index]?.transcript ?? '';
      const attempt = parseSpokenNumber(alternative, options);
      if (attempt) {
        parsed = attempt;
        transcript = alternative;
        break;
      }
    }

    finished = true;
    handlers.onFinal({ transcript, parsed });
  };

  recognition.onerror = (event) => {
    finished = true;
    switch (event.error) {
      case 'not-allowed':
      case 'service-not-allowed':
        handlers.onError('permission-denied', event.message);
        break;
      case 'no-speech':
        handlers.onError('no-speech', event.message);
        break;
      case 'aborted':
        handlers.onError('aborted', event.message);
        break;
      case 'network':
        handlers.onError('network', event.message);
        break;
      default:
        handlers.onError('unknown', event.error);
    }
  };

  recognition.onend = () => {
    // Ended without a final result: the engine heard nothing usable.
    if (!finished) handlers.onError('no-speech');
    handlers.onEnd?.();
  };

  try {
    recognition.start();
  } catch (error) {
    handlers.onError('unknown', error instanceof Error ? error.message : undefined);
    return null;
  }

  return {
    stop: () => recognition.stop(),
    abort: () => recognition.abort(),
  };
}
