/**
 * Rule-based multilingual health FAQ.
 *
 * Deliberately NOT an LLM. Reasons:
 *   - it has to work with no internet, from the service-worker cache
 *   - a health bot for low-literacy users must never improvise medical advice
 *   - every answer here is a fixed, reviewable string
 *
 * Shared between the API (`/api/chatbot/ask`, which also logs questions so the team can
 * see what people actually ask) and the PWA (which answers locally when offline).
 *
 * Matching strategy
 * -----------------
 * Each intent declares one or more keyword GROUPS. An intent matches only when every
 * group has at least one keyword hit — an AND of ORs. That is what keeps
 * "what is diabetes" from colliding with "what should I eat".
 *
 * Keywords for all three languages live in the same list on purpose: rural users
 * frequently type Hindi or Bengali words in Latin script ("sugar kya hai", "ki khabo"),
 * and mixing the vocabularies makes that work without a transliteration engine.
 */

export const SUPPORTED_CHATBOT_LANGUAGES = ['bn', 'hi', 'en'];

export const CHATBOT_VERSION = '1.0.0';

/* Reusable keyword groups ------------------------------------------------- */

const DIABETES_WORDS = [
  'diabetes', 'diabetic', 'sugar', 'blood sugar', 'madhumeh',
  'ডায়াবেটিস', 'মধুমেহ', 'বহুমূত্র', 'সুগার', 'শর্করা',
  'मधुमेह', 'डायबिटीज', 'डायबिटीज़', 'शुगर', 'शर्करा',
];

const FOOD_WORDS = [
  'eat', 'food', 'diet', 'meal', 'khana', 'khaun', 'khabo', 'avoid eating', 'rice', 'roti',
  'খাব', 'খাবার', 'খাওয়া', 'খেতে', 'ডায়েট', 'পথ্য', 'ভাত', 'রুটি',
  'खाना', 'खाऊं', 'खाएं', 'आहार', 'भोजन', 'परहेज', 'खानपान', 'चावल', 'रोटी',
];

const QUESTION_WORDS = [
  'what', 'why', 'how', 'kya', 'ki', 'kyun', 'kaise',
  'কি', 'কী', 'কেন', 'কিভাবে', 'কীভাবে',
  'क्या', 'क्यों', 'कैसे', 'किस',
];

const SYMPTOM_WORDS = [
  'symptom', 'symptoms', 'sign', 'lakshan', 'feel',
  'লক্ষণ', 'উপসর্গ', 'বুঝব',
  'लक्षण', 'पहचान', 'संकेत',
];

const EXERCISE_WORDS = [
  'exercise', 'walk', 'walking', 'yoga', 'physical activity', 'vyayam', 'kasrat',
  // 'হাঁট' is the stem: token-start matching covers হাঁটা, হাঁটুন, হাঁটব, হাঁটতে.
  'ব্যায়াম', 'হাঁট', 'শরীরচর্চা', 'যোগব্যায়াম',
  'व्यायाम', 'कसरत', 'टहलना', 'चलना', 'योग',
];

const MEDICINE_WORDS = [
  'medicine', 'medication', 'tablet', 'pill', 'dawa', 'insulin dose',
  'ওষুধ', 'ঔষধ', 'বড়ি',
  'दवा', 'दवाई', 'गोली', 'औषधि',
];

const BP_WORDS = [
  'blood pressure', 'bp', 'hypertension', 'pressure',
  'রক্তচাপ', 'প্রেসার', 'উচ্চ রক্তচাপ',
  'रक्तचाप', 'बीपी', 'ब्लड प्रेशर', 'उच्च रक्तचाप',
];

const ANEMIA_WORDS = [
  'anemia', 'anaemia', 'iron', 'haemoglobin', 'hemoglobin', 'khoon ki kami',
  'রক্তাল্পতা', 'রক্তশূন্যতা', 'অ্যানিমিয়া', 'হিমোগ্লোবিন',
  'एनीमिया', 'रक्ताल्पता', 'खून की कमी', 'हीमोग्लोबिन',
];

const TEST_WORDS = [
  'test', 'check', 'checkup', 'fasting', 'jaanch', 'report', 'hba1c',
  'পরীক্ষা', 'টেস্ট', 'খালি পেটে', 'রিপোর্ট',
  'जांच', 'जाँच', 'टेस्ट', 'खाली पेट', 'रिपोर्ट',
];

const PREGNANCY_WORDS = [
  'pregnant', 'pregnancy', 'gestational', 'garbh',
  'গর্ভবতী', 'গর্ভাবস্থা', 'অন্তঃসত্ত্বা',
  'गर्भवती', 'गर्भावस्था', 'प्रेग्नेंट',
];

const FOOT_WORDS = [
  'foot', 'feet', 'wound', 'ulcer', 'pair', 'paon',
  // 'পা' is a whole-token match only (too short to use as a prefix — it sits inside
  // পারি/পাব/পাঠ). 'পায়' as a stem covers পায়ে and পায়ের.
  'পা', 'পায়', 'ঘা', 'ক্ষত',
  'पैर', 'पाँव', 'घाव', 'जख्म',
];

const PREVENT_WORDS = [
  'prevent', 'avoid', 'stop', 'bachav', 'reduce risk', 'control',
  'প্রতিরোধ', 'এড়ানো', 'বাঁচা', 'নিয়ন্ত্রণ', 'কমাব',
  'रोकना', 'बचाव', 'बचें', 'नियंत्रण', 'कम',
];

