// AccessCare Voice Companion — the conversation engine (UI-independent, testable).
//
// What it does: runs Blind Mode's menus (account, doctor, messages, settings),
// understands answers by matching words in English or Arabic, handles
// "repeat", "back", "help", "menu" and urgent words, and asks the app to
// perform actions (sign up, send a report, read messages…) through `effects`.
//
// The consultation itself (describing symptoms) is a conversation run by
// services/conversation (AI when allowed, rules otherwise): this engine hands
// each answer to it through the `converse` effect and speaks what comes back.
// Menus, accounts, messages and settings are handled here by rules. When words
// in a menu don't match an option, the app may ask Claude to interpret them;
// the interpretation is read back and needs a "yes" before it counts.

import { assessSafety } from '../safety';
import type { VoiceLang } from '../../domain/voice';
import type { ConsultRecord, Via } from '../../domain/conversation';
import type { ConsultInput } from '../conversation/Consult';
import { spokenSummary, summaryLines as consultSummary, urgentText } from '../conversation/Consult';

export type Phase =
  | 'pre_welcome' | 'pre_consent' | 'pre_name' | 'pre_name_confirm' | 'pre_password' | 'pre_login' | 'pre_recover'
  | 'id_readout' | 'recovery_readout' | 'doctor_ask' | 'doctor_entry' | 'doctor_confirm' | 'ai_consent'
  | 'menu' | 'consult'
  | 'review' | 'send_confirm' | 'reject_confirm'
  | 'messages' | 'reply' | 'reply_confirm' | 'settings' | 'logout_confirm' | 'urgent' | 'done';

export interface Option { id: string; label: string; hint?: string }

export interface Msg { from: 'doctor' | 'patient'; body: string; at: string; cid: string; status?: string }

export interface DialogState {
  phase: Phase;
  lang: VoiceLang;
  /** the consultation conversation (owned by services/conversation) */
  consult?: ConsultRecord;
  consultOptions?: Option[];
  /** what the conversation said last (repeated after urgent guidance) */
  consultSay?: string[];
  pending?: { id: string; label: string; via: 'ai' | 'hint' };
  returnTo?: Phase;
  name?: string;
  patientCode?: string;
  recoveryCode?: string;
  doctorName?: string;
  doctorLookup?: { id: string; name: string };
  messages: Msg[]; msgIndex: number; replyDraft?: string; replyCid?: string;
  lastSay: string[];
  urgentShown: string[];
  misses: number;
}

export interface Ctx {
  signedIn: boolean;
  /** backend saves to a shared server (cross-device) */
  shared: boolean;
  /** login is the Claude account (no email needed) */
  claudeAccount: boolean;
  aiSupported: boolean;
  aiOn: boolean;
  doctorName?: string | null;
}

export type Effect =
  | { type: 'show_signup' } | { type: 'show_login' } | { type: 'show_recover' }
  | { type: 'create_recovery' } | { type: 'save_recovery_file' }
  | { type: 'lookup_doctor'; code: string } | { type: 'connect_doctor'; code: string }
  | { type: 'enable_ai'; on: boolean }
  | { type: 'consult_start'; change: boolean }
  | { type: 'converse'; input: ConsultInput }
  | { type: 'send_report'; toDoctor: boolean }
  | { type: 'load_messages' } | { type: 'send_reply'; cid: string; text: string } | { type: 'load_doctor' }
  | { type: 'settings'; change: 'faster' | 'slower' | 'normal' | 'lang_en' | 'lang_ar' | 'brief' | 'full' | 'gestures_on' | 'gestures_off' | 'reset' }
  | { type: 'logout' } | { type: 'open_signal' } | { type: 'listen' } | { type: 'nomatch'; text: string; options: Option[] };

export type Input =
  | { kind: 'start'; consult?: boolean }
  | { kind: 'utterance'; text: string; via?: Via }
  | { kind: 'choice'; id: string }
  | { kind: 'ai_guess'; id: string | null }
  /** a short AI reply to something that was not an answer; the question is then asked again */
  | { kind: 'ai_reply'; text: string }
  | { kind: 'event'; name: 'signed_up' | 'logged_in' | 'recovery_created' | 'doctor_found' | 'doctor_not_found' | 'doctor_connected'
      | 'sent' | 'saved' | 'send_failed' | 'messages' | 'reply_sent' | 'doctor_info' | 'settings_changed' | 'action_failed' | 'urgent' | 'consult_turn';
      data?: Record<string, unknown> };

export interface Turn { state: DialogState; say: string[]; options: Option[]; effects: Effect[]; listen: boolean }

