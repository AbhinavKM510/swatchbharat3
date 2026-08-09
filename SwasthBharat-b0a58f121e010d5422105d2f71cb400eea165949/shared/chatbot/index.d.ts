/** Type declarations for the shared rule-based health FAQ. */

export type ChatbotLanguage = 'bn' | 'hi' | 'en';

export interface ChatbotAnswerBody {
  title: string;
  points: string[];
}

export interface ChatbotIntent {
  id: string;
  groups: string[][];
  weight: number;
  escalate?: boolean;
  answers: Record<ChatbotLanguage, ChatbotAnswerBody>;
}

export interface ChatbotAnswer {
  matched: boolean;
  intentId: string;
  title: string;
  points: string[];
  disclaimer: string;
  /** True for emergency intents: the UI should show an urgent banner, not a chat bubble. */
  escalate: boolean;
  language: ChatbotLanguage;
  suggestions: string[];
  version: string;
  /**
   * Set only by the API's optional Gemini fallback (backend/src/services/geminiChat.js),
   * never by the local rule engine — `answerQuestion()` below cannot produce this, since it
   * runs on-device with no network. Absent for every rule-matched and offline answer. The
   * UI uses its presence to show an "AI-generated" label, so a generated answer is never
   * visually indistinguishable from a clinician-reviewed one.
   */
  source?: 'gemini';
}

export declare const SUPPORTED_CHATBOT_LANGUAGES: ChatbotLanguage[];
export declare const CHATBOT_VERSION: string;
export declare const CHATBOT_INTENTS: ChatbotIntent[];
export declare const CHATBOT_FALLBACK: Record<ChatbotLanguage, ChatbotAnswerBody>;
export declare const CHATBOT_DISCLAIMER: Record<ChatbotLanguage, string>;
export declare const CHATBOT_SUGGESTIONS: Record<ChatbotLanguage, string[]>;

export declare function matchIntent(question: string): {
  intent: ChatbotIntent | null;
  score: number;
};

export declare function answerQuestion(
  question: string,
  language?: ChatbotLanguage,
): ChatbotAnswer;