const COST_WORDS = [
  'cost', 'free', 'money', 'price', 'expensive', 'scheme', 'ayushman', 'muft',
  'খরচ', 'বিনামূল্যে', 'ফ্রি', 'টাকা', 'দাম',
  'खर्च', 'मुफ्त', 'मुफ़्त', 'फ्री', 'पैसा', 'दाम', 'योजना',
];

const WHERE_WORDS = [
  'where', 'nearest', 'nearby', 'kahan', 'kothay', 'phc', 'hospital', 'clinic', 'doctor',
  'কোথায়', 'নিকটতম', 'হাসপাতাল', 'ডাক্তার', 'স্বাস্থ্যকেন্দ্র',
  'कहाँ', 'कहां', 'निकटतम', 'अस्पताल', 'डॉक्टर', 'स्वास्थ्य केंद्र',
];

const EMERGENCY_WORDS = [
  'unconscious', 'fainted', 'emergency', 'chest pain', 'breathless', 'convulsion', 'seizure',
  'not waking', 'vomiting blood',
  'অজ্ঞান', 'সংজ্ঞাহীন', 'বুকে ব্যথা', 'শ্বাসকষ্ট', 'খিঁচুনি', 'জরুরি',
  'बेहोश', 'अचेत', 'सीने में दर्द', 'सांस', 'दौरा', 'आपातकाल', 'इमरजेंसी',
];

const GREETING_WORDS = [
  'hello', 'hi', 'hey', 'namaste', 'namaskar', 'salam', 'good morning',
  'নমস্কার', 'হ্যালো', 'আসসালামু', 'শুভ',
  'नमस्ते', 'नमस्कार', 'हैलो', 'सलाम',
];

const THANKS_WORDS = [
  'thanks', 'thank you', 'dhanyavad', 'shukriya',
  'ধন্যবাদ', 'থ্যাঙ্ক',
  'धन्यवाद', 'शुक्रिया', 'थैंक',
];

/* Intents ----------------------------------------------------------------- */

/**
 * Ordered most-specific first. `groups` is an AND of ORs. `weight` breaks ties in
 * favour of intents that should win when a question is ambiguous (emergencies first).
 *
 * @type {Array<{id: string, groups: string[][], weight: number, escalate?: boolean,
 *   answers: Record<'bn'|'hi'|'en', {title: string, points: string[]}>}>}
 */