// ---------------------------------------------------------------- vocabulary
type Lex = Record<string, { en: string[]; ar: string[] }>;
/** words that select an option; matched as whole words / phrases in the patient's utterance */
const LEX: Lex = {
  yes: { en: ['yes', 'yeah', 'yep', 'correct', 'right', 'sure', 'okay', 'ok', 'that is right', "that's right", 'confirm', 'send it', 'go ahead'], ar: ['نعم', 'ايوه', 'أيوه', 'ايوة', 'أيوة', 'اه', 'آه', 'أه', 'تمام', 'صح', 'مظبوط', 'موافق', 'ماشي', 'اكيد', 'أكيد', 'اوك', 'أرسل', 'ابعت'] },
  no: { en: ['no', 'nope', 'not right', 'wrong', 'incorrect', "don't", 'do not', 'cancel'], ar: ['لا', 'لأ', 'لاء', 'مش صح', 'غلط', 'لا مش', 'الغاء', 'إلغاء'] },
  skip: { en: ['skip', 'next question', 'pass'], ar: ['تخطي', 'تخطى', 'عدي', 'السؤال اللي بعده', 'سيبه'] },
  repeat: { en: ['repeat', 'say again', 'say that again', 'again', 'what did you say', 'pardon'], ar: ['كرر', 'عيد', 'تاني', 'قول تاني', 'أعد', 'اعد', 'مسمعتش', 'ما سمعتش'] },
  back: { en: ['back', 'go back', 'previous', 'undo'], ar: ['رجوع', 'ارجع', 'السابق', 'اللي قبله'] },
  help: { en: ['help', 'what can i say', 'options', 'what are my options'], ar: ['مساعدة', 'ساعدني', 'اقول ايه', 'أقول إيه', 'الاختيارات'] },
  menu: { en: ['main menu', 'menu', 'start over', 'home'], ar: ['القائمة', 'القايمة', 'الرئيسية', 'البداية', 'من الأول'] },
  continue: { en: ['continue', 'go on', 'done', 'carry on', 'next step'], ar: ['كمل', 'كمّل', 'خلاص', 'استمر', 'بعد كده'] },
  save: { en: ['save', 'keep', 'download', 'save it'], ar: ['احفظ', 'حفظ', 'نزله', 'احفظه'] },
  slow: { en: ['slowly', 'slow', 'spell', 'spell it'], ar: ['ببطء', 'براحة', 'تهجى', 'تهجّى', 'حرف حرف'] },
  // menu
  new_consult: { en: ['new consultation', 'consultation', 'symptom', 'symptoms', 'report', 'not feeling well', 'i feel', 'pain', 'hurts', 'start'], ar: ['استشارة', 'إستشارة', 'استشاره', 'أعراض', 'اعراض', 'تعبان', 'تعبانة', 'عندي', 'بيوجعني', 'وجع', 'ألم', 'ابدأ', 'ابدا'] },
  messages: { en: ['messages', 'message', 'inbox', 'reply', 'did my doctor answer', 'answers'], ar: ['رسائل', 'رسايل', 'الرسائل', 'رسالة', 'الرد', 'رد الدكتور'] },
  doctor: { en: ['my doctor', 'doctor', 'who is my doctor', 'status'], ar: ['دكتوري', 'الدكتور', 'الطبيب', 'مين الدكتور', 'الحالة'] },
  my_id: { en: ['my id', 'patient id', 'my patient id', 'id', 'account'], ar: ['رقمي', 'الرقم', 'رقم المريض', 'الكود', 'الهوية', 'حسابي'] },
  settings: { en: ['settings', 'speed', 'language', 'voice', 'faster', 'slower'], ar: ['الإعدادات', 'الاعدادات', 'السرعة', 'اللغة', 'الصوت', 'أسرع', 'أبطأ', 'ابطأ', 'اسرع'] },
  logout: { en: ['log out', 'logout', 'sign out', 'exit'], ar: ['تسجيل الخروج', 'خروج', 'اخرج', 'سجل خروج'] },
  // pre-login
  new_account: { en: ['new account', 'create', 'sign up', 'register', 'new'], ar: ['حساب جديد', 'جديد', 'انشاء', 'إنشاء', 'سجلني', 'تسجيل جديد'] },
  login: { en: ['log in', 'login', 'sign in', 'i have an account', 'existing'], ar: ['تسجيل الدخول', 'دخول', 'عندي حساب', 'ادخل'] },
  recover: { en: ['forgot', 'recover', 'reset password', 'recovery'], ar: ['نسيت', 'استرجاع', 'استعادة', 'كلمة السر'] },
  // review
  approve: { en: ['approve', 'send', 'yes send', 'looks good', 'that is correct', 'all correct'], ar: ['موافق', 'ابعت', 'إرسال', 'ارسل', 'تمام كده', 'صح كده', 'كله صح'] },
  change: { en: ['change', 'correct', 'fix', 'edit', 'wrong'], ar: ['غير', 'غيّر', 'تعديل', 'عدل', 'صحح', 'غلط'] },
  reject: { en: ['reject', 'discard', 'delete', 'do not send', "don't send", 'cancel report'], ar: ['ارفض', 'رفض', 'امسح', 'الغي', 'متبعتش', 'ما تبعتش'] },
  // messages
  next: { en: ['next', 'next message', 'older'], ar: ['التالي', 'اللي بعده', 'بعده', 'الرسالة اللي بعدها'] },
  previous: { en: ['previous', 'previous message', 'newer'], ar: ['السابق', 'اللي قبله', 'قبله'] },
  reply: { en: ['reply', 'answer', 'respond', 'write back'], ar: ['رد', 'أرد', 'ارد', 'جاوب'] },
  // settings
  set_faster: { en: ['faster', 'speak faster', 'quicker'], ar: ['أسرع', 'اسرع', 'بسرعة'] },
  set_slower: { en: ['slower', 'speak slower', 'slow down'], ar: ['أبطأ', 'ابطأ', 'براحة', 'على مهلك', 'بالراحة'] },
  set_normal: { en: ['normal speed', 'normal'], ar: ['عادي', 'السرعة العادية'] },
  set_ar: { en: ['arabic'], ar: ['عربي', 'العربية', 'عربى'] },
  set_en: { en: ['english'], ar: ['انجليزي', 'إنجليزي', 'الانجليزية'] },
  set_brief: { en: ['brief', 'short', 'less talking'], ar: ['مختصر', 'باختصار', 'كلام أقل'] },
  set_full: { en: ['full', 'detailed', 'explain more'], ar: ['تفصيل', 'بالتفصيل', 'اشرح أكتر'] },
  set_gestures_off: { en: ['gestures off', 'turn off gestures', 'screen reader'], ar: ['اقفل الإشارات', 'من غير سحب', 'قارئ الشاشة'] },
  set_gestures_on: { en: ['gestures on', 'turn on gestures'], ar: ['شغل الإشارات', 'السحب'] },
  set_ai: { en: ['ai', 'artificial intelligence', 'ai assistance', 'claude'], ar: ['الذكاء الاصطناعي', 'ذكاء اصطناعي', 'الذكاء', 'كلود'] },
  set_reset: { en: ['reset', 'defaults', 'restore defaults'], ar: ['الافتراضي', 'رجع الإعدادات', 'إعادة الضبط'] },
};

const AR_DIGITS: Record<string, string> = { '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9' };
const NUMBER_WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  'صفر': 0, 'واحد': 1, 'اتنين': 2, 'اثنين': 2, 'تلاتة': 3, 'ثلاثة': 3, 'اربعة': 4, 'أربعة': 4, 'خمسة': 5, 'ستة': 6, 'سبعة': 7, 'تمانية': 8, 'ثمانية': 8, 'تسعة': 9, 'عشرة': 10,
};

export function normalize(text: string): string {
  return ` ${text.toLowerCase().replace(/[٠-٩]/g, (d) => AR_DIGITS[d]).replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
    .replace(/[^\p{L}\p{N}' ]+/gu, ' ').replace(/\s+/g, ' ').trim()} `;
}
const norm1 = (w: string) => normalize(w).trim();

/** Score of how well an utterance matches a lexicon entry (longest phrase wins). 0 = no match. */
function score(utt: string, key: string): number {
  const e = LEX[key]; if (!e) return 0;
  let best = 0;
  for (const w of [...e.en, ...e.ar]) {
    const n = norm1(w);
    if (n && utt.includes(` ${n} `)) best = Math.max(best, n.length);
  }
  return best;
}

/** Picks the option whose words appear in the utterance; ambiguous ties return null. */
export function matchOption(text: string, keys: string[]): string | null {
  const utt = normalize(text);
  let top: string | null = null, topScore = 0, tie = false;
  for (const k of keys) {
    const s = score(utt, k);
    if (s > topScore) { top = k; topScore = s; tie = false; } else if (s && s === topScore) tie = true;
  }
  return tie ? null : top;
}

