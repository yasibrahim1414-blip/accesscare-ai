// Blind Mode: what the person asked for, in English or Arabic (Egyptian and
// Modern Standard). Pure functions, no side effects: the Blind Mode controller
// turns the result into real actions on the current screen. Requests that are not
// recognised here are matched against the names of the controls on the screen,
// and (when the patient allowed AI) can be interpreted by Claude.
import { norm, similarity } from '../services/conversation/lexicon';

export type NavTarget = 'care' | 'medicines' | 'boxcheck' | 'photos' | 'card' | 'caregivers' | 'interpreter' | 'diary' | 'progress' | 'home' | 'profile' | 'settings' | 'history' | 'doctor' | 'patients' | 'consultations' | 'signal' | 'camera' | 'about' | 'signin' | 'signup' | 'welcome' | 'talk' | 'preferences';
export type Cmd =
  | { type: 'stop' } | { type: 'repeat' } | { type: 'resume' } | { type: 'pause_listening' }
  | { type: 'slower' } | { type: 'faster' } | { type: 'normal_speed' } | { type: 'explain' }
  | { type: 'exit' } | { type: 'back' } | { type: 'help' } | { type: 'where' }
  | { type: 'read_page' } | { type: 'read_form' } | { type: 'fill_form' } | { type: 'submit' }
  | { type: 'go'; to: NavTarget }
  | { type: 'read_latest_report' } | { type: 'read_doctor_reply' } | { type: 'new_report' } | { type: 'voice_menu' }
  | { type: 'logout' } | { type: 'lang'; lang: 'en' | 'ar' }
  | { type: 'press'; name: string } | { type: 'fill'; field: string; value: string }
  | { type: 'next_item' } | { type: 'previous_item' } | { type: 'activate' }
  | { type: 'scroll'; dir: 'up' | 'down' }
  | { type: 'yes' } | { type: 'no' } | { type: 'skip' }
  | { type: 'unknown'; text: string };