export const CHATBOT_INTENTS = [
  {
    id: 'emergency',
    groups: [EMERGENCY_WORDS],
    weight: 100,
    escalate: true,
    answers: {
      bn: {
        title: 'এটি জরুরি অবস্থা হতে পারে',
        points: [
          'এখনই নিকটতম হাসপাতাল বা প্রাথমিক স্বাস্থ্যকেন্দ্রে নিয়ে যান।',
          'অ্যাম্বুলেন্সের জন্য ১০৮ নম্বরে ফোন করুন।',
          'রোগী অজ্ঞান থাকলে মুখে কিছু খাওয়াবেন না।',
          'এই অ্যাপে অপেক্ষা করবেন না — আগে চিকিৎসা নিন।',
        ],
      },
      hi: {
        title: 'यह आपातकालीन स्थिति हो सकती है',
        points: [
          'मरीज़ को तुरंत नज़दीकी अस्पताल या प्राथमिक स्वास्थ्य केंद्र ले जाएँ।',
          'एम्बुलेंस के लिए 108 पर कॉल करें।',
          'बेहोश मरीज़ को मुँह से कुछ न खिलाएँ।',
          'ऐप पर इंतज़ार न करें — पहले इलाज कराएँ।',
        ],
      },
      en: {
        title: 'This may be an emergency',
        points: [
          'Take the patient to the nearest hospital or PHC right now.',
          'Call 108 for an ambulance.',
          'Do not give food or water by mouth to an unconscious patient.',
          'Do not wait on this app — get medical help first.',
        ],
      },
    },
  },

  {
    id: 'diet',
    groups: [FOOD_WORDS],
    weight: 20,
    answers: {
      bn: {
        title: 'রক্তে শর্করা বেশি থাকলে কী খাবেন',
        points: [
          'ভাত ও রুটির পরিমাণ কমান — এক বেলায় এক কাপ ভাতের বেশি নয়।',
          'প্রতি বেলায় শাকসবজি ও ডাল রাখুন, থালার অর্ধেক সবজি।',
          'চিনি, মিষ্টি, গুড়, ঠান্ডা পানীয় ও প্যাকেটের রস বন্ধ করুন।',
          'ভাজাভুজির বদলে সেদ্ধ বা ভাপে রান্না করুন।',
          'দিনে তিনবার বড় খাবারের বদলে অল্প অল্প করে বারবার খান।',
          'জল বেশি খান, চায়ে চিনি দেবেন না।',
        ],
      },
      hi: {
        title: 'शुगर बढ़ी हो तो क्या खाएँ',
        points: [
          'चावल और रोटी की मात्रा घटाएँ — एक बार में एक कटोरी चावल से ज़्यादा नहीं।',
          'हर बार खाने में हरी सब्ज़ी और दाल रखें, आधी थाली सब्ज़ी हो।',
          'चीनी, मिठाई, गुड़, कोल्ड ड्रिंक और पैकेट का जूस बंद करें।',
          'तली चीज़ों की जगह उबला या भाप में पका खाना लें।',
          'दिन में तीन बड़े भोजन की जगह थोड़ा-थोड़ा कई बार खाएँ।',
          'पानी ज़्यादा पिएँ, चाय में चीनी न डालें।',
        ],
      },
      en: {
        title: 'What to eat when blood sugar is high',
        points: [
          'Cut down rice and roti — no more than one cup of rice per meal.',
          'Put vegetables and dal in every meal; half the plate should be vegetables.',
          'Stop sugar, sweets, jaggery, cold drinks and packaged juice.',
          'Choose boiled or steamed food instead of fried.',
          'Eat smaller amounts more often instead of three large meals.',
          'Drink more water and take tea without sugar.',
        ],
      },
    },
  },

  {
    id: 'exercise',
    groups: [EXERCISE_WORDS],
    weight: 20,
    answers: {
      bn: {
        title: 'শরীরচর্চা কতটা করবেন',
        points: [
          'প্রতিদিন ৩০ মিনিট জোরে হাঁটুন — সপ্তাহে অন্তত ৫ দিন।',
          'একসাথে না পারলে ১০ মিনিট করে তিনবার ভাগ করে নিন।',
          'ঘরের কাজ, ক্ষেতের কাজও গণনায় ধরুন।',
          'বুকে ব্যথা, মাথা ঘোরা বা খুব শ্বাসকষ্ট হলে থামুন এবং ডাক্তার দেখান।',
          'পায়ে আরামদায়ক জুতো পরে হাঁটুন, খালি পায়ে নয়।',
        ],
      },
      hi: {
        title: 'कितनी कसरत करें',
        points: [
          'रोज़ 30 मिनट तेज़ चलें — हफ़्ते में कम से कम 5 दिन।',
          'एक बार में न हो तो 10-10 मिनट के तीन हिस्सों में करें।',
          'घर का काम और खेत का काम भी गिनती में आता है।',
          'सीने में दर्द, चक्कर या ज़्यादा सांस फूले तो रुकें और डॉक्टर को दिखाएँ।',
          'आरामदायक जूते पहनकर चलें, नंगे पैर नहीं।',
        ],
      },
      en: {
        title: 'How much physical activity',
        points: [
          'Walk briskly for 30 minutes a day, at least 5 days a week.',
          'If you cannot do it at once, split it into three 10-minute walks.',
          'Housework and field work count too.',
          'Stop and see a doctor if you get chest pain, dizziness or heavy breathlessness.',
          'Wear comfortable footwear — do not walk barefoot.',
        ],
      },
    },
  },

  {
    id: 'symptoms',
    groups: [SYMPTOM_WORDS],
    weight: 20,
    answers: {
      bn: {
        title: 'ডায়াবেটিসের সাধারণ লক্ষণ',
        points: [
          'বারবার প্রস্রাব, বিশেষ করে রাতে।',
          'খুব তেষ্টা ও শুকনো মুখ।',
          'বেশি খিদে পাওয়া, তবু ওজন কমে যাওয়া।',
          'সবসময় ক্লান্তি ও দুর্বলতা।',
          'ঘা শুকাতে দেরি হওয়া, চোখে ঝাপসা দেখা।',
          'অনেকের কোনও লক্ষণই থাকে না — তাই রক্ত পরীক্ষাই একমাত্র নিশ্চিত উপায়।',
        ],
      },
      hi: {
        title: 'मधुमेह के आम लक्षण',
        points: [
          'बार-बार पेशाब आना, ख़ासकर रात में।',
          'बहुत प्यास लगना और मुँह सूखना।',
          'भूख ज़्यादा लगना, फिर भी वज़न घटना।',
          'हमेशा थकान और कमज़ोरी।',
          'घाव देर से भरना, आँखों से धुंधला दिखना।',
          'कई लोगों में कोई लक्षण नहीं होता — इसलिए खून की जाँच ही पक्का तरीका है।',
        ],
      },
      en: {
        title: 'Common signs of diabetes',
        points: [
          'Passing urine often, especially at night.',
          'Feeling very thirsty with a dry mouth.',
          'Eating more but still losing weight.',
          'Constant tiredness and weakness.',
          'Wounds healing slowly, blurred vision.',
          'Many people have no signs at all — a blood test is the only sure way to know.',
        ],
      },
    },
  },

  {
    id: 'test',
    groups: [TEST_WORDS],
    weight: 20,
    answers: {
      bn: {
        title: 'রক্ত পরীক্ষা কীভাবে করাবেন',
        points: [
          'খালি পেটে পরীক্ষার আগে ৮ ঘণ্টা কিছু খাবেন না — শুধু জল খেতে পারেন।',
          'সকালে স্বাস্থ্যকেন্দ্রে গেলে সেদিনই রিপোর্ট পাওয়া যায়।',
          'সরকারি প্রাথমিক স্বাস্থ্যকেন্দ্রে এই পরীক্ষা বিনামূল্যে হয়।',
          'ঝুঁকি বেশি হলে ৩ মাস অন্তর, নাহলে বছরে একবার করান।',
          'HbA1c পরীক্ষা তিন মাসের গড় শর্করা দেখায়, খালি পেটে থাকার দরকার নেই।',
        ],
      },
      hi: {
        title: 'खून की जाँच कैसे कराएँ',
        points: [
          'खाली पेट जाँच से पहले 8 घंटे कुछ न खाएँ — सिर्फ़ पानी पी सकते हैं।',
          'सुबह स्वास्थ्य केंद्र जाएँ तो उसी दिन रिपोर्ट मिल जाती है।',
          'सरकारी प्राथमिक स्वास्थ्य केंद्र में यह जाँच मुफ़्त होती है।',
          'जोखिम ज़्यादा हो तो हर 3 महीने, वरना साल में एक बार कराएँ।',
          'HbA1c जाँच तीन महीने का औसत बताती है, इसके लिए खाली पेट रहना ज़रूरी नहीं।',
        ],
      },
      en: {
        title: 'How to get a blood test',
        points: [
          'For a fasting test, eat nothing for 8 hours before — water is fine.',
          'Go to the health centre in the morning and you usually get the report the same day.',
          'This test is free at a government Primary Health Centre.',
          'Repeat every 3 months if your risk is high, otherwise once a year.',
          'An HbA1c test shows your 3-month average and does not need fasting.',
        ],
      },
    },
  },

  {
    id: 'medicine',
    groups: [MEDICINE_WORDS],
    weight: 20,
    answers: {
      bn: {
        title: 'ওষুধ নিয়ে জরুরি কথা',
        points: [
          'ভালো বোধ করলেও ওষুধ নিজে থেকে বন্ধ করবেন না।',
          'রোজ একই সময়ে ওষুধ খান, ডাক্তারের বলা মাত্রায়।',
          'একদিন ভুলে গেলে দুই ডোজ একসাথে খাবেন না।',
          'হাত-পা কাঁপা, ঘাম, খুব দুর্বল লাগলে সঙ্গে সঙ্গে মিষ্টি কিছু খান — শর্করা কমে যেতে পারে।',
          'ওষুধের মাত্রা বদলানোর আগে অবশ্যই ডাক্তারের সঙ্গে কথা বলুন।',
        ],
      },
      hi: {
        title: 'दवा से जुड़ी ज़रूरी बातें',
        points: [
          'अच्छा महसूस होने पर भी दवा अपने मन से बंद न करें।',
          'रोज़ एक ही समय पर, डॉक्टर की बताई मात्रा में दवा लें।',
          'एक दिन भूल जाएँ तो दो खुराक एक साथ न लें।',
          'हाथ-पैर काँपें, पसीना आए या बहुत कमज़ोरी लगे तो तुरंत कुछ मीठा खाएँ — शुगर गिर सकती है।',
          'खुराक बदलने से पहले डॉक्टर से बात ज़रूर करें।',
        ],
      },
      en: {
        title: 'Important points about medicines',
        points: [
          'Do not stop your medicine on your own, even if you feel well.',
          'Take it at the same time every day, in the dose your doctor gave.',
          'If you miss a day, do not take two doses together.',
          'Shaking, sweating or sudden weakness can mean low sugar — eat something sweet at once.',
          'Always talk to a doctor before changing the dose.',
        ],
      },
    },
  },

  {
    id: 'bloodPressure',
    groups: [BP_WORDS],
    weight: 20,
    answers: {
      bn: {
        title: 'উচ্চ রক্তচাপ নিয়ন্ত্রণে রাখা',
        points: [
          'নুন কমান — দিনে এক চা-চামচের কম, আচার ও প্যাকেটের খাবার এড়িয়ে চলুন।',
          'রোজ ৩০ মিনিট হাঁটুন এবং ওজন নিয়ন্ত্রণে রাখুন।',
          'তামাক, গুটখা ও মদ ছাড়ুন।',
          'ডায়াবেটিস ও উচ্চ রক্তচাপ একসাথে থাকলে হার্ট ও কিডনির ঝুঁকি অনেক বেড়ে যায়।',
          'নিচের চাপ ৯০-এর বেশি বারবার এলে ডাক্তার দেখান।',
        ],
      },
      hi: {
        title: 'उच्च रक्तचाप को काबू में रखना',
        points: [
          'नमक घटाएँ — दिन में एक चम्मच से कम, अचार और पैकेट का खाना छोड़ें।',
          'रोज़ 30 मिनट चलें और वज़न काबू में रखें।',
          'तंबाकू, गुटखा और शराब छोड़ें।',
          'मधुमेह और उच्च रक्तचाप साथ हों तो दिल और गुर्दे का खतरा बहुत बढ़ जाता है।',
          'नीचे का दबाव बार-बार 90 से ऊपर आए तो डॉक्टर को दिखाएँ।',
        ],
      },
      en: {
        title: 'Keeping high blood pressure under control',
        points: [
          'Reduce salt — less than one teaspoon a day; avoid pickles and packaged food.',
          'Walk 30 minutes daily and keep your weight in check.',
          'Stop tobacco, gutkha and alcohol.',
          'Diabetes and high BP together sharply raise heart and kidney risk.',
          'See a doctor if your lower reading is repeatedly above 90.',
        ],
      },
    },
  },

  {
    id: 'anemia',
    groups: [ANEMIA_WORDS],
    weight: 20,
    answers: {
      bn: {
        title: 'রক্তাল্পতা (রক্তে আয়রনের অভাব)',
        points: [
          'লক্ষণ: খুব ক্লান্তি, ফ্যাকাশে ত্বক, মাথা ঘোরা, শ্বাসকষ্ট।',
          'পালং ও অন্য শাক, ডাল, গুড়, খেজুর ও কলিজা খান।',
          'খাওয়ার সঙ্গে আমলকি বা লেবু নিন — আয়রন ভালো শোষিত হয়।',
          'খাওয়ার সঙ্গে সঙ্গে চা বা কফি খাবেন না, আয়রন শোষণ কমে যায়।',
          'স্বাস্থ্যকেন্দ্রে হিমোগ্লোবিন পরীক্ষা করান; আয়রন ও ফলিক অ্যাসিড ট্যাবলেট বিনামূল্যে পাওয়া যায়।',
        ],
      },
      hi: {
        title: 'खून की कमी (एनीमिया)',
        points: [
          'लक्षण: बहुत थकान, पीलापन, चक्कर आना, सांस फूलना।',
          'पालक और हरी सब्ज़ियाँ, दाल, गुड़, खजूर और कलेजी खाएँ।',
          'खाने के साथ आँवला या नींबू लें — आयरन बेहतर सोखा जाता है।',
          'खाने के तुरंत बाद चाय या कॉफ़ी न लें, इससे आयरन कम सोखा जाता है।',
          'स्वास्थ्य केंद्र में हीमोग्लोबिन जाँच कराएँ; आयरन और फ़ोलिक एसिड की गोली मुफ़्त मिलती है।',
        ],
      },
      en: {
        title: 'Anaemia (low iron in blood)',
        points: [
          'Signs: heavy tiredness, pale skin, dizziness, breathlessness.',
          'Eat spinach and other greens, dal, jaggery, dates and liver.',
          'Take amla or lemon with meals — iron is absorbed better.',
          'Avoid tea or coffee right after eating; it reduces iron absorption.',
          'Get a haemoglobin test at the health centre. Iron and folic acid tablets are free.',
        ],
      },
    },
  },

  {
    id: 'pregnancy',
    groups: [PREGNANCY_WORDS],
    weight: 25,
    answers: {
      bn: {
        title: 'গর্ভাবস্থায় শর্করা বেড়ে যাওয়া',
        points: [
          'গর্ভাবস্থায় ডায়াবেটিস (GDM) খুব সাধারণ এবং চিকিৎসায় ভালো থাকে।',
          '২৪ থেকে ২৮ সপ্তাহের মধ্যে শর্করা পরীক্ষা করাতে হবে।',
          'সব প্রসবপূর্ব পরীক্ষা নিয়ম করে করান, একটিও বাদ দেবেন না।',
          'গর্ভাবস্থায় নিজে থেকে কোনও ডায়াবেটিসের ওষুধ খাবেন না — শুধু ডাক্তারের পরামর্শে।',
          'প্রসবের পরেও পরীক্ষা করাতে হবে, কারণ পরে ডায়াবেটিসের ঝুঁকি থাকে।',
        ],
      },
      hi: {
        title: 'गर्भावस्था में शुगर बढ़ना',
        points: [
          'गर्भावस्था का मधुमेह (GDM) आम है और इलाज से काबू में रहता है।',
          '24 से 28 हफ़्ते के बीच शुगर की जाँच करानी चाहिए।',
          'सभी प्रसवपूर्व जाँच समय पर कराएँ, एक भी न छोड़ें।',
          'गर्भावस्था में अपने मन से कोई शुगर की दवा न लें — केवल डॉक्टर की सलाह पर।',
          'प्रसव के बाद भी जाँच कराएँ, क्योंकि आगे मधुमेह का खतरा रहता है।',
        ],
      },
      en: {
        title: 'High sugar during pregnancy',
        points: [
          'Diabetes in pregnancy (GDM) is common and manageable with care.',
          'A sugar test should be done between 24 and 28 weeks.',
          'Attend every antenatal check-up — do not skip any.',
          'Never take diabetes medicine on your own during pregnancy; only as a doctor advises.',
          'Get tested again after delivery, as the risk of diabetes stays higher later.',
        ],
      },
    },
  },

  {
    id: 'footCare',
    groups: [FOOT_WORDS],
    weight: 25,
    answers: {
      bn: {
        title: 'ডায়াবেটিসে পায়ের যত্ন',
        points: [
          'রোজ পা দেখুন — কাটা, ফোস্কা, লালচে দাগ বা ফাটল খুঁজুন।',
          'কখনও খালি পায়ে হাঁটবেন না, ঘরেও নয়।',
          'পা ধুয়ে ভালো করে মুছুন, বিশেষ করে আঙুলের ফাঁক।',
          'নখ সোজা করে কাটুন, কোণ গভীরে কাটবেন না।',
          'কোনও ঘা ৩ দিনে না শুকালে সঙ্গে সঙ্গে স্বাস্থ্যকেন্দ্রে দেখান — দেরি করলে বড় ক্ষতি হতে পারে।',
        ],
      },
      hi: {
        title: 'मधुमेह में पैरों की देखभाल',
        points: [
          'रोज़ पैर देखें — कटना, छाला, लाल निशान या दरार खोजें।',
          'कभी नंगे पैर न चलें, घर में भी नहीं।',
          'पैर धोकर अच्छी तरह पोंछें, ख़ासकर उँगलियों के बीच।',
          'नाखून सीधा काटें, कोनों को गहरा न काटें।',
          'कोई घाव 3 दिन में न भरे तो तुरंत स्वास्थ्य केंद्र दिखाएँ — देरी से बड़ा नुक़सान हो सकता है।',
        ],
      },
      en: {
        title: 'Foot care with diabetes',
        points: [
          'Check your feet daily for cuts, blisters, red marks or cracks.',
          'Never walk barefoot, not even indoors.',
          'Wash and dry your feet well, especially between the toes.',
          'Cut nails straight across; do not cut deep at the corners.',
          'If a wound has not healed in 3 days, go to the health centre at once — delay causes serious damage.',
        ],
      },
    },
  },

  {
    id: 'prevention',
    groups: [PREVENT_WORDS, DIABETES_WORDS],
    weight: 30,
    answers: {
      bn: {
        title: 'ডায়াবেটিস প্রতিরোধ বা নিয়ন্ত্রণ',
        points: [
          'ওজন ৫ থেকে ৭ শতাংশ কমালেই ঝুঁকি অনেকটা কমে যায়।',
          'রোজ ৩০ মিনিট হাঁটুন।',
          'চিনি ও মিষ্টি পানীয় বন্ধ করুন, ভাত-রুটির পরিমাণ কমান।',
          'তামাক ও মদ ছাড়ুন।',
          'পরিবারে ডায়াবেটিস থাকলে ৩০ বছর বয়স থেকেই বছরে একবার পরীক্ষা করান।',
        ],
      },
      hi: {
        title: 'मधुमेह से बचाव और नियंत्रण',
        points: [
          'वज़न 5 से 7 प्रतिशत घटाने से ही खतरा बहुत कम हो जाता है।',
          'रोज़ 30 मिनट चलें।',
          'चीनी और मीठे पेय बंद करें, चावल-रोटी की मात्रा घटाएँ।',
          'तंबाकू और शराब छोड़ें।',
          'परिवार में मधुमेह हो तो 30 साल की उम्र से हर साल जाँच कराएँ।',
        ],
      },
      en: {
        title: 'Preventing or controlling diabetes',
        points: [
          'Losing just 5 to 7 percent of your weight cuts the risk a lot.',
          'Walk 30 minutes every day.',
          'Stop sugar and sweet drinks; reduce the amount of rice and roti.',
          'Give up tobacco and alcohol.',
          'If diabetes runs in your family, get tested yearly from age 30.',
        ],
      },
    },
  },

  {
    id: 'whereToGoCost',
    groups: [COST_WORDS],
    weight: 22,
    answers: {
      bn: {
        title: 'খরচ ও সরকারি সুবিধা',
        points: [
          'প্রাথমিক স্বাস্থ্যকেন্দ্রে (PHC) শর্করা ও রক্তচাপ পরীক্ষা বিনামূল্যে।',
          'সরকারি কেন্দ্রে ডায়াবেটিস ও রক্তচাপের অনেক ওষুধ বিনামূল্যে পাওয়া যায়।',
          'আয়ুষ্মান ভারত কার্ড থাকলে হাসপাতালে ভর্তির খরচে সহায়তা মেলে।',
          'আপনার ASHA দিদি বা ANM দিদির সঙ্গে কথা বলুন, তিনি পথ দেখিয়ে দেবেন।',
        ],
      },
      hi: {
        title: 'खर्च और सरकारी सुविधाएँ',
        points: [
          'प्राथमिक स्वास्थ्य केंद्र (PHC) में शुगर और रक्तचाप की जाँच मुफ़्त है।',
          'सरकारी केंद्र पर मधुमेह और रक्तचाप की कई दवाएँ मुफ़्त मिलती हैं।',
          'आयुष्मान भारत कार्ड हो तो अस्पताल में भर्ती के खर्च में मदद मिलती है।',
          'अपनी ASHA दीदी या ANM दीदी से बात करें, वे रास्ता बताएँगी।',
        ],
      },
      en: {
        title: 'Cost and government support',
        points: [
          'Sugar and blood pressure tests are free at a Primary Health Centre (PHC).',
          'Many diabetes and BP medicines are supplied free at government centres.',
          'An Ayushman Bharat card helps cover hospital admission costs.',
          'Talk to your ASHA or ANM worker — she will guide you.',
        ],
      },
    },
  },

  {
    id: 'whereToGo',
    groups: [WHERE_WORDS],
    weight: 18,
    answers: {
      bn: {
        title: 'কোথায় দেখাবেন',
        points: [
          'প্রথমে আপনার এলাকার প্রাথমিক স্বাস্থ্যকেন্দ্রে (PHC) যান।',
          'আপনার ASHA বা ANM দিদি নিকটতম কেন্দ্র ও সময় বলে দেবেন।',
          'ঝুঁকি বেশি ধরা পড়লে এই অ্যাপ থেকেই টেলি-পরামর্শ বুক করা যায়।',
          'জরুরি অবস্থায় ১০৮ নম্বরে ফোন করুন।',
        ],
      },
      hi: {
        title: 'कहाँ दिखाएँ',
        points: [
          'पहले अपने इलाके के प्राथमिक स्वास्थ्य केंद्र (PHC) जाएँ।',
          'आपकी ASHA या ANM दीदी नज़दीकी केंद्र और समय बता देंगी।',
          'जोखिम ज़्यादा निकले तो इसी ऐप से टेली-परामर्श बुक कर सकते हैं।',
          'आपात स्थिति में 108 पर कॉल करें।',
        ],
      },
      en: {
        title: 'Where to go',
        points: [
          'Start with the Primary Health Centre (PHC) for your area.',
          'Your ASHA or ANM worker can tell you the nearest centre and its timings.',
          'If your risk comes out high, you can book a teleconsultation from this app.',
          'In an emergency, call 108.',
        ],
      },
    },
  },

  {
    id: 'whatIsDiabetes',
    groups: [QUESTION_WORDS, DIABETES_WORDS],
    weight: 15,
    answers: {
      bn: {
        title: 'ডায়াবেটিস কী',
        points: [
          'রক্তে শর্করার (চিনির) পরিমাণ স্বাভাবিকের চেয়ে বেশি থেকে গেলে তাকে ডায়াবেটিস বলে।',
          'শরীর ইনসুলিন কম তৈরি করে, বা তৈরি হওয়া ইনসুলিন ঠিকমতো কাজ করে না।',
          'দীর্ঘদিন অনিয়ন্ত্রিত থাকলে চোখ, কিডনি, হার্ট ও পায়ের ক্ষতি হয়।',
          'খাওয়াদাওয়া, হাঁটাচলা ও প্রয়োজনে ওষুধ দিয়ে ভালোভাবে নিয়ন্ত্রণ করা যায়।',
          'তাড়াতাড়ি ধরা পড়লে ক্ষতি অনেকটাই আটকানো যায়।',
        ],
      },
      hi: {
        title: 'मधुमेह क्या है',
        points: [
          'खून में शर्करा (शुगर) सामान्य से ज़्यादा बनी रहे तो उसे मधुमेह कहते हैं।',
          'शरीर इंसुलिन कम बनाता है, या बना इंसुलिन ठीक से काम नहीं करता।',
          'लंबे समय तक बेकाबू रहे तो आँख, गुर्दे, दिल और पैरों को नुक़सान होता है।',
          'खानपान, चलना-फिरना और ज़रूरत पर दवा से इसे अच्छे से काबू किया जा सकता है।',
          'जल्दी पकड़ में आ जाए तो बहुत नुक़सान रोका जा सकता है।',
        ],
      },
      en: {
        title: 'What is diabetes',
        points: [
          'Diabetes means the sugar level in your blood stays higher than normal.',
          'The body either makes too little insulin, or the insulin it makes does not work properly.',
          'Left uncontrolled for years it damages the eyes, kidneys, heart and feet.',
          'It can be controlled well with food, activity and medicine when needed.',
          'Caught early, most of that damage can be prevented.',
        ],
      },
    },
  },

  {
    id: 'greeting',
    groups: [GREETING_WORDS],
    weight: 5,
    answers: {
      bn: {
        title: 'নমস্কার',
        points: [
          'আমি স্বাস্থ্য সহায়ক। ডায়াবেটিস, রক্তচাপ, খাবার, পরীক্ষা বা রক্তাল্পতা নিয়ে প্রশ্ন করতে পারেন।',
          'যেমন: "শর্করা বেশি হলে কী খাব?"',
        ],
      },
      hi: {
        title: 'नमस्ते',
        points: [
          'मैं स्वास्थ्य सहायक हूँ। मधुमेह, रक्तचाप, खानपान, जाँच या खून की कमी के बारे में पूछ सकते हैं।',
          'जैसे: "शुगर बढ़ी हो तो क्या खाएँ?"',
        ],
      },
      en: {
        title: 'Hello',
        points: [
          'I am the health helper. Ask me about diabetes, blood pressure, food, tests or anaemia.',
          'For example: "What should I eat if my sugar is high?"',
        ],
      },
    },
  },

  {
    id: 'thanks',
    groups: [THANKS_WORDS],
    weight: 5,
    answers: {
      bn: {
        title: 'ধন্যবাদ',
        points: ['আপনার সুস্থতা কামনা করি। আরও প্রশ্ন থাকলে জিজ্ঞাসা করুন।'],
      },
      hi: {
        title: 'धन्यवाद',
        points: ['आपके स्वस्थ रहने की कामना है। और सवाल हों तो पूछें।'],
      },
      en: {
        title: 'Thank you',
        points: ['Wishing you good health. Ask me anything else you need.'],
      },
    },
  },
];