export function spokenNumber(text: string): number | null {
  const utt = normalize(text);
  const m = utt.match(/\b(10|[0-9])\b/);
  if (m) return Number(m[1]);
  for (const [w, n] of Object.entries(NUMBER_WORDS)) if (utt.includes(` ${norm1(w)} `)) return n;
  return null;
}

const GLOBAL = ['repeat', 'back', 'help', 'menu'];

// ---------------------------------------------------------------- strings
type Str = Record<string, { en: string; ar: string }>;
const S: Str = {
  welcome: { en: 'Blind Mode is active. Welcome to AccessCare AI. I will guide you using voice.', ar: 'الوضع الصوتي شغال. أهلاً بيك في أكسس كير. هساعدك بالصوت خطوة بخطوة.' },
  pre_q: { en: 'Do you want to create a new account, or log in? You can also say: I forgot my password.', ar: 'عايز تعمل حساب جديد، ولا تسجل دخول؟ وممكن تقول: نسيت كلمة السر.' },
  controls: { en: 'At any time say repeat, back, help, or main menu.', ar: 'في أي وقت قول: كرر، أو رجوع، أو مساعدة، أو القائمة.' },
  consent_shared: { en: 'I will create a patient account saved in the shared AccessCare database, linked to your Claude account. On another device, open AccessCare in Claude with the same Claude account and enter your password.', ar: 'هعملك حساب مريض محفوظ في قاعدة بيانات أكسس كير المشتركة ومربوط بحساب Claude بتاعك. على أي جهاز تاني، افتح أكسس كير جوه Claude بنفس الحساب واكتب كلمة السر.' },
  consent_local: { en: 'I will create a patient account saved only on this device. It is not synced to other devices.', ar: 'هعملك حساب مريض محفوظ على الجهاز ده بس، ومش هيتنقل لأجهزة تانية.' },
  consent_q: { en: 'Shall I create it? Say yes or no.', ar: 'أعمله؟ قول نعم أو لا.' },
  name_q: { en: 'Please say your full name.', ar: 'قول اسمك بالكامل من فضلك.' },
  name_confirm: { en: 'I heard: {name}. Is that right?', ar: 'سمعت: {name}. صح كده؟' },
  password_q: { en: 'Now type a password of at least 8 characters in the password field, then type it again and press Enter. I will not read it aloud. If you use a screen reader, it can read the keys as you type.', ar: 'دلوقتي اكتب كلمة سر ٨ حروف على الأقل في خانة كلمة السر، واكتبها تاني، ودوس إنتر. أنا مش هقولها بصوت عالي. لو بتستخدم قارئ الشاشة، هيقرالك الحروف وانت بتكتب.' },
  login_q_claude: { en: 'Type your AccessCare password in the password field and press Enter. Your Claude account identifies you.', ar: 'اكتب كلمة سر أكسس كير في الخانة ودوس إنتر. حساب Claude بتاعك هو اللي بيعرّفك.' },
  login_q_local: { en: 'Type your Patient ID or email in the first field, then your password, and press Enter.', ar: 'اكتب رقم المريض أو الإيميل في أول خانة، وبعدين كلمة السر، ودوس إنتر.' },
  recover_q: { en: 'Type your recovery code and a new password, then press Enter.', ar: 'اكتب كود الاسترجاع وكلمة سر جديدة، ودوس إنتر.' },
  recover_q_local: { en: 'Type your Patient ID or email, your recovery code, and a new password, then press Enter.', ar: 'اكتب رقم المريض أو الإيميل، وكود الاسترجاع، وكلمة سر جديدة، ودوس إنتر.' },
  created: { en: 'Your account is created.', ar: 'حسابك اتعمل.' },
  id_is: { en: 'Your Patient ID is: {spelled}.', ar: 'رقم المريض بتاعك هو: {spelled}.' },
  id_note: { en: 'It is an identifier you can share with your doctor. It is not a password. Say repeat, spell it slowly, or continue.', ar: 'ده رقم تعريف تقدر تديه لدكتورك، ومش كلمة سر. قول: كرر، أو تهجّى ببطء، أو كمّل.' },
  rec_warn: { en: 'Next I will read your recovery code. It lets you set a new password if you forget yours, so keep it private. Make sure nobody can hear, or use headphones.', ar: 'دلوقتي هقرالك كود الاسترجاع. ده بيخليك تغير كلمة السر لو نسيتها، فخليه سر. اتأكد إن محدش سامع، أو استخدم سماعات.' },
  rec_is: { en: 'Your recovery code is: {spelled}.', ar: 'كود الاسترجاع بتاعك: {spelled}.' },
  rec_note: { en: 'Write it down, or say save to keep it as a file. Say repeat, save, or continue.', ar: 'اكتبه في مكان، أو قول احفظ علشان يتحفظ كملف. قول: كرر، أو احفظ، أو كمّل.' },
  doctor_ask: { en: 'Do you have a Doctor ID from your doctor? Say yes or no.', ar: 'معاك رقم الدكتور (Doctor ID) من دكتورك؟ قول نعم أو لا.' },
  doctor_entry: { en: 'Type the Doctor ID in the field, or say it letter by letter. It starts with A C D O C.', ar: 'اكتب رقم الدكتور في الخانة، أو قوله حرف حرف. بيبدأ بـ A C D O C.' },
  doctor_found: { en: 'This Doctor ID belongs to {name}. Connect to this doctor? Say yes or no.', ar: 'رقم الدكتور ده تبع {name}. أربطك بيه؟ قول نعم أو لا.' },
  doctor_nf: { en: 'I could not find that Doctor ID. Try again, or say skip.', ar: 'ملقيتش رقم الدكتور ده. جرّب تاني، أو قول تخطي.' },
  doctor_ok: { en: 'You are connected to {name}.', ar: 'اتربطت بـ {name}.' },
  ai_q: { en: 'Claude AI can help me understand your words and phrase answers. If you agree, the words you say during reports are sent to Claude, the AI service from Anthropic. Your name and account are never sent. Do you want AI help? Say yes or no.', ar: 'ذكاء Claude الاصطناعي ممكن يساعدني أفهم كلامك وأرد بشكل أوضح. لو وافقت، الكلام اللي بتقوله في التقارير هيتبعت لـ Claude (خدمة الذكاء الاصطناعي من Anthropic)، لكن اسمك وحسابك عمرهم ما بيتبعتوا. عايز مساعدة الذكاء الاصطناعي؟ قول نعم أو لا.' },
  ai_unavailable: { en: 'AI help is not available in this version, so I will use simple guided questions.', ar: 'مساعدة الذكاء الاصطناعي مش متاحة في النسخة دي، فهسألك أسئلة بسيطة.' },
  menu_q: { en: 'What would you like to do? You can say: new consultation, my messages, my doctor, my Patient ID, settings, or log out.', ar: 'عايز تعمل إيه؟ تقدر تقول: استشارة جديدة، أو رسايلي، أو دكتوري، أو رقمي، أو الإعدادات، أو تسجيل الخروج.' },
  menu_q_brief: { en: 'What would you like to do?', ar: 'عايز تعمل إيه؟' },
  welcome_back: { en: 'Welcome back to AccessCare AI.', ar: 'أهلاً بيك تاني في أكسس كير.' },
  review_intro: { en: 'Here is the summary for your doctor.', ar: 'ده الملخص اللي هيروح لدكتورك.' },
  review_q: { en: 'Is this correct? Say approve, change, or reject. Say repeat to hear it again.', ar: 'كده صح؟ قول موافق، أو غيّر، أو ارفض. وقول كرر لو عايز تسمعه تاني.' },
  send_q: { en: 'Send this summary to {name} now? Say yes to send, or no to go back.', ar: 'أبعت الملخص ده لـ {name} دلوقتي؟ قول نعم علشان أبعته، أو لا علشان نرجع.' },
  save_q: { en: 'You are not connected to a doctor yet, so I can save it but not send it. Save it? Say yes or no.', ar: 'انت لسه مش مربوط بدكتور، فأقدر أحفظه بس مش أبعته. أحفظه؟ قول نعم أو لا.' },
  reject_q: { en: 'Discard this summary? Nothing will be sent. Say yes or no.', ar: 'أمسح الملخص ده؟ مش هيتبعت حاجة. قول نعم أو لا.' },
  rejected: { en: 'Discarded. Nothing was sent.', ar: 'اتمسح. متبعتش حاجة.' },
  sent: { en: 'Sent to {name}. Your doctor will see exactly what you approved.', ar: 'اتبعت لـ {name}. الدكتور هيشوف بالظبط اللي انت وافقت عليه.' },
  saved: { en: 'Saved. It was not sent because you are not connected to a doctor.', ar: 'اتحفظ. متبعتش لأنك مش مربوط بدكتور.' },
  failed: { en: 'Sorry, that did not work: {error}. Nothing was sent.', ar: 'آسف، ما نجحش: {error}. متبعتش حاجة.' },
  msgs_none: { en: 'You have no messages from your doctor yet.', ar: 'مفيش رسايل من الدكتور لسه.' },
  msgs_count: { en: 'You have {n} message(s). The newest first.', ar: 'عندك {n} رسالة. الأحدث الأول.' },
  msg_read: { en: 'From {from}, {when}: {body}', ar: 'من {from}، {when}: {body}' },
  msg_q: { en: 'Say next, previous, reply, or main menu.', ar: 'قول التالي، أو السابق، أو رد، أو القائمة.' },
  reply_q: { en: 'Say your reply now.', ar: 'قول ردك دلوقتي.' },
  reply_confirm: { en: 'Your reply is: {text}. Send it? Say yes, or no to say it again.', ar: 'ردك: {text}. أبعته؟ قول نعم، أو لا علشان تقوله تاني.' },
  reply_sent: { en: 'Your reply was sent.', ar: 'ردك اتبعت.' },
  doctor_is: { en: 'Your doctor is {name}.', ar: 'دكتورك هو {name}.' },
  doctor_none: { en: 'You are not connected to a doctor yet.', ar: 'انت لسه مش مربوط بدكتور.' },
  status_line: { en: 'Your latest consultation: {status}.', ar: 'آخر استشارة ليك: {status}.' },
  settings_q: { en: 'Settings. Say faster, slower, normal speed, Arabic, English, brief, detailed, gestures off, gestures on, or reset. Say main menu when done.', ar: 'الإعدادات. قول أسرع، أو أبطأ، أو عادي، أو عربي، أو إنجليزي، أو مختصر، أو بالتفصيل، أو اقفل الإشارات، أو شغل الإشارات، أو الافتراضي. وقول القائمة لما تخلص.' },
  settings_done: { en: 'Done.', ar: 'تمام.' },
  logout_q: { en: 'Log out of AccessCare on this device? Say yes or no.', ar: 'تسجل خروج من أكسس كير على الجهاز ده؟ قول نعم أو لا.' },
  logged_out: { en: 'You are logged out.', ar: 'تم تسجيل الخروج.' },
  urgent: { en: 'This may need urgent medical help. Please call your local emergency number now, or ask someone near you to call. Do not wait for a reply in this app. In the UAE call 998 or 999. In Egypt call 123.', ar: 'ده ممكن يحتاج مساعدة طبية عاجلة. اتصل بالطوارئ دلوقتي، أو اطلب من حد جنبك يتصل. ماتستناش رد في التطبيق. في الإمارات اتصل بـ ٩٩٨ أو ٩٩٩. في مصر اتصل بـ ١٢٣.' },
  urgent_reason: { en: 'You told me: {reason}.', ar: 'انت قلت: {reason}.' },
  urgent_q: { en: 'When you are safe, say continue to finish your message, or main menu.', ar: 'لما تكون في أمان، قول كمّل علشان نكمل الرسالة، أو القائمة.' },
  nomatch: { en: 'Sorry, I did not understand.', ar: 'آسف، مفهمتش.' },
  nomatch_hint: { en: 'Sorry, I did not understand. You can say one of: {list}. Or use the buttons on the screen.', ar: 'آسف، مفهمتش. ممكن تقول: {list}. أو استخدم الزراير على الشاشة.' },
  ai_check: { en: 'I understood: {label}. Is that right? Say yes or no.', ar: 'فهمت: {label}. صح كده؟ قول نعم أو لا.' },
  help: { en: 'You can answer with the words I suggest, say repeat, back, skip, main menu, or use the buttons on the screen. Swipe right or left to move between buttons and double tap to choose, if gestures are on.', ar: 'تقدر تجاوب بالكلمات اللي بقترحها، أو تقول كرر، أو رجوع، أو تخطي، أو القائمة، أو تستخدم الزراير. لو الإشارات شغالة، اسحب يمين أو شمال علشان تتنقل، ودوس مرتين علشان تختار.' },
};