/** whole-utterance phrases (after normalising) */
const EXACT: [Cmd['type'], string[]][] = [
  ['yes', ['yes', 'yeah', 'yep', 'yes please', 'ok', 'okay', 'sure', 'correct', 'do it', 'go ahead', 'confirm', 'ايوه', 'ايوا', 'اه', 'نعم', 'تمام', 'ماشي', 'اكيد', 'موافق', 'صح', 'اوك', 'اعمل كده']],
  ['no', ['no', 'nope', 'no thanks', 'cancel', 'don\'t', 'do not', 'لا', 'لأ', 'لاء', 'مش عايز', 'الغي', 'الغاء', 'لا شكرا']],
  ['skip', ['skip', 'next field', 'pass', 'تخطي', 'عدي', 'اللي بعده', 'سيبها']],
  ['stop', ['stop', 'stop speaking', 'stop talking', 'quiet', 'be quiet', 'shut up', 'silence', 'enough', 'اسكت', 'بس', 'كفايه', 'وقف', 'وقف الكلام', 'اسكت شويه', 'خلاص']],
  ['repeat', ['repeat', 'repeat what you just said', 'repeat that please', 'say it again', 'what did you just say', 'say again', 'say that again', 'again', 'pardon', 'what did you say', 'repeat that', 'كرر', 'تاني', 'قول تاني', 'عيد', 'عيد تاني', 'قلت ايه', 'اعد']],
  ['explain', ['explain', 'explain that', 'explain that again', 'explain again', 'what does that mean', 'i don\'t understand', 'اشرح', 'اشرحلي', 'وضح', 'مش فاهم', 'يعني ايه']],
  ['resume', ['continue', 'go on', 'carry on', 'resume', 'keep going', 'كمل', 'كمّل', 'استمر']],
  ['pause_listening', ['stop listening', 'pause listening', 'pause', 'wait', 'hold on', 'استنى', 'ثانيه', 'بطل تسمع', 'وقف السماع']],
  ['slower', ['slower', 'speak slower', 'speak more slowly', 'talk slower', 'slow down', 'more slowly', 'ابطأ', 'ابطء', 'اتكلم ببطء', 'براحه', 'بالراحه', 'على مهلك', 'اتكلم براحه', 'ابطا']],
  ['faster', ['faster', 'speak faster', 'talk faster', 'speed up', 'quicker', 'اسرع', 'اتكلم اسرع', 'بسرعه شويه']],
  ['normal_speed', ['normal speed', 'normal', 'سرعه عاديه', 'عادي']],
  ['exit', ['exit blind mode', 'turn off blind mode', 'stop blind mode', 'close blind mode', 'blind mode off', 'disable blind mode', 'exit', 'اقفل الوضع الصوتي', 'اطفي الوضع الصوتي', 'الغي الوضع الصوتي', 'خروج من الوضع الصوتي', 'اخرج من الوضع الصوتي', 'اقفل وضع المكفوفين']],
  ['back', ['back', 'go back', 'previous page', 'return', 'ارجع', 'رجوع', 'ارجع ورا', 'الصفحه اللي فاتت', 'رجعني']],
  ['help', ['help', 'what can i do', 'what can i say', 'options', 'what are my options', 'what is on this screen', "what's on this screen", 'what options are available', 'what options are available on this screen', 'tell me what options are available on this screen', 'what can i do here', 'commands', 'مساعده', 'ساعدني', 'اعمل ايه', 'اقدر اعمل ايه', 'ايه الاختيارات', 'ايه اللي موجود', 'ايه اللي في الصفحه', 'الاختيارات', 'قولي الاختيارات']],
  ['where', ['where am i', 'what screen is this', 'what page is this', 'which page', 'انا فين', 'انا في انهي صفحه', 'دي صفحه ايه', 'انا فين دلوقتي']],
  ['read_page', ['read', 'read the page', 'read this page', 'read the screen', 'read everything', 'read it', 'read this', 'read it to me', 'read this to me', 'اقرا', 'اقرأ', 'اقرالي', 'اقرا الصفحه', 'اقرالي الصفحه', 'اقرا الشاشه', 'اقرالي اللي على الشاشه']],
  ['read_form', ['read the form', 'read this form', 'read this form to me', 'read the form to me', 'what are the fields', 'اقرا الفورم', 'اقرالي الفورم', 'اقرا الخانات', 'ايه الخانات']],
  ['fill_form', ['help me fill', 'help me fill this form', 'help me complete this form', 'help me complete the form', 'fill the form', 'fill in the form', 'complete the form', 'help me log in', 'help me sign in', 'help me login', 'help me sign up', 'help me register', 'ساعدني املى الفورم', 'ساعدني اكمل الفورم', 'املالي الفورم', 'املى الفورم', 'ساعدني ادخل', 'ساعدني اسجل', 'ساعدني اسجل دخول']],
  ['submit', ['submit', 'send the form', 'send it', 'save it', 'done', 'finish', 'ابعت', 'ابعته', 'احفظ', 'خلصت', 'سجل']],
  ['next_item', ['next', 'next item', 'next button', 'move next', 'التالي', 'اللي بعده', 'بعده']],
  ['previous_item', ['previous', 'previous item', 'السابق', 'اللي قبله', 'قبله']],
  ['activate', ['select this', 'press this', 'click this', 'open this', 'press it', 'click it', 'اختار ده', 'دوس عليه', 'افتحه', 'اضغط عليه']],
  ['logout', ['log out', 'logout', 'sign out', 'log me out', 'sign me out', 'سجل خروج', 'تسجيل الخروج', 'اخرج من الحساب', 'اطلع من الحساب']],
  ['new_report', ['report a new symptom', 'i want to report a new symptom', 'new symptom', 'new report', 'new consultation', 'start a consultation', 'i am not feeling well', "i'm not feeling well", 'i feel sick', 'i want to see a doctor', 'talk to my doctor about a symptom', 'عايز ابلغ عن عرض', 'عرض جديد', 'استشاره جديده', 'تقرير جديد', 'انا تعبان', 'انا تعبانه', 'حاسس اني تعبان', 'عايز اقول للدكتور اني تعبان', 'عندي شكوى']],
  ['voice_menu', ['voice menu', 'main menu', 'voice guide', 'القائمه', 'القائمه الرئيسيه', 'المرشد الصوتي']],
  ['read_latest_report', ['read my latest report', 'read my latest medical report', 'read my report', 'latest report', 'my last report', 'read the latest report', 'read my last report', 'my latest report', 'اقرالي اخر تقرير', 'اقرا اخر تقرير', 'اخر تقرير', 'تقريري الاخير', 'اقرالي تقريري']],
  ['read_doctor_reply', ["open my doctor's latest response", "read my doctor's latest response", "my doctor's response", 'doctor response', "doctor's reply", 'did my doctor reply', 'did my doctor answer', 'read my messages', 'my messages', 'latest message', 'read the doctor reply', 'رد الدكتور', 'اخر رد من الدكتور', 'الدكتور رد', 'الدكتور رد عليا', 'اقرالي رد الدكتور', 'رسايلي', 'اقرالي الرسايل', 'اخر رساله']],
];

