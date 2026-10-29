// Words in French, Urdu and Hindi that the rules need everywhere (the emergency
// warning signs), and the text folding that lets them match what people say or
// type: French accents are optional ("tete" = "tête"), Hindi nukta and
// chandrabindu spellings are unified, and Urdu, Hindi and Arabic digits become 0-9.
// This is vocabulary for showing urgent-help guidance — never a diagnosis.

const DIGITS: Record<string, string> = {};
'٠١٢٣٤٥٦٧٨٩'.split('').forEach((d, i) => { DIGITS[d] = String(i); });
'۰۱۲۳۴۵۶۷۸۹'.split('').forEach((d, i) => { DIGITS[d] = String(i); });
'०१२३४५६७८९'.split('').forEach((d, i) => { DIGITS[d] = String(i); });

/** Unicode folding shared by every language: digits, French accents, Hindi spelling variants, typographic apostrophes. */
export function foldText(text: string): string {
  return text
    .replace(/[٠-٩۰-۹०-९]/g, (d) => DIGITS[d] ?? d)
    .replace(/[’ʼ`]/g, "'")
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // Latin accents (é → e)
    .replace(/़/g, '') // Devanagari nukta (ज़ → ज)
    .replace(/ँ/g, 'ं') // chandrabindu → anusvara (हाँ → हां)
    .normalize('NFC');
}

/** Regular expression whose source is folded the same way as the text it is tested on. */
const R = (src: string) => new RegExp(foldText(src), 'i');

/** Emergency warning signs said in French, Urdu or Hindi (incl. Roman Urdu/Hindi). Reasons are the app's English reason texts. */
export const SAFETY_WORDS: { re: RegExp; reason: 'chest pain or pressure' | 'difficulty breathing' | 'fainting' | 'face or speech changes' | 'a sudden, very severe headache' | 'thoughts of self-harm' | 'heavy bleeding' }[] = [
  // French
  { re: R("(douleur|mal|pression|serrement|oppression|poids|brulure)s?\\s*(a|au niveau de|dans)?\\s*(la\\s*|ma\\s*)?poitrine|poitrine\\s*(serree|qui serre|me fait mal|douloureuse|oppressee)|douleur thoracique|mal au thorax"), reason: 'chest pain or pressure' },
  { re: R("(n'?\\s*arrive|n'?\\s*arrivons)\\s*(pas|plus)\\s*a\\s*respirer|du mal a respirer|difficultes?\\s*(a|pour)\\s*respirer|j'?\\s*etouffe|je suffoque|manque d'?\\s*air|souffle court|je ne peux (pas|plus) respirer|essouffle"), reason: 'difficulty breathing' },
  { re: R("evanoui|perdu connaissance|perte de connaissance|tombe dans les pommes"), reason: 'fainting' },
  { re: R("visage\\s*(paralyse|qui tombe|tombant|deforme|de travers)|bouche\\s*(de travers|tordue)|(du mal|difficultes?)\\s*a\\s*parler|n'?\\s*arrive (pas|plus) a parler|je ne peux (pas|plus) parler|parole\\s*(confuse|difficile|pateuse)|bafouill|j'?\\s*articule mal"), reason: 'face or speech changes' },
  { re: R("pire mal de tete|mal de tete\\s*(soudain|brutal)\\s*(et\\s*)?(tres\\s*)?(violent|terrible|insupportable|intense)|(soudain|brutal)\\w*\\s*mal de tete\\s*(tres\\s*)?(violent|terrible|insupportable)|coup de tonnerre"), reason: 'a sudden, very severe headache' },
  { re: R("suicid|me tuer|en finir avec (la|ma) vie|mettre fin a (mes jours|ma vie)|me faire du mal|envie de mourir|je veux mourir"), reason: 'thoughts of self-harm' },
  { re: R("saigne\\s*(beaucoup|enormement|sans arret|abondamment)|saignement\\s*(abondant|important|qui ne s'?\\s*arrete pas)|hemorragie|vomi\\w*\\s*du sang|crache\\w*\\s*du sang|tousse\\w*\\s*du sang"), reason: 'heavy bleeding' },
  // Urdu
  { re: R('(سینے|سینہ|چھاتی)\\s*(میں|پر)?\\s*(شدید\\s*)?(درد|دباؤ|دباو|بوجھ|جکڑن|کھنچاؤ|بھاری\\s*پن)|دل\\s*(میں|کے\\s*پاس)\\s*درد'), reason: 'chest pain or pressure' },
  { re: R('سانس\\s*(نہیں\\s*آ|لینے\\s*میں\\s*(مشکل|دقت|تکلیف|پریشانی)|پھول|رک|اکھڑ|بند)|دم\\s*گھٹ'), reason: 'difficulty breathing' },
  { re: R('بے\\s*ہوش|بیہوش|ہوش\\s*کھو'), reason: 'fainting' },
  { re: R('(بولنے|بات\\s*کرنے)\\s*میں\\s*(مشکل|دقت|تکلیف|پریشانی)|زبان\\s*(لڑکھڑا|بھاری|موٹی)|(منہ|چہرہ|چہرے)\\s*(ٹیڑھا|لٹک|ایک\\s*طرف)|آدھا\\s*جسم|آدھے\\s*جسم'), reason: 'face or speech changes' },
  { re: R('(اچانک).{0,30}(شدید|بہت\\s*تیز|ناقابل\\s*برداشت).{0,20}سر\\s*(میں\\s*)?درد|سر\\s*(میں\\s*)?درد.{0,30}اچانک.{0,20}(شدید|بہت\\s*تیز|ناقابل\\s*برداشت)|(اچانک|شدید).{0,10}(شدید|اچانک).{0,10}سر\\s*(میں\\s*)?درد|بدترین\\s*سر\\s*درد'), reason: 'a sudden, very severe headache' },
  { re: R('خودکشی|خود\\s*کشی|اپنے\\s*آپ\\s*کو\\s*(مار|نقصان|ختم)|خود\\s*کو\\s*(مار|نقصان|ختم)|مرنا\\s*چاہت|جان\\s*دے\\s*دوں'), reason: 'thoughts of self-harm' },
  { re: R('خون.{0,20}(نہیں\\s*رک|بہت\\s*زیادہ|بند\\s*نہیں)|خون\\s*کی\\s*(الٹی|قے)|کھانسی\\s*(میں|کے\\s*ساتھ)\\s*خون'), reason: 'heavy bleeding' },
  // Hindi
  { re: R('(सीने|सीना|छाती)\\s*(में|पर)?\\s*(तेज़\\s*)?(दर्द|दबाव|भारीपन|जकड़न|जलन)|दिल\\s*(में|के\\s*पास)\\s*दर्द'), reason: 'chest pain or pressure' },
  { re: R('सांस\\s*(नहीं\\s*आ|लेने\\s*में\\s*(दिक्कत|तकलीफ|परेशानी|मुश्किल)|फूल|रुक|अटक|बंद)|दम\\s*घुट'), reason: 'difficulty breathing' },
  { re: R('बेहोश|होश\\s*खो'), reason: 'fainting' },
  { re: R('(बोलने|बात\\s*करने)\\s*में\\s*(दिक्कत|तकलीफ|परेशानी|मुश्किल)|(जुबान|जबान)\\s*(लड़खड़ा|भारी)|(मुंह|चेहरा|चेहरे)\\s*(टेढ़ा|लटक|एक\\s*तरफ)|आधा\\s*शरीर|आधे\\s*शरीर'), reason: 'face or speech changes' },
  { re: R('अचानक.{0,30}(बहुत\\s*तेज|भयंकर|असहनीय).{0,20}सिर\\s*(में\\s*)?दर्द|सिर\\s*(में\\s*)?दर्द.{0,30}अचानक.{0,20}(बहुत\\s*तेज|भयंकर|असहनीय)|(अचानक|भयंकर).{0,10}(भयंकर|अचानक).{0,10}सिर\\s*(में\\s*)?दर्द|सबसे\\s*(बुरा|भयंकर)\\s*सिर\\s*दर्द'), reason: 'a sudden, very severe headache' },
  { re: R('आत्महत्या|खुद\\s*को\\s*(मार|नुकसान|खत्म)|अपने\\s*आप\\s*को\\s*(मार|नुकसान|खत्म)|मरना\\s*चाहत|जान\\s*दे\\s*दूं'), reason: 'thoughts of self-harm' },
  { re: R('खून.{0,20}(नहीं\\s*रुक|बहुत\\s*ज्यादा|बंद\\s*नहीं)|खून\\s*की\\s*उल्टी|खांसी\\s*(में|के\\s*साथ)\\s*खून'), reason: 'heavy bleeding' },
  // Roman Urdu / Hindi
  { re: R('\\b(seene|sine|seena|chhati|chati|chaati)\\s*(me|mein|main|par)?\\s*(dard|dabav|dabao|bhari)'), reason: 'chest pain or pressure' },
  { re: R('\\b(saa?ns)\\s*(nahi|nahin|lene\\s*(me|mein)\\s*(mushkil|dikkat|takleef)|phool|ruk)'), reason: 'difficulty breathing' },
  { re: R('\\b(behosh|be hosh)\\b'), reason: 'fainting' },
  { re: R('\\b(khud ?kushi|aatmhatya|atmahatya)\\b'), reason: 'thoughts of self-harm' },
];

/** Reasons for the emergency signs in the text (French, Urdu, Hindi), tested on the raw and the folded text. */
export function safetyReasons(text: string): string[] {
  const f = foldText(text.toLowerCase());
  return [...new Set(SAFETY_WORDS.filter((k) => k.re.test(text) || k.re.test(f)).map((k) => k.reason))];
}

/** "Help me now" in any of the app's languages (shown urgent guidance outside a consultation too). */
export const HELP_NOW = R("\\b(help me now|emergency|i need help now|call (an )?ambulance)\\b|الحقوني|طوارئ|إسعاف|اسعاف|محتاج مساعدة دلوقتي|a l'?\\s*aide|au secours|urgence|appelez (une ambulance|le samu|les secours)|ایمرجنسی|ایمبولینس|بچاؤ|فوری\\s*مدد|इमरजेंसी|एम्बुलेंस|एंबुलेंस|बचाओ|तुरंत\\s*मदद");

/** AI wording that diagnoses, suggests medicine or falsely reassures — in French, Urdu, Hindi (the reply is then not used). */
export const BAD_REPLY_MORE = [
  R("diagnost|vous avez (probablement|surement|peut-etre|sans doute) (un|une|la|le)\\b|c'?\\s*est (probablement|surement|peut-etre|sans doute)? ?(un |une )?(migraine|infection|virus|grippe|avc|crise cardiaque|infarctus|cancer|tumeur|appendicite|ulcere|gastrite|sinusite|meningite|covid)|(prenez|prends|prendre) (du |un |une |des |de l'?\\s*)?(paracetamol|doliprane|ibuprofene|advil|aspirine|medicament|comprime|cachet)|ne (vous )?(t'?\\s*)?inquiet(ez|e) pas|rien de grave|ce n'?\\s*est (pas grave|rien)|vous (irez|allez aller) bien|ca va aller|sans danger|je suis (un |une )?medecin|en tant que medecin"),
  R('تشخیص|آپ کو (شاید|غالباً|غالبا|یقیناً|یقینا)|یہ (شاید |غالباً |غالبا )?(مائگرین|انفیکشن|وائرس|فلو|فالج|ہارٹ اٹیک|کینسر|رسولی|السر)|(دوا|گولی|پیناڈول|پیراسیٹامول|بروفین|اسپرین)\\s*(لیں|لے لیں|کھا لیں|کھائیں)|پریشان نہ ہوں|فکر نہ (کریں|کرو)|کوئی خطرہ نہیں|کچھ نہیں ہوگا|ٹھیک ہو جائیں گے|سنگین نہیں|میں ڈاکٹر ہوں'),
  R('निदान|डायग्नो|आपको (शायद|जरूर|ज़रूर)|यह (शायद )?(माइग्रेन|इन्फेक्शन|संक्रमण|वायरस|फ्लू|स्ट्रोक|लकवा|हार्ट अटैक|कैंसर|ट्यूमर|अल्सर)|(दवा|गोली|पैरासिटामोल|क्रोसिन|आइबुप्रोफेन|एस्पिरिन)\\s*(लें|ले लें|खा लें|खाएं)|चिंता (मत|न) (करें|करो|कीजिए)|घबराइए मत|घबराओ मत|कोई खतरा नहीं|कुछ नहीं होगा|ठीक हो जाएंगे|गंभीर नहीं|मैं डॉक्टर हूं'),
];
export const badReplyMore = (t: string) => { const f = foldText(t.toLowerCase()); return BAD_REPLY_MORE.some((re) => re.test(t) || re.test(f)); };

/** How the AI is asked to write in each language. */
export const AI_LANG: Record<string, string> = {
  en: 'warm, plain English',
  ar: 'warm, simple Egyptian Arabic (no English words unless the patient used them)',
  fr: 'warm, simple French (use "vous"; no English words unless the patient used them)',
  ur: 'warm, simple Urdu written in Urdu script (use "آپ"; even if the patient types Roman Urdu; no English words unless the patient used them)',
  hi: 'warm, simple Hindi written in Devanagari script (use "आप"; even if the patient types Roman Hindi; no English words unless the patient used them)',
};
/** Language names for prompts */
export const LANG_NAME: Record<string, string> = { en: 'English', ar: 'Arabic', fr: 'French', ur: 'Urdu', hi: 'Hindi' };