export function t(key: string, lang: VoiceLang, vars: Record<string, string | number> = {}): string {
  let s = S[key]?.[lang] ?? S[key]?.en ?? key;
  for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
  return s;
}

const L = (lang: VoiceLang, en: string, ar: string) => (lang === 'ar' ? ar : en);

/** "AC-PAT-7K4P9X" → "A C. P A T. 7 K 4. P 9 X." — short groups, read one character at a time (slow = longer pauses). */
export function spell(code: string, _lang: VoiceLang, slow = false): string {
  const groups: string[] = [];
  for (const part of code.toUpperCase().split('-').filter(Boolean)) {
    if (part.length <= 4) groups.push(part);
    else for (let i = 0; i < part.length; i += 3) groups.push(part.slice(i, i + 3));
  }
  return groups.map((g) => g.split('').join(slow ? ', ' : ' ')).join(slow ? '. ... ' : '. ') + '.';
}

// ---------------------------------------------------------------- engine
export function initialState(lang: VoiceLang): DialogState {
  return { phase: 'pre_welcome', lang, messages: [], msgIndex: 0, lastSay: [], urgentShown: [], misses: 0 };
}

const yesNo = (lang: VoiceLang): Option[] => [{ id: 'yes', label: L(lang, 'Yes', 'نعم') }, { id: 'no', label: L(lang, 'No', 'لا') }];