const GO_WORDS = /^(?:please )?(?:go to|open|take me to|show me|show|navigate to|switch to|bring me to|i want|i want to go to|let me see|view)\s+(?:the |my )?(.+)$/;
const GO_WORDS_AR = /^(?:لو سمحت )?(?:روح|روحني|افتح|افتحلي|افتح لي|وديني|خدني|اعرض|اعرضلي|وريني|عايز اروح|عايز|عايزه|ادخل|انقلني)\s+(?:علي |عل |الي |لحد )?(.+)$/;
const TARGETS: [NavTarget, string[]][] = [
  ['medicines', ['medicines', 'my medicines', 'medicine', 'my medicine', 'medication', 'medications', 'pills', 'my pills', 'reminders', 'ادويتي', 'الادويه', 'الدوا', 'دوايا', 'العلاج', 'علاجي', 'مواعيد الدوا']],
  ['boxcheck', ['check a medicine box', 'medicine box', 'check my medicine', 'read the medicine box', 'scan medicine', 'box check', 'علبه الدوا', 'اقرا علبه الدوا', 'اتاكد من الدوا', 'اتاكد من علبه الدوا']],
  ['photos', ['photos', 'wound photos', 'skin photos', 'my photos', 'pictures', 'الصور', 'صوري', 'صور الجرح', 'صور الجلد']],
  ['card', ['emergency card', 'my emergency card', 'medical id', 'emergency info', 'كارت الطوارئ', 'بطاقه الطوارئ', 'كارت الطوارئ بتاعي']],
  ['caregivers', ['caregivers', 'my caregivers', 'caregiver', 'family', 'المرافقين', 'المرافق', 'المرافقين بتوعي']],
  ['interpreter', ['interpreter', 'translator', 'visit interpreter', 'translate', 'المترجم', 'مترجم', 'مترجم الزياره', 'الترجمه']],
  ['care', ['care', 'my care', 'رعايتي', 'الرعايه']],
  ['diary', ['diary', 'my diary', 'symptom diary', 'journal', 'check in', 'daily check in', 'يومياتي', 'اليوميات', 'يوميات الاعراض', 'التسجيل اليومي']],
  ['progress', ['progress', 'what changed', 'changes', 'patient progress', 'التطور', 'تطور المرضى', 'ايه اللي اتغير']],
  ['home', ['home', 'dashboard', 'patient dashboard', 'doctor dashboard', 'my dashboard', 'main page', 'start', 'home page', 'overview', 'الرئيسيه', 'الصفحه الرئيسيه', 'البيت', 'لوحه التحكم', 'الداشبورد', 'الهوم']],
  ['profile', ['profile', 'my profile', 'account', 'my account', 'البروفايل', 'بروفايلي', 'الملف الشخصي', 'حسابي', 'صفحتي']],
  ['settings', ['settings', 'setting', 'options', 'الاعدادات', 'اعدادات', 'الضبط']],
  ['preferences', ['preferences', 'communication preferences', 'accessibility settings', 'التفضيلات', 'تفضيلات التواصل']],
  ['history', ['history', 'my reports', 'reports', 'medical reports', 'my history', 'past reports', 'consultation history', 'my consultations', 'السجل', 'تقاريري', 'التقارير', 'التقارير الطبيه', 'استشاراتي', 'التاريخ']],
  ['doctor', ['my doctor', 'doctor', 'doctor page', 'دكتوري', 'الدكتور', 'صفحه الدكتور', 'دكتوري بتاعي']],
  ['patients', ['patients', 'my patients', 'patient list', 'المرضى', 'مرضايا', 'قائمه المرضى']],
  ['consultations', ['consultations', 'inbox', 'consultation inbox', 'cases', 'الاستشارات', 'الحالات', 'الوارد']],
  ['signal', ['signal', 'silent signal', 'communication board', 'board', 'الاشارات', 'لوحه التواصل', 'الاشاره الصامته']],
  ['camera', ['camera', 'sign language', 'camera signals', 'الكاميرا', 'لغه الاشاره']],
  ['about', ['about', "what's real", 'what is real', 'عن التطبيق', 'ايه الحقيقي']],
  ['signin', ['sign in', 'log in', 'login', 'sign in page', 'تسجيل الدخول', 'الدخول']],
  ['signup', ['sign up', 'create an account', 'register', 'new account', 'انشاء حساب', 'حساب جديد', 'التسجيل']],
  ['talk', ['talk to accesscare', 'talk', 'chat', 'assistant', 'اتكلم مع اكسس كير', 'المساعد', 'الشات']],
];
const LANG_AR = /(arabic|عربي|العربي|العربيه)/;
const LANG_EN = /(english|انجليزي|الانجليزي|الانجليزيه|انجلش)/;
const LANG_CHANGE = /(language|switch|change|speak|talk|لغه|اللغه|غير|حول|خلي|اتكلم|كلمني)/;