/** Shown when nothing matches. Offers concrete example questions rather than "try again". */
export const CHATBOT_FALLBACK = {
  bn: {
    title: 'ঠিক বুঝতে পারলাম না',
    points: [
      'এভাবে প্রশ্ন করে দেখুন:',
      '"শর্করা বেশি হলে কী খাব?"',
      '"ডায়াবেটিসের লক্ষণ কী?"',
      '"রক্ত পরীক্ষা কোথায় করাব?"',
      'জরুরি প্রয়োজনে ১০৮ নম্বরে ফোন করুন বা ASHA দিদির সঙ্গে কথা বলুন।',
    ],
  },
  hi: {
    title: 'मैं ठीक से समझ नहीं पाया',
    points: [
      'इस तरह पूछकर देखें:',
      '"शुगर बढ़ी हो तो क्या खाएँ?"',
      '"मधुमेह के लक्षण क्या हैं?"',
      '"खून की जाँच कहाँ कराएँ?"',
      'ज़रूरत हो तो 108 पर कॉल करें या ASHA दीदी से बात करें।',
    ],
  },
  en: {
    title: 'I did not quite understand',
    points: [
      'Try asking like this:',
      '"What should I eat if my sugar is high?"',
      '"What are the signs of diabetes?"',
      '"Where can I get a blood test?"',
      'If you need help now, call 108 or talk to your ASHA worker.',
    ],
  },
};