/** Options (touch / screen-reader alternative) for the current phase. */
export function optionsFor(st: DialogState, ctx: Ctx): Option[] {
  const l = st.lang;
  if (st.pending) return yesNo(l);
  switch (st.phase) {
    case 'pre_welcome': return [{ id: 'new_account', label: L(l, 'Create a new account', 'حساب جديد') }, { id: 'login', label: L(l, 'Log in', 'تسجيل الدخول') }, { id: 'recover', label: L(l, 'I forgot my password', 'نسيت كلمة السر') }];
    case 'pre_consent': case 'pre_name_confirm': case 'doctor_ask': case 'doctor_confirm': case 'ai_consent':
    case 'send_confirm': case 'reject_confirm': case 'reply_confirm': case 'logout_confirm': return yesNo(l);
    case 'id_readout': return [{ id: 'repeat', label: L(l, 'Repeat', 'كرر') }, { id: 'slow', label: L(l, 'Spell slowly', 'تهجّى ببطء') }, { id: 'continue', label: L(l, 'Continue', 'كمّل') }];
    case 'recovery_readout': return [{ id: 'repeat', label: L(l, 'Repeat', 'كرر') }, { id: 'save', label: L(l, 'Save as a file', 'احفظه كملف') }, { id: 'continue', label: L(l, 'Continue', 'كمّل') }];
    case 'doctor_entry': return [{ id: 'skip', label: L(l, 'Skip', 'تخطي') }];
    case 'menu': return [
      { id: 'new_consult', label: L(l, 'New consultation', 'استشارة جديدة'), hint: L(l, 'Describe what is bothering you for your doctor', 'وصف اللي تاعبك لدكتورك') },
      { id: 'messages', label: L(l, 'My messages', 'رسايلي'), hint: L(l, 'Hear messages from your doctor and reply', 'اسمع رسايل الدكتور ورد عليها') },
      { id: 'doctor', label: L(l, 'My doctor and status', 'دكتوري والحالة') },
      { id: 'my_id', label: L(l, 'My Patient ID', 'رقم المريض') },
      { id: 'settings', label: L(l, 'Voice settings', 'إعدادات الصوت') },
      { id: 'logout', label: L(l, 'Log out', 'تسجيل الخروج') }];
    case 'consult': return st.consultOptions ?? [];
    case 'review': return [{ id: 'approve', label: L(l, 'Approve', 'موافق') }, { id: 'change', label: L(l, 'Change something', 'غيّر حاجة') }, { id: 'reject', label: L(l, 'Reject', 'ارفض') }, { id: 'repeat', label: L(l, 'Hear it again', 'اسمعه تاني') }];
    case 'messages': return [{ id: 'next', label: L(l, 'Next message', 'الرسالة اللي بعدها') }, { id: 'previous', label: L(l, 'Previous message', 'اللي قبلها') }, ...(st.messages.length ? [{ id: 'reply', label: L(l, 'Reply', 'رد') }] : []), { id: 'menu', label: L(l, 'Main menu', 'القائمة') }];
    case 'reply': return [{ id: 'menu', label: L(l, 'Cancel', 'إلغاء') }];
    case 'settings': return [{ id: 'set_faster', label: L(l, 'Speak faster', 'أسرع') }, { id: 'set_slower', label: L(l, 'Speak slower', 'أبطأ') }, { id: 'set_normal', label: L(l, 'Normal speed', 'سرعة عادية') },
      { id: st.lang === 'ar' ? 'set_en' : 'set_ar', label: st.lang === 'ar' ? 'English' : 'العربية' },
      { id: 'set_brief', label: L(l, 'Brief guidance', 'كلام مختصر') }, { id: 'set_full', label: L(l, 'Detailed guidance', 'بالتفصيل') },
      { id: 'set_gestures_off', label: L(l, 'Gestures off (use my screen reader)', 'اقفل الإشارات') }, { id: 'set_gestures_on', label: L(l, 'Gestures on', 'شغل الإشارات') },
      ...(ctx.aiSupported ? [{ id: 'set_ai', label: ctx.aiOn ? L(l, 'AI assistance: on', 'الذكاء الاصطناعي: شغال') : L(l, 'Turn on AI assistance', 'شغّل الذكاء الاصطناعي') }] : []),
      { id: 'set_reset', label: L(l, 'Restore defaults', 'الإعدادات الافتراضية') }, { id: 'menu', label: L(l, 'Done', 'خلصت') }];
    case 'urgent': return [{ id: 'continue', label: L(l, 'Continue my message', 'كمّل الرسالة') }, { id: 'menu', label: L(l, 'Main menu', 'القائمة') }];
    default: return [];
  }
  void ctx;
}

const questionFor = (st: DialogState, ctx: Ctx): string[] => {
  const l = st.lang;
  switch (st.phase) {
    case 'pre_welcome': return [t('pre_q', l)];
    case 'pre_consent': return [t(ctx.shared ? 'consent_shared' : 'consent_local', l), t('consent_q', l)];
    case 'pre_name': return [t('name_q', l)];
    case 'pre_name_confirm': return [t('name_confirm', l, { name: st.name ?? '' })];
    case 'pre_password': return [t('password_q', l)];
    case 'pre_login': return [t(ctx.claudeAccount ? 'login_q_claude' : 'login_q_local', l)];
    case 'pre_recover': return [t(ctx.claudeAccount ? 'recover_q' : 'recover_q_local', l)];
    case 'id_readout': return [t('id_is', l, { spelled: spell(st.patientCode ?? '', l) }), t('id_note', l)];
    case 'recovery_readout': return [t('rec_is', l, { spelled: spell(st.recoveryCode ?? '', l) }), t('rec_note', l)];
    case 'doctor_ask': return [t('doctor_ask', l)];
    case 'doctor_entry': return [t('doctor_entry', l)];
    case 'doctor_confirm': return [t('doctor_found', l, { name: st.doctorLookup?.name ?? '' })];
    case 'ai_consent': return [t('ai_q', l)];
    case 'menu': return [t('menu_q', l)];
    case 'consult': return st.consult?.pending ? [st.consult.pending.text] : [];
    case 'review': return [t('review_intro', l), ...(st.consult ? spokenSummary({ ...st.consult, lang: l }) : []), t('review_q', l)];
    case 'send_confirm': return [ctx.doctorName ? t('send_q', l, { name: ctx.doctorName }) : t('save_q', l)];
    case 'reject_confirm': return [t('reject_q', l)];
    case 'messages': return st.messages.length ? [readMessage(st), t('msg_q', l)] : [t('msgs_none', l)];
    case 'reply': return [t('reply_q', l)];
    case 'reply_confirm': return [t('reply_confirm', l, { text: st.replyDraft ?? '' })];
    case 'settings': return [t('settings_q', l)];
    case 'logout_confirm': return [t('logout_q', l)];
    case 'urgent': return [t('urgent_q', l)];
    default: return [];
  }
};