const PRESS = /^(?:please )?(?:press|click|tap|select|choose|pick|hit|activate|push|open|turn on|turn off|check|uncheck)\s+(?:on |the )?(.+?)(?: button)?$/;
const PRESS_AR = /^(?:لو سمحت )?(?:دوس على|دوس|اضغط على|اضغط|اختار|اختر|انقر على|انقر|افتح|شغل|اقفل|علم على)\s+(.+)$/;
const FILL = /^(?:please )?(?:set|type|enter|put|write|fill(?: in)?)\s+(?:the |my )?(.+?)\s+(?:to|as|with|is)\s+(.+)$/;
const FILL2 = /^(?:please )?(?:type|enter|write)\s+(.+?)\s+(?:in|into|in the|into the)\s+(.+?)(?: field)?$/;
const FILL3 = /^my (name|full name|email|email address|patient id|doctor id|phone|password) is\s+(.+)$/;
const FILL_AR = /^(?:اكتب|اكتبلي|حط)\s+(.+?)\s+(?:في|فى)\s+(?:خانه\s+)?(.+)$/;
const FILL3_AR = /^(?:اسمي|الاسم)\s+(.+)$/;

export function phraseIs(n: string, list: string[]): boolean { return list.some((p) => norm(p) === n); }

/** What the person asked for. `n` is matched after normalising (lower case, Arabic letter variants unified). */
export function interpret(text: string): Cmd {
  const raw = text.trim();
  const n = norm(raw).replace(/^(please|لو سمحت|من فضلك|ممكن|يا اكسس كير|accesscare|access care)\s+/, '').replace(/\s+(please|لو سمحت|من فضلك)$/, '');
  if (!n) return { type: 'unknown', text: raw };
  for (const [type, list] of EXACT) if (phraseIs(n, list)) return { type } as Cmd;
  if (LANG_AR.test(n) && (LANG_CHANGE.test(n) || n.split(' ').length <= 2)) return { type: 'lang', lang: 'ar' };
  if (LANG_EN.test(n) && (LANG_CHANGE.test(n) || n.split(' ').length <= 2)) return { type: 'lang', lang: 'en' };
  if (/\b(blind mode|الوضع الصوتي)\b/.test(n) && /\b(off|exit|stop|close|disable|اقفل|اطفي|الغي|اخرج)\b/.test(n)) return { type: 'exit' };
  if (/(slow|ابطا|براحه|ببطء)/.test(n) && /(speak|talk|اتكلم|كلام)/.test(n)) return { type: 'slower' };
  if (/(latest|last|recent|newest|اخر)/.test(n) && /(report|تقرير)/.test(n)) return { type: 'read_latest_report' };
  if (/(doctor|دكتور)/.test(n) && /(reply|response|respond|answer|message|رد|رساله|رسايل)/.test(n)) return { type: 'read_doctor_reply' };
  if (/(report|describe|tell|ابلغ|اقول|احكي)/.test(n) && /(symptom|pain|not feeling well|عرض|وجع|تعبان)/.test(n)) return { type: 'new_report' };
  if (/(fill|complete|املا|املى|اكمل)/.test(n) && /(form|فورم|خانات|بيانات)/.test(n)) return { type: 'fill_form' };
  if (/^(help me|ساعدني)/.test(n) && /(log ?in|sign ?in|sign ?up|register|ادخل|اسجل)/.test(n)) return { type: 'fill_form' };
  if (/(read|اقرا)/.test(n) && /(form|فورم|خانات)/.test(n)) return { type: 'read_form' };
  if (/^scroll (down|up)$|^(انزل|اطلع) (لتحت|لفوق)?$/.test(n)) return { type: 'scroll', dir: /down|انزل/.test(n) ? 'down' : 'up' };

  // fill a field: "set email to x", "type x in email", "my name is x"
  let m = raw.match(new RegExp(FILL.source, 'i')) ?? null;
  if (m) return { type: 'fill', field: m[1].trim(), value: m[2].trim() };
  m = raw.match(new RegExp(FILL2.source, 'i'));
  if (m) return { type: 'fill', field: m[2].trim(), value: m[1].trim() };
  m = raw.match(new RegExp(FILL3.source, 'i'));
  if (m) return { type: 'fill', field: m[1].trim(), value: m[2].trim() };
  m = raw.match(FILL_AR);
  if (m) return { type: 'fill', field: m[2].trim(), value: m[1].trim() };
  m = raw.match(FILL3_AR);
  if (m) return { type: 'fill', field: 'name', value: m[1].trim() };

  // navigation: "open my profile", "go to settings", "افتح الإعدادات", or just the page name
  const target = (s: string): NavTarget | null => {
    const forms = new Set<string>();
    let x = norm(s).replace(/^(the|my|page)\s+/, '').replace(/\s+(page|screen|tab|الصفحه)$/, '');
    forms.add(x); forms.add(norm(s));
    // Arabic: "للصفحة الرئيسية", "لصفحة الإعدادات", "على البروفايل"
    x = x.replace(/^(لل|ل)(?=\S)/, 'ال'); forms.add(x);
    x = x.replace(/^(الصفحه|صفحه)\s+/, ''); forms.add(x);
    for (const [t, words] of TARGETS) if (words.some((w) => forms.has(norm(w)))) return t;
    return null;
  };
  const g = n.match(GO_WORDS) ?? n.match(GO_WORDS_AR);
  if (g) { const t = target(g[1]); if (t) return { type: 'go', to: t }; }
  const bare = target(n); if (bare) return { type: 'go', to: bare };

  const p = n.match(PRESS) ?? n.match(PRESS_AR);
  if (p) return { type: 'press', name: p[1].trim() };
  return { type: 'unknown', text: raw };
}