/** Appended to every answer. This tool screens and educates; it does not diagnose. */
export const CHATBOT_DISCLAIMER = {
  bn: 'এটি সাধারণ স্বাস্থ্য পরামর্শ, ডাক্তারের চিকিৎসার বিকল্প নয়।',
  hi: 'यह सामान्य स्वास्थ्य जानकारी है, डॉक्टर के इलाज का विकल्प नहीं।',
  en: 'This is general health information, not a substitute for a doctor.',
};

/** Suggested starter questions, surfaced as tappable chips for low-literacy users. */
export const CHATBOT_SUGGESTIONS = {
  bn: [
    'শর্করা বেশি হলে কী খাব?',
    'ডায়াবেটিসের লক্ষণ কী?',
    'রোজ কতটা হাঁটা দরকার?',
    'রক্ত পরীক্ষা কোথায় হবে?',
    'রক্তাল্পতা হলে কী করব?',
  ],
  hi: [
    'शुगर बढ़ी हो तो क्या खाएँ?',
    'मधुमेह के लक्षण क्या हैं?',
    'रोज़ कितना चलना चाहिए?',
    'खून की जाँच कहाँ होगी?',
    'खून की कमी हो तो क्या करें?',
  ],
  en: [
    'What should I eat if my sugar is high?',
    'What are the signs of diabetes?',
    'How much should I walk daily?',
    'Where can I get a blood test?',
    'What should I do about anaemia?',
  ],
};

