/**
 * Rule-based health FAQ endpoint.
 *
 * The answers come from `shared/chatbot`, the same module the PWA bundles — so a question
 * asked with no signal gets the identical answer to one asked online. This endpoint's
 * extra value is the log: unmatched questions are the to-do list for new intents.
 *
 * Open to unauthenticated callers on purpose. A patient at a village health post may be
 * using a worker's phone without logging in, and the content is public health
 * information, not patient data.
 */

import express from 'express';
import rateLimit from 'express-rate-limit';
import {
  CHATBOT_SUGGESTIONS,
  CHATBOT_VERSION,
  SUPPORTED_CHATBOT_LANGUAGES,
  answerQuestion,
} from '../../../shared/chatbot/index.js';
import { answerWithGeminiFallback } from '../services/geminiChat.js';
import { ChatQuery } from '../models/ChatQuery.js';
import { verifyToken } from '../middleware/auth.js';
import { User } from '../models/User.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export const chatbotRouter = express.Router();

const MAX_QUESTION_LENGTH = 500;

const askLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 40,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    error: { code: 'TOO_MANY_REQUESTS', message: 'Please slow down a little and try again.' },
  },
});

/**
 * Attaches the user when a token happens to be present, but never rejects.
 * Lets the log distinguish worker questions from anonymous patient questions.
 */
async function optionalUser(req) {
  const header = req.get('authorization') || '';
  if (!header.toLowerCase().startsWith('bearer ')) return null;
  try {
    const payload = verifyToken(header.slice(7).trim());
    return await User.findById(payload.sub);
  } catch {
    return null;
  }
}

chatbotRouter.get('/suggestions', (req, res) => {
  const language = SUPPORTED_CHATBOT_LANGUAGES.includes(req.query.language) ? req.query.language : 'en';
  res.json({ language, suggestions: CHATBOT_SUGGESTIONS[language], version: CHATBOT_VERSION });
});

chatbotRouter.post(
  '/ask',
  askLimiter,
  asyncHandler(async (req, res) => {
    const { question, language = 'en', source = 'online', askedAt } = req.body || {};

    if (!question || !String(question).trim()) {
      throw ApiError.badRequest('QUESTION_REQUIRED', 'A question is required');
    }
    const trimmed = String(question).trim().slice(0, MAX_QUESTION_LENGTH);

    let answer = answerQuestion(trimmed, language);

    /**
     * The LLM fallback tier — only reached when the rule engine found no match, and only
     * changes the answer if Gemini actually produced a grounded one. See geminiChat.js for
     * every reason this can decline and fall through to `answer` unchanged: disabled, no
     * key, network failure, timeout, malformed output, the model reporting the question as
     * out of its known material, or the answer itself tripping the local emergency check.
     */
    if (!answer.matched) {
      answer = await answerWithGeminiFallback(trimmed, answer.language, answer);
    }

    const user = await optionalUser(req);

    // Logged after answering, and never allowed to break the response: an analytics
    // write failing must not stop a patient getting health advice.
    try {
      await ChatQuery.create({
        question: trimmed,
        language: answer.language,
        intentId: answer.intentId,
        matched: answer.matched,
        escalated: answer.escalate,
        answeredBy: answer.source === 'gemini' ? 'gemini' : answer.matched ? 'rules' : 'fallback',
        askedBy: user?._id ?? null,
        district: user?.district ?? '',
        source: source === 'offline-sync' ? 'offline-sync' : 'online',
        askedAt: askedAt ? new Date(askedAt) : new Date(),
      });
    } catch (error) {
      console.warn('[chatbot] could not log question:', error.message);
    }

    res.json({ answer });
  }),
);

/**
 * Replays questions the PWA answered while offline, so the unmatched-question backlog
 * includes them. No answers are returned; the device already showed one.
 */
chatbotRouter.post(
  '/sync',
  asyncHandler(async (req, res) => {
    const { questions } = req.body || {};
    if (!Array.isArray(questions)) {
      throw ApiError.badRequest('QUESTIONS_REQUIRED', 'Body must contain a "questions" array');
    }

    const user = await optionalUser(req);
    let stored = 0;

    for (const entry of questions.slice(0, 200)) {
      const text = String(entry?.question || '').trim();
      if (!text) continue;
      const answer = answerQuestion(text, entry?.language);
      try {
        await ChatQuery.create({
          question: text.slice(0, MAX_QUESTION_LENGTH),
          language: answer.language,
          intentId: answer.intentId,
          matched: answer.matched,
          escalated: answer.escalate,
          askedBy: user?._id ?? null,
          district: user?.district ?? '',
          source: 'offline-sync',
          askedAt: entry?.askedAt ? new Date(entry.askedAt) : new Date(),
        });
        stored += 1;
      } catch (error) {
        console.warn('[chatbot] could not log synced question:', error.message);
      }
    }

    res.json({ stored, received: questions.length });
  }),
);

/**
 * The unmatched-question backlog. Read this to decide which intent to write next.
 * Requires a token because it exposes what a specific district is asking about.
 */
chatbotRouter.get(
  '/unmatched',
  asyncHandler(async (req, res) => {
    const user = await optionalUser(req);
    if (!user) throw ApiError.unauthorized('NO_TOKEN', 'Authentication required');

    const rows = await ChatQuery.aggregate([
      { $match: { matched: false } },
      { $group: { _id: '$question', count: { $sum: 1 }, lastAskedAt: { $max: '$askedAt' }, language: { $first: '$language' } } },
      { $sort: { count: -1, lastAskedAt: -1 } },
      { $limit: 50 },
    ]);

    res.json({
      items: rows.map((row) => ({
        question: row._id,
        count: row.count,
        language: row.language,
        lastAskedAt: row.lastAskedAt,
      })),
    });
  }),
);