/** Best control whose name matches what was said (0..1 score). */
export function bestMatch<T extends { name: string }>(said: string, items: T[]): { item: T; score: number } | null {
  const s = norm(said);
  if (!s) return null;
  let best: { item: T; score: number } | null = null;
  for (const it of items) {
    const name = norm(it.name);
    if (!name) continue;
    let sc = 0;
    if (name === s) sc = 1;
    else if (s.length >= 3 && name.startsWith(s + ' ')) sc = 0.9;
    else if (s.length >= 3 && (name.endsWith(' ' + s) || name.includes(` ${s} `))) sc = 0.83;
    else if (s.includes(name) && name.length >= 4) sc = 0.8;
    else sc = similarity(s, name) * (Math.min(s.length, name.length) / Math.max(s.length, name.length) > 0.6 ? 0.95 : 0.7);
    if (!best || sc > best.score) best = { item: it, score: sc };
  }
  return best;
}

/** Controls whose action affects someone else, the account or health records: confirm first. */
const CONSEQUENTIAL = /\b(send|submit|approve|share|delete|remove|disconnect|connect|log ?out|sign ?out|cancel|reject|discard|reset|prescri|sign|change password|deactivate)\b|ابعت|ارسل|إرسال|احذف|امسح|موافق|اعتماد|شارك|سجل خروج|تسجيل الخروج|الغ|ارفض|وصفه|اربط|افصل/i;
export const isConsequential = (name: string) => CONSEQUENTIAL.test(name);