/* Matching ---------------------------------------------------------------- */

/**
 * Normalises a question (and every keyword) to one canonical form.
 *
 * Beyond lowercasing and stripping punctuation, this folds two Indic spelling
 * variations that would otherwise silently break matching, because the same word is
 * routinely typed both ways on Android keyboards:
 *
 *   - Devanagari candrabindu -> anusvara:  खाएँ  ==  खाएं
 *   - Devanagari nukta dropped:            बढ़ी   ==  बढी,  मुफ़्त == मुफ्त
 *
 * Applied identically to input and keywords, so the two always meet in the middle.
 */
function normalise(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/\u0901/g, '\u0902')
    .replace(/\u093c/g, '')
    .replace(/[?!.,;:()\[\]{}"'`\u0964]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Latin-script keywords only, i.e. safe to match on whitespace boundaries. */
const LATIN_ONLY = /^[a-z0-9\s]+$/;

/**
 * Compiled matcher cache, one regex per keyword.
 *
 * Three matching modes, chosen per keyword, because a single strategy gets this wrong:
 *
 *  1. Latin keywords -> whole-token match. Without it, short tokens like "ki" and "hi"
 *     fire inside "walking" and "this".
 *
 *  2. Short Indic keywords (under 3 code units) -> whole-token match. "পা" (foot) was
 *     matching inside "পারি" (can), so "ওষুধ বন্ধ করতে পারি কি" came back as foot care.
 *
 *  3. Longer Indic keywords -> match at the START of a token, suffixes allowed. Bengali
 *     and Hindi glue case and plural endings onto the stem, so "ডায়াবেটিস" has to match
 *     "ডায়াবেটিসের". Plain substring matching is too loose in the other direction:
 *     "খাব" (will eat) sits inside "দেখাব" (will show), which sent "কোথায় ডাক্তার দেখাব"
 *     to the diet answer. Anchoring to the token start fixes both directions at once.
 */
const matcherCache = new Map();

function matcherFor(keyword) {
  const cached = matcherCache.get(keyword);
  if (cached) return cached;

  const normalised = normalise(keyword);
  const escaped = normalised.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const anchorEnd = LATIN_ONLY.test(normalised) || normalised.length < 3;
  const regex = new RegExp(`(?:^|\\s)${escaped}${anchorEnd ? '(?:\\s|$)' : ''}`);

  const matcher = (text) => regex.test(text);
  matcherCache.set(keyword, matcher);
  return matcher;
}

/**
 * Scores keyword hits for one group.
 *
 * Multi-word keywords score higher than single words: "खून की कमी" (anaemia) is a far
 * stronger signal than the lone verb "खाएँ" (eat), so "खून की कमी के लिए क्या खाएँ"
 * resolves to the anaemia answer rather than the diabetes diet answer.
 */
function groupHits(normalisedText, group) {
  let score = 0;
  for (const keyword of group) {
    if (!matcherFor(keyword)(normalisedText)) continue;
    score += normalise(keyword).includes(' ') ? 3 : 1;
  }
  return score;
}

/**
 * Picks the best intent for a question.
 *
 * @param {string} question
 * @returns {{intent: object|null, score: number}}
 */
export function matchIntent(question) {
  const text = normalise(question);
  if (!text) return { intent: null, score: 0 };

  let best = { intent: null, score: 0 };

  for (const intent of CHATBOT_INTENTS) {
    let total = 0;
    let allGroupsMatched = true;

    for (const group of intent.groups) {
      const hits = groupHits(text, group);
      if (hits === 0) {
        allGroupsMatched = false;
        break;
      }
      total += hits;
    }

    if (!allGroupsMatched) continue;

    const score = total + intent.weight;
    if (score > best.score) best = { intent, score };
  }

  return best;
}

/**
 * Answers a question in the requested language.
 *
 * @param {string} question
 * @param {'bn'|'hi'|'en'} [language='en']
 * @returns {{matched: boolean, intentId: string, title: string, points: string[],
 *   disclaimer: string, escalate: boolean, language: string, suggestions: string[],
 *   version: string}}
 */
export function answerQuestion(question, language = 'en') {
  const lang = SUPPORTED_CHATBOT_LANGUAGES.includes(language) ? language : 'en';
  const { intent } = matchIntent(question);

  if (!intent) {
    return {
      matched: false,
      intentId: 'fallback',
      title: CHATBOT_FALLBACK[lang].title,
      points: CHATBOT_FALLBACK[lang].points,
      disclaimer: CHATBOT_DISCLAIMER[lang],
      escalate: false,
      language: lang,
      suggestions: CHATBOT_SUGGESTIONS[lang],
      version: CHATBOT_VERSION,
    };
  }

  const answer = intent.answers[lang];
  return {
    matched: true,
    intentId: intent.id,
    title: answer.title,
    points: answer.points,
    disclaimer: CHATBOT_DISCLAIMER[lang],
    escalate: Boolean(intent.escalate),
    language: lang,
    suggestions: CHATBOT_SUGGESTIONS[lang],
    version: CHATBOT_VERSION,
  };
}
