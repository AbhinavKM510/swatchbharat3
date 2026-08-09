/**
 * Log of questions asked to the FAQ chatbot.
 *
 * The point is not analytics vanity. The chatbot is primarily rule-based, so the main way
 * it improves is by someone reading the questions it failed to match and adding intents.
 * `matched: false` rows are the backlog. `answeredBy` additionally distinguishes a rule
 * match from the optional Gemini fallback (see services/geminiChat.js) and the final
 * unmatched default, so that backlog is not muddied by questions Gemini already handled.
 *
 * Note the chatbot also answers entirely offline in the PWA. Those questions reach this
 * collection only if the device later syncs them, so treat counts as a lower bound.
 */

import mongoose from 'mongoose';

const chatQuerySchema = new mongoose.Schema(
  {
    question: { type: String, required: true, trim: true, maxlength: 500 },
    language: { type: String, enum: ['bn', 'hi', 'en'], default: 'en' },
    intentId: { type: String, required: true, index: true },
    matched: { type: Boolean, required: true, index: true },
    escalated: { type: Boolean, default: false },

    /**
     * Which tier actually produced the answer. Optional and defaulted, so rows written
     * before this field existed still read fine.
     *
     *   'rules'    a local rule matched (the normal case)
     *   'gemini'   the LLM fallback produced a grounded answer (see services/geminiChat.js)
     *   'fallback' unmatched, and Gemini was off, failed, or declined — same answer either way
     */
    answeredBy: { type: String, enum: ['rules', 'gemini', 'fallback'], default: 'rules' },

    /** Null for anonymous patient-facing use. */
    askedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    district: { type: String, trim: true, default: '' },

    /** 'online' when answered by the API, 'offline-sync' when replayed from the device. */
    source: { type: String, enum: ['online', 'offline-sync'], default: 'online' },
    askedAt: { type: Date, default: () => new Date() },
  },
  { timestamps: true },
);

chatQuerySchema.index({ matched: 1, createdAt: -1 });

export const ChatQuery = mongoose.model('ChatQuery', chatQuerySchema);
