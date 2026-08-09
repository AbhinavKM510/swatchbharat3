/**
 * Public surface of the shared rule-based health FAQ.
 *
 * Imported by the React PWA (`@shared/chatbot`, so questions can be answered with no
 * network) and by the Express API (`../../shared/chatbot/index.js`, which serves the
 * same answers and logs what people ask).
 */

export {
  SUPPORTED_CHATBOT_LANGUAGES,
  CHATBOT_VERSION,
  CHATBOT_INTENTS,
  CHATBOT_FALLBACK,
  CHATBOT_DISCLAIMER,
  CHATBOT_SUGGESTIONS,
  matchIntent,
  answerQuestion,
} from './faqRules.js';