function readMessage(st: DialogState): string {
  const m = st.messages[st.msgIndex];
  if (!m) return '';
  const when = new Date(m.at).toLocaleString(st.lang === 'ar' ? 'ar-EG' : 'en-GB', { weekday: 'long', hour: 'numeric', minute: '2-digit' });
  return t('msg_read', st.lang, { from: m.from === 'doctor' ? L(st.lang, 'your doctor', 'دكتورك') : L(st.lang, 'you', 'انت'), when, body: m.body });
}

/** The summary the patient approves (each line says whether it is their words, their choice or an interpretation). */
export function summaryLines(st: DialogState, lang: VoiceLang = st.lang): string[] {
  return st.consult ? consultSummary(st.consult, lang) : [];
}

const urgentCheck = (text: string, st: DialogState): string[] => {
  const r = assessSafety({ regionIds: [], sensations: [], details: { description: text } });
  const words = /\b(help me now|emergency|i need help now|call (an )?ambulance)\b/i.test(text) || /(الحقوني|طوارئ|إسعاف|اسعاف|محتاج مساعدة دلوقتي)/.test(text);
  return [...(words ? [L(st.lang, 'you need help now', 'انت محتاج مساعدة دلوقتي')] : []), ...r.reasons];
};


/** One step of the conversation. Pure: same input → same output. */
export function step(prev: DialogState, input: Input, ctx: Ctx): Turn {
  const st: DialogState = JSON.parse(JSON.stringify(prev));
  const say: string[] = [];
  const effects: Effect[] = [];
  const l = () => st.lang;
  const go = (p: Phase, extra: string[] = []) => { st.phase = p; st.pending = undefined; st.misses = 0; say.push(...extra, ...questionFor(st, ctx)); };
  const finish = (): Turn => {
    if (say.length) st.lastSay = say.slice();
    const listen = !['pre_password', 'pre_login', 'pre_recover', 'done'].includes(st.phase) && !effects.some((e) => e.type.startsWith('show_') || e.type === 'converse' || e.type === 'consult_start');
    return { state: st, say, options: optionsFor(st, ctx), effects, listen };
  };
  const startConsultation = (change: boolean) => { st.phase = 'consult'; st.pending = undefined; st.misses = 0; if (!change) st.consult = undefined; effects.push({ type: 'consult_start', change }); };

  if (input.kind === 'start') {
    if (ctx.signedIn && input.consult) { startConsultation(false); return finish(); }
    if (ctx.signedIn) { go('menu', [t('welcome_back', l())]); return finish(); }
    go('pre_welcome', [t('welcome', l()), t('controls', l())]); return finish();
  }

  if (input.kind === 'event') {
    const d = input.data ?? {};
    switch (input.name) {
      case 'signed_up': st.patientCode = String(d.patientCode ?? ''); say.push(t('created', l())); effects.push({ type: 'create_recovery' }); go('id_readout'); break;
      case 'recovery_created': st.recoveryCode = String(d.code ?? ''); if (st.phase !== 'id_readout') go('recovery_readout', [t('rec_warn', l())]); break;
      case 'logged_in': go('menu', [t('welcome_back', l())]); break;
      case 'doctor_found': st.doctorLookup = { id: String(d.id), name: String(d.name) }; go('doctor_confirm'); break;
      case 'doctor_not_found': say.push(t('doctor_nf', l())); st.phase = 'doctor_entry'; break;
      case 'doctor_connected': say.push(t('doctor_ok', l(), { name: String(d.name ?? '') })); toAiOrMenu(); break;
      case 'sent': say.push(t('sent', l(), { name: ctx.doctorName ?? '' })); st.consult = undefined; go('menu'); break;
      case 'saved': say.push(t('saved', l())); st.consult = undefined; go('menu'); break;
      case 'send_failed': case 'action_failed': say.push(t('failed', l(), { error: String(d.error ?? '') })); say.push(...questionFor(st, ctx)); break;
      case 'messages': st.messages = (d.list as Msg[]) ?? []; st.msgIndex = 0;
        if (d.status) say.push(t('status_line', l(), { status: String(d.status) }));
        if (st.messages.length) say.push(t('msgs_count', l(), { n: st.messages.length }));
        go('messages'); if (!st.messages.length) { st.phase = 'menu'; say.push(t('menu_q_brief', l())); } break;
      case 'reply_sent': st.replyDraft = undefined; say.push(t('reply_sent', l())); go('messages'); break;
      case 'doctor_info': say.push(d.name ? t('doctor_is', l(), { name: String(d.name) }) : t('doctor_none', l()));
        if (d.status) say.push(t('status_line', l(), { status: String(d.status) }));
        go('menu', []); say.splice(say.length - 1, 1, t('menu_q_brief', l())); break;
      case 'settings_changed': if (d.lang === 'ar' || d.lang === 'en') st.lang = d.lang; say.push(t('settings_done', l())); say.push(...questionFor(st, ctx)); break;
      case 'consult_turn': {
        const rec = d.rec as ConsultRecord; const said = (d.say as string[]) ?? []; const opts = (d.options as Option[]) ?? []; const urgent = (d.urgent as string[]) ?? [];
        st.consult = rec; st.consultOptions = opts; st.lang = rec.lang; st.consultSay = said;
        const fresh = urgent.filter((r) => !st.urgentShown.includes(r));
        if (fresh.length) {
          // emergency guidance comes before anything else; the conversation waits
          st.urgentShown.push(...fresh); st.returnTo = d.review ? 'review' : 'consult'; st.phase = 'urgent';
          say.push(urgentText(l()), t('urgent_reason', l(), { reason: fresh.join('; ') }), t('urgent_q', l()));
          break;
        }
        if (d.review) { say.push(...said.filter((x) => x)); go('review'); break; }
        st.phase = 'consult'; say.push(...said);
        break;
      }
      case 'urgent': { const reasons = (d.reasons as string[]) ?? []; const fresh = reasons.filter((r) => !st.urgentShown.includes(r));
        if (fresh.length) { st.urgentShown.push(...fresh); st.returnTo = st.phase === 'urgent' ? st.returnTo : st.phase; st.phase = 'urgent'; say.push(t('urgent', l()), t('urgent_reason', l(), { reason: fresh.join('; ') }), t('urgent_q', l())); }
        break; }
    }
    return finish();
  }

  // ---- utterance / choice / ai guess → an option id (or free text)
  let id: string | null = null;
  let text = '';
  if (input.kind === 'choice') id = input.id;
  if (input.kind === 'ai_reply') { say.push(input.text, ...questionFor(st, ctx)); return finish(); }
  if (input.kind === 'ai_guess') {
    if (!input.id) { st.misses++; say.push(hintNoMatch(st, ctx)); return finish(); }
    const opt = optionsFor(st, ctx).find((o) => o.id === input.id);
    if (!opt) { say.push(hintNoMatch(st, ctx)); return finish(); }
    st.pending = { id: opt.id, label: opt.label, via: 'ai' };
    say.push(t('ai_check', l(), { label: opt.label })); return finish();
  }
  if (input.kind === 'utterance') {
    text = input.text.trim();
    if (!text) { say.push(t('nomatch', l()), ...questionFor(st, ctx)); return finish(); }
    // urgent words are checked on everything the patient says (in a consultation the conversation checks them)
    const reasons = st.phase === 'consult' ? [] : urgentCheck(text, st).filter((r) => !st.urgentShown.includes(r));
    if (reasons.length) {
      st.urgentShown.push(...reasons);
      st.returnTo = st.phase;
      st.phase = 'urgent'; st.pending = undefined;
      say.push(t('urgent', l()), t('urgent_reason', l(), { reason: reasons.join('; ') }), t('urgent_q', l()));
      return finish();
    }
  }

  // the consultation conversation: everything except a few short commands goes to the conversation manager
  if (st.phase === 'consult') {
    const short = text && normalize(text).trim().split(' ').length <= 2;
    const g = id && ['repeat', 'help', 'menu'].includes(id) ? id : short ? matchOption(text, ['repeat', 'help', 'menu']) : null;
    if (g === 'repeat') { say.push(...(st.consultSay?.length ? st.consultSay : questionFor(st, ctx))); return finish(); }
    if (g === 'help') { say.push(L(l(), 'Tell me in your own words, or choose one of the answers on the screen. You can also say repeat, or main menu.', 'قولّي بكلامك، أو اختار إجابة من اللي على الشاشة. وممكن تقول كرر، أو القائمة.'), ...questionFor(st, ctx)); return finish(); }
    if (g === 'menu') { go(ctx.signedIn ? 'menu' : 'pre_welcome'); return finish(); }
    if (id) { const o = (st.consultOptions ?? []).find((x) => x.id === id); effects.push({ type: 'converse', input: { kind: 'option', id, label: o?.label ?? id, via: 'touch' } }); }
    else effects.push({ type: 'converse', input: { kind: 'text', text, via: input.kind === 'utterance' ? input.via ?? 'voice' : 'voice' } });
    return finish();
  }

  // pending confirmation (an AI interpretation or a hint from the description)
  if (st.pending) {
    const g = id && GLOBAL.includes(id) ? id : !id && text ? matchOption(text, GLOBAL) : null;
    if (g === 'repeat') { say.push(...(st.lastSay.length ? st.lastSay : [t('ai_check', l(), { label: st.pending.label })])); return finish(); }
    if (g === 'help') { say.push(t('help', l()), ...st.lastSay); return finish(); }
    if (g === 'menu' || g === 'back') { st.pending = undefined; if (g === 'menu') { if (ctx.signedIn) go('menu'); else go('pre_welcome'); return finish(); } return back(); }
    const yn = id ?? matchOption(text, ['yes', 'no']);
    if (yn === 'yes') { const p = st.pending; st.pending = undefined; return finishChoice(p.id); }
    if (yn === 'no') { st.pending = undefined; say.push(...questionFor(st, ctx)); return finish(); }
    say.push(t('ai_check', l(), { label: st.pending.label })); return finish();
  }

  // the current question's options win over global commands ("my back" in the body-area question is not "go back")
  const FREE = ['reply', 'pre_name'];
  if (!id && text) {
    const keys = optionsFor(st, ctx).map((o) => o.id).filter((k) => LEX[k]);
    const opt = FREE.includes(st.phase) ? null : matchOption(text, keys);
    if (opt) id = opt;
    else {
      const g = matchOption(text, GLOBAL);
      if (g && (!FREE.includes(st.phase) || normalize(text).trim().split(' ').length <= 3)) id = g;
    }
  }
  if (id === 'repeat' && st.phase !== 'id_readout' && st.phase !== 'recovery_readout' && st.phase !== 'review') { say.push(...(st.lastSay.length ? st.lastSay : questionFor(st, ctx))); return { ...finish(), state: { ...st } }; }
  if (id === 'help') { say.push(t('help', l()), ...questionFor(st, ctx)); return finish(); }
  if (id === 'menu') { if (ctx.signedIn) go('menu'); else go('pre_welcome'); return finish(); }
  if (id === 'back') return back();

  // free-text phases
  if (!id && FREE.includes(st.phase)) {
    if (st.phase === 'pre_name') { st.name = text.replace(/^(my name is|i am|i'm|اسمي|أنا|انا)\s+/i, '').slice(0, 80); go('pre_name_confirm'); return finish(); }
    if (st.phase === 'reply') { st.replyDraft = text.slice(0, 1000); go('reply_confirm'); return finish(); }
  }

  if (!id && text) {
    const keys = optionsFor(st, ctx).map((o) => o.id);
    // numbers for severity
    if (st.phase === 'doctor_entry') { const code = text.toUpperCase().replace(/[^A-Z0-9]/g, ''); if (code.length >= 6) { effects.push({ type: 'lookup_doctor', code }); return finish(); } }
    void keys;
    if (!id) {
      st.misses++;
      // let the app ask AI (if allowed); otherwise list the options
      effects.push({ type: 'nomatch', text, options: optionsFor(st, ctx) });
      if (!(ctx.aiSupported && ctx.aiOn) || st.misses > 2) say.push(hintNoMatch(st, ctx));
      return finish();
    }
  }
  if (!id) { say.push(...questionFor(st, ctx)); return finish(); }
  return finishChoice(id);

  // ---------------------------------------------------------- helpers
  function hintNoMatch(s: DialogState, c: Ctx) {
    const opts = optionsFor(s, c).map((o) => o.label).slice(0, 7);
    return t('nomatch_hint', s.lang, { list: opts.join(s.lang === 'ar' ? '، ' : ', ') });
  }

  function back(): Turn {
    if (['messages', 'reply', 'reply_confirm', 'settings', 'logout_confirm', 'review', 'consult'].includes(st.phase)) { go(ctx.signedIn ? 'menu' : 'pre_welcome'); return finish(); }
    say.push(...questionFor(st, ctx)); return finish();
  }

  function finishChoice(choice: string): Turn {
    const ph = st.phase;
    switch (ph) {
      case 'pre_welcome':
        if (choice === 'new_account') go('pre_consent');
        else if (choice === 'login') { go('pre_login'); effects.push({ type: 'show_login' }); }
        else if (choice === 'recover') { go('pre_recover'); effects.push({ type: 'show_recover' }); }
        else say.push(...questionFor(st, ctx));
        break;
      case 'pre_consent': if (choice === 'yes') go('pre_name'); else if (choice === 'no') go('pre_welcome'); else say.push(...questionFor(st, ctx)); break;
      case 'pre_name_confirm': if (choice === 'yes') { go('pre_password'); effects.push({ type: 'show_signup' }); } else if (choice === 'no') go('pre_name'); else say.push(...questionFor(st, ctx)); break;
      case 'id_readout':
        if (choice === 'repeat') say.push(t('id_is', l(), { spelled: spell(st.patientCode ?? '', l()) }));
        else if (choice === 'slow') say.push(t('id_is', l(), { spelled: spell(st.patientCode ?? '', l(), true) }));
        else if (choice === 'continue' || choice === 'yes') { if (st.recoveryCode) go('recovery_readout', [t('rec_warn', l())]); else if (ctx.doctorName) toAiOrMenu(); else go('doctor_ask'); }
        else say.push(t('id_note', l()));
        break;
      case 'recovery_readout':
        if (choice === 'repeat') say.push(t('rec_is', l(), { spelled: spell(st.recoveryCode ?? '', l(), true) }));
        else if (choice === 'save') { effects.push({ type: 'save_recovery_file' }); say.push(t('rec_note', l())); }
        else if (choice === 'continue' || choice === 'yes') { st.recoveryCode = undefined; if (ctx.doctorName) toAiOrMenu(); else go('doctor_ask'); }
        else say.push(t('rec_note', l()));
        break;
      case 'doctor_ask': if (choice === 'yes') go('doctor_entry'); else if (choice === 'no' || choice === 'skip') toAiOrMenu(); else say.push(...questionFor(st, ctx)); break;
      case 'doctor_entry': if (choice === 'skip' || choice === 'no') toAiOrMenu(); else say.push(...questionFor(st, ctx)); break;
      case 'doctor_confirm':
        if (choice === 'yes' && st.doctorLookup) effects.push({ type: 'connect_doctor', code: st.doctorLookup.id });
        else if (choice === 'no') go('doctor_entry'); else say.push(...questionFor(st, ctx));
        break;
      case 'ai_consent': if (choice === 'yes' || choice === 'no') { effects.push({ type: 'enable_ai', on: choice === 'yes' }); go('menu'); } else say.push(...questionFor(st, ctx)); break;
      case 'menu':
        if (choice === 'new_consult') { st.urgentShown = []; startConsultation(false); }
        else if (choice === 'messages') effects.push({ type: 'load_messages' });
        else if (choice === 'doctor') effects.push({ type: 'load_doctor' });
        else if (choice === 'my_id') { say.push(st.patientCode ? t('id_is', l(), { spelled: spell(st.patientCode, l()) }) : L(l(), 'Your Patient ID is shown in your profile.', 'رقم المريض موجود في صفحتك الشخصية.')); say.push(t('menu_q_brief', l())); }
        else if (choice === 'settings') go('settings');
        else if (choice === 'logout') go('logout_confirm');
        else say.push(...questionFor(st, ctx));
        break;
      case 'review':
        if (choice === 'approve' || choice === 'yes') go('send_confirm');
        else if (choice === 'change' || choice === 'no') startConsultation(true);
        else if (choice === 'reject') go('reject_confirm');
        else if (choice === 'repeat') go('review');
        else say.push(t('review_q', l()));
        break;
      case 'send_confirm':
        if (choice === 'yes') effects.push({ type: 'send_report', toDoctor: !!ctx.doctorName });
        else if (choice === 'no') go('review');
        else say.push(...questionFor(st, ctx));
        break;
      case 'reject_confirm':
        if (choice === 'yes') { say.push(t('rejected', l())); st.consult = undefined; go('menu'); }
        else if (choice === 'no') go('review'); else say.push(...questionFor(st, ctx));
        break;
      case 'messages':
        if (choice === 'next') { st.msgIndex = Math.min(st.messages.length - 1, st.msgIndex + 1); say.push(readMessage(st), t('msg_q', l())); }
        else if (choice === 'previous') { st.msgIndex = Math.max(0, st.msgIndex - 1); say.push(readMessage(st), t('msg_q', l())); }
        else if (choice === 'reply' && st.messages.length) { st.replyCid = st.messages[st.msgIndex].cid; go('reply'); }
        else if (choice === 'repeat') say.push(readMessage(st), t('msg_q', l()));
        else say.push(t('msg_q', l()));
        break;
      case 'reply_confirm':
        if (choice === 'yes' && st.replyDraft && st.replyCid) effects.push({ type: 'send_reply', cid: st.replyCid, text: st.replyDraft });
        else if (choice === 'no') go('reply'); else say.push(...questionFor(st, ctx));
        break;
      case 'settings': {
        const m: Record<string, Effect & { type: 'settings' }> = {
          set_faster: { type: 'settings', change: 'faster' }, set_slower: { type: 'settings', change: 'slower' }, set_normal: { type: 'settings', change: 'normal' },
          set_ar: { type: 'settings', change: 'lang_ar' }, set_en: { type: 'settings', change: 'lang_en' }, set_brief: { type: 'settings', change: 'brief' }, set_full: { type: 'settings', change: 'full' },
          set_gestures_off: { type: 'settings', change: 'gestures_off' }, set_gestures_on: { type: 'settings', change: 'gestures_on' }, set_reset: { type: 'settings', change: 'reset' },
        };
        if (choice === 'set_ai' && ctx.aiSupported) { go('ai_consent'); break; }
        if (m[choice]) effects.push(m[choice]); else say.push(...questionFor(st, ctx));
        break;
      }
      case 'logout_confirm': if (choice === 'yes') { effects.push({ type: 'logout' }); say.push(t('logged_out', l())); st.phase = 'done'; } else if (choice === 'no') go('menu'); else say.push(...questionFor(st, ctx)); break;
      case 'urgent':
        if (choice === 'continue' || choice === 'yes') {
          const r = st.returnTo && st.returnTo !== 'urgent' ? st.returnTo : (ctx.signedIn ? 'menu' : 'pre_welcome'); st.returnTo = undefined;
          if (r === 'consult') { st.phase = 'consult'; say.push(...(st.consultSay?.length ? st.consultSay : questionFor(st, ctx))); }
          else go(r);
        }
        else say.push(t('urgent_q', l()));
        break;
      default: say.push(...questionFor(st, ctx));
    }
    return finish();
  }

  function toAiOrMenu() { if (ctx.aiSupported) go('ai_consent'); else go('menu', [t('ai_unavailable', l())]); }

}
