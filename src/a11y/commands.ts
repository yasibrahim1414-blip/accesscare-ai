// Blind Mode: what the person asked for, in English, Arabic (Egyptian and
// Modern Standard), French, Urdu or Hindi (Urdu and Hindi also in Roman letters). Pure functions, no side effects: the Blind Mode controller
// turns the result into real actions on the current screen. Requests that are not
// recognised here are matched against the names of the controls on the screen,
// and (when the patient allowed AI) can be interpreted by Claude.
import { norm, similarity } from '../services/conversation/lexicon';
import type { Lang } from '../i18n/lang';
import { foldText } from '../services/langWords';

export type NavTarget = 'care' | 'medicines' | 'boxcheck' | 'photos' | 'card' | 'caregivers' | 'interpreter' | 'diary' | 'progress' | 'home' | 'profile' | 'settings' | 'history' | 'doctor' | 'patients' | 'consultations' | 'signal' | 'camera' | 'about' | 'signin' | 'signup' | 'welcome' | 'talk' | 'preferences';
export type Cmd =
  | { type: 'stop' } | { type: 'repeat' } | { type: 'resume' } | { type: 'pause_listening' }
  | { type: 'slower' } | { type: 'faster' } | { type: 'normal_speed' } | { type: 'explain' }
  | { type: 'exit' } | { type: 'back' } | { type: 'help' } | { type: 'where' }
  | { type: 'read_page' } | { type: 'read_form' } | { type: 'fill_form' } | { type: 'submit' }
  | { type: 'go'; to: NavTarget }
  | { type: 'read_latest_report' } | { type: 'read_doctor_reply' } | { type: 'new_report' } | { type: 'voice_menu' }
  | { type: 'logout' } | { type: 'lang'; lang: Lang }
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

/** the same commands in French, Urdu and Hindi */
const EXACT_MORE: Partial<Record<Cmd['type'], string[]>> = {
  yes: ['oui', 'ouais', "oui s'il vous plait", "d'accord", 'bien sûr', 'vas-y', 'allez-y', 'confirmer', 'exact', 'ہاں', 'جی', 'جی ہاں', 'ٹھیک ہے', 'ٹھیک', 'بالکل', 'کر دو', 'haan', 'ji', 'theek hai', 'हां', 'जी', 'जी हां', 'ठीक है', 'ठीक', 'बिल्कुल', 'कर दो'],
  no: ['non', 'non merci', 'annuler', 'pas maintenant', 'نہیں', 'نہیں شکریہ', 'جی نہیں', 'منسوخ', 'nahi', 'nahin', 'नहीं', 'नहीं धन्यवाद', 'जी नहीं', 'रद्द करो'],
  skip: ['passer', 'sauter', 'champ suivant', 'چھوڑ دو', 'آگے بڑھو', 'छोड दो', 'आगे बढो'],
  stop: ['stop', 'arrête', 'arrêtez', 'tais-toi', 'silence', 'ça suffit', 'arrête de parler', 'رکو', 'خاموش', 'چپ', 'بس کرو', 'بولنا بند کرو', 'रुको', 'चुप', 'चुप रहो', 'बस करो', 'बोलना बंद करो'],
  repeat: ['répète', 'répéter', 'répétez', 'redis', 'encore', 'tu peux répéter', 'vous pouvez répéter', "qu'est-ce que tu as dit", 'دوبارہ', 'دوبارہ بولو', 'پھر سے', 'کیا کہا', 'दोबारा', 'दोबारा बोलो', 'फिर से', 'क्या कहा'],
  explain: ['explique', 'expliquez', 'explique-moi', 'je ne comprends pas', 'ça veut dire quoi', 'سمجھاؤ', 'سمجھ نہیں آیا', 'اس کا مطلب کیا ہے', 'समझाओ', 'समझ नहीं आया', 'इसका मतलब क्या है'],
  resume: ['continue', 'continuer', 'جاری رکھو', 'آگے چلو', 'जारी रखो', 'आगे चलो'],
  pause_listening: ["arrête d'écouter", 'pause', 'attends', 'سننا بند کرو', 'ایک منٹ', 'ٹھہرو', 'सुनना बंद करो', 'एक मिनट', 'ठहरो'],
  slower: ['plus lentement', 'parle plus lentement', 'moins vite', 'ralentis', 'آہستہ بولو', 'آہستہ', 'धीरे बोलो', 'धीरे'],
  faster: ['plus vite', 'parle plus vite', 'accélère', 'تیز بولو', 'جلدی بولو', 'तेज बोलो', 'जल्दी बोलो'],
  normal_speed: ['vitesse normale', 'عام رفتار', 'सामान्य गति'],
  exit: ['quitter le mode vocal', 'désactiver le mode vocal', 'arrêter le mode vocal', 'quitter le mode aveugle', 'désactiver le mode aveugle', 'quitter', 'صوتی موڈ بند کرو', 'صوتی موڈ سے باہر', 'نابینا موڈ بند کرو', 'वॉइस मोड बंद करो', 'वॉयस मोड बंद करो', 'वॉइस मोड से बाहर', 'ब्लाइंड मोड बंद करो'],
  back: ['retour', 'revenir', 'reviens', 'page précédente', 'en arrière', 'واپس', 'پیچھے جاؤ', 'پچھلا صفحہ', 'वापस', 'पीछे जाओ', 'पिछला पेज'],
  help: ['aide', 'aidez-moi', 'aide-moi', "qu'est-ce que je peux faire", "qu'est-ce que je peux dire", 'quelles sont les options', 'options', "qu'y a-t-il sur cet écran", 'que puis-je faire ici', 'مدد', 'میری مدد کرو', 'میں کیا کر سکتا ہوں', 'میں کیا کر سکتی ہوں', 'کیا آپشن ہیں', 'اس صفحے پر کیا ہے', 'मदद', 'मेरी मदद करो', 'मैं क्या कर सकता हूं', 'मैं क्या कर सकती हूं', 'क्या विकल्प हैं', 'इस पेज पर क्या है'],
  where: ['où suis-je', 'quelle page', 'sur quelle page suis-je', "c'est quelle page", 'میں کہاں ہوں', 'یہ کون سا صفحہ ہے', 'मैं कहां हूं', 'यह कौन सा पेज है'],
  read_page: ['lis', 'lire', 'lis la page', "lis l'écran", 'lis tout', 'lis-moi la page', 'پڑھو', 'صفحہ پڑھو', 'اسکرین پڑھو', 'سب پڑھو', 'पढो', 'पेज पढो', 'स्क्रीन पढो', 'सब पढो'],
  read_form: ['lis le formulaire', 'quels sont les champs', 'فارم پڑھو', 'کون سے خانے ہیں', 'फॉर्म पढो', 'कौन से खाने हैं'],
  fill_form: ['aide-moi à remplir', 'aide-moi à remplir le formulaire', 'remplir le formulaire', 'aide-moi à me connecter', "aide-moi à m'inscrire", 'فارم بھرنے میں مدد کرو', 'فارم بھرو', 'لاگ ان میں مدد کرو', 'फॉर्म भरने में मदद करो', 'फॉर्म भरो', 'लॉग इन में मदद करो'],
  submit: ['envoyer', 'envoie', 'valider', 'enregistrer', 'terminé', 'بھیجو', 'بھیج دو', 'محفوظ کرو', 'جمع کرو', 'भेजो', 'भेज दो', 'सेव करो', 'जमा करो'],
  next_item: ['suivant', 'élément suivant', 'اگلا', 'अगला'],
  previous_item: ['précédent', 'élément précédent', 'پچھلا', 'पिछला'],
  activate: ['sélectionne ça', 'appuie dessus', 'ouvre ça', 'clique dessus', 'اسے دباؤ', 'اسے کھولو', 'یہ چنو', 'इसे दबाओ', 'इसे खोलो', 'यह चुनो'],
  logout: ['se déconnecter', 'déconnecte-moi', 'déconnexion', 'لاگ آؤٹ', 'لاگ آؤٹ کرو', 'اکاؤنٹ سے باہر', 'लॉग आउट', 'लॉग आउट करो', 'खाते से बाहर'],
  new_report: ['nouveau symptôme', 'signaler un symptôme', 'nouvelle consultation', 'je ne me sens pas bien', 'je suis malade', 'je veux voir un médecin', 'نئی علامت', 'نئی مشاورت', 'میری طبیعت خراب ہے', 'میں بیمار ہوں', 'ڈاکٹر کو بتانا ہے', 'नया लक्षण', 'नया परामर्श', 'मेरी तबीयत खराब है', 'मैं बीमार हूं', 'डॉक्टर को बताना है'],
  voice_menu: ['menu vocal', 'menu principal', 'guide vocal', 'مین مینو', 'صوتی مینو', 'मुख्य मेनू', 'वॉइस मेनू'],
  read_latest_report: ['lis mon dernier rapport', 'mon dernier rapport', 'dernier rapport', 'میری آخری رپورٹ پڑھو', 'آخری رپورٹ', 'मेरी आखिरी रिपोर्ट पढो', 'आखिरी रिपोर्ट'],
  read_doctor_reply: ['réponse du médecin', 'mon médecin a répondu', 'lis mes messages', 'mes messages', 'dernier message', 'ڈاکٹر کا جواب', 'میرے پیغامات', 'پیغامات پڑھو', 'آخری پیغام', 'डॉक्टर का जवाब', 'मेरे संदेश', 'संदेश पढो', 'आखिरी संदेश'],
};
for (const [type, list] of EXACT) list.push(...(EXACT_MORE[type] ?? []));

const GO_WORDS = /^(?:please )?(?:go to|open|take me to|show me|show|navigate to|switch to|bring me to|i want|i want to go to|let me see|view)\s+(?:the |my )?(.+)$/;
const GO_WORDS_AR = /^(?:لو سمحت )?(?:روح|روحني|افتح|افتحلي|افتح لي|وديني|خدني|اعرض|اعرضلي|وريني|عايز اروح|عايز|عايزه|ادخل|انقلني)\s+(?:علي |عل |الي |لحد )?(.+)$/;
// after normalising: French without accents, elisions split ("l' ecran")
const GO_WORDS_FR = /^(?:va a|vas a|aller a|allez a|ouvre|ouvrez|ouvrir|montre moi|montrez moi|affiche|emmene moi a|emmene moi sur|je veux voir|je veux aller a|je veux aller sur|passe a)\s+(?:la |le |les |l' |mes |mon |ma |sur )?(.+)$/;
// Urdu and Hindi put the verb last: "سیٹنگز کھولو", "सेटिंग्स खोलो"
const GO_WORDS_UR = /^(.+?)\s+(?:کھولو|کھولیں|کھول دو|پر جاؤ|پر جائیں|پر لے چلو|دکھاؤ|دکھائیں|میں جاؤ|والا صفحہ کھولو)$/;
const GO_WORDS_HI = /^(.+?)\s+(?:खोलो|खोलें|खोल दो|पर जाओ|पर जाएं|पर ले चलो|दिखाओ|दिखाएं|में जाओ|वाला पेज खोलो)$/;
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
const TARGETS_MORE: Partial<Record<NavTarget, string[]>> = {
  medicines: ['médicaments', 'mes médicaments', 'médicament', 'traitement', 'rappels', 'pilules', 'دوائیں', 'میری دوائیں', 'دوا', 'ادویات', 'یاد دہانی', 'दवाइयां', 'मेरी दवाइयां', 'दवा', 'दवाएं', 'रिमाइंडर'],
  boxcheck: ['vérifier une boîte de médicament', 'boîte de médicament', 'lire la boîte', 'دوا کا ڈبہ', 'ڈبہ چیک کرو', 'दवा का डिब्बा', 'डिब्बा जांचो'],
  photos: ['photos', 'mes photos', 'photos de plaie', 'تصاویر', 'میری تصاویر', 'تصویریں', 'फोटो', 'मेरी फोटो', 'तस्वीरें'],
  card: ["carte d'urgence", "ma carte d'urgence", 'ایمرجنسی کارڈ', 'میرا ایمرجنسی کارڈ', 'इमरजेंसी कार्ड', 'आपातकालीन कार्ड'],
  caregivers: ['aidants', 'mes aidants', 'aidant', 'famille', 'تیماردار', 'میرے تیماردار', 'دیکھ بھال کرنے والے', 'خاندان', 'देखभालकर्ता', 'मेरे देखभालकर्ता', 'देखभाल करने वाले', 'परिवार'],
  interpreter: ['interprète', 'traducteur', 'traduire', "interprète de consultation", 'مترجم', 'ترجمہ', 'دورے کا مترجم', 'दुभाषिया', 'अनुवादक', 'अनुवाद'],
  care: ['soins', 'mes soins', 'دیکھ بھال', 'میری دیکھ بھال', 'देखभाल', 'मेरी देखभाल'],
  diary: ['journal', 'mon journal', 'journal des symptômes', 'ڈائری', 'میری ڈائری', 'डायरी', 'मेरी डायरी'],
  progress: ['progrès', 'évolution', 'ce qui a changé', 'پیش رفت', 'کیا بدلا', 'प्रगति', 'क्या बदला'],
  home: ['accueil', "page d'accueil", 'tableau de bord', 'ہوم', 'مرکزی صفحہ', 'ڈیش بورڈ', 'होम', 'मुख्य पेज', 'डैशबोर्ड'],
  profile: ['profil', 'mon profil', 'mon compte', 'compte', 'پروفائل', 'میرا پروفائل', 'میرا اکاؤنٹ', 'प्रोफाइल', 'मेरी प्रोफाइल', 'मेरा खाता'],
  settings: ['paramètres', 'réglages', 'ترتیبات', 'سیٹنگز', 'सेटिंग्स', 'सेटिंग'],
  preferences: ['préférences', 'préférences de communication', 'ترجیحات', 'पसंद', 'प्राथमिकताएं'],
  history: ['historique', 'mes rapports', 'rapports', 'mes consultations', 'تاریخچہ', 'ہسٹری', 'میری رپورٹس', 'رپورٹس', 'इतिहास', 'हिस्ट्री', 'मेरी रिपोर्ट', 'रिपोर्ट'],
  doctor: ['mon médecin', 'médecin', 'docteur', 'میرا ڈاکٹر', 'ڈاکٹر', 'मेरे डॉक्टर', 'डॉक्टर'],
  patients: ['patients', 'mes patients', 'مریض', 'میرے مریض', 'मरीज', 'मेरे मरीज'],
  consultations: ['consultations', 'boîte de réception', 'مشاورتیں', 'ان باکس', 'परामर्श', 'इनबॉक्स'],
  signal: ['signal', 'signal silencieux', 'tableau de communication', 'سگنل', 'خاموش اشارہ', 'सिग्नल', 'मौन संकेत'],
  camera: ['caméra', 'langue des signes', 'کیمرہ', 'اشاروں کی زبان', 'कैमरा', 'सांकेतिक भाषा'],
  about: ['à propos', 'ce qui est réel', 'کے بارے میں', 'کیا اصلی ہے', 'के बारे में', 'क्या असली है'],
  signin: ['connexion', 'se connecter', 'لاگ ان', 'سائن ان', 'लॉग इन', 'साइन इन'],
  signup: ['inscription', 'créer un compte', 'nouveau compte', 'اکاؤنٹ بنائیں', 'نیا اکاؤنٹ', 'رجسٹر', 'खाता बनाएं', 'नया खाता', 'रजिस्टर'],
  talk: ['parler à accesscare', 'parler', 'assistant', 'بات کرو', 'اسسٹنٹ', 'बात करो', 'सहायक'],
};
for (const [t, words] of TARGETS) words.push(...(TARGETS_MORE[t] ?? []));
const LANG_AR = /(arabic|arabe|عربي|العربي|العربيه|عربی|अरबी)/;
const LANG_EN = /(english|anglais|انجليزي|الانجليزي|الانجليزيه|انجلش|انگریزی|انگلش|अंग्रेजी|इंग्लिश)/;
const LANG_FR = /(french|francais|فرنساوي|فرنسي|الفرنسيه|الفرنساوي|فرانسیسی|فرنچ|फ्रेंच|फ्रांसीसी)/;
const LANG_UR = /(urdu|ourdou|اوردو|الاورديه|اردو|उर्दू)/;
const LANG_HI = /(hindi|هندي|الهنديه|الهندي|ہندی|हिंदी|हिन्दी)/;
const LANG_CHANGE = /(language|switch|change|speak|talk|لغه|اللغه|غير|حول|خلي|اتكلم|كلمني|langue|parle|passe|mets|زبان|بولو|بات کرو|کر دو|بدلو|بدل دو|भाषा|बोलो|बात करो|कर दो|बदलो|बदल दो|में करो)/;

const PRESS = /^(?:please )?(?:press|click|tap|select|choose|pick|hit|activate|push|open|turn on|turn off|check|uncheck)\s+(?:on |the )?(.+?)(?: button)?$/;
const PRESS_AR = /^(?:لو سمحت )?(?:دوس على|دوس|اضغط على|اضغط|اختار|اختر|انقر على|انقر|افتح|شغل|اقفل|علم على)\s+(.+)$/;
const PRESS_FR = /^(?:appuie sur|appuyez sur|appuyer sur|clique sur|cliquez sur|touche|choisis|choisissez|selectionne|selectionnez|active|coche|decoche)\s+(?:le |la |les |l' |sur )?(.+?)(?: bouton)?$/;
const PRESS_UR = /^(.+?)\s+(?:دباؤ|دبائیں|دبا دو|پر کلک کرو|پر کلک کریں|چنو|منتخب کرو|منتخب کریں)$/;
const PRESS_HI = /^(.+?)\s+(?:दबाओ|दबाएं|दबा दो|पर क्लिक करो|पर क्लिक करें|चुनो|चुनें)$/;
const FILL = /^(?:please )?(?:set|type|enter|put|write|fill(?: in)?)\s+(?:the |my )?(.+?)\s+(?:to|as|with|is)\s+(.+)$/;
const FILL2 = /^(?:please )?(?:type|enter|write)\s+(.+?)\s+(?:in|into|in the|into the)\s+(.+?)(?: field)?$/;
const FILL3 = /^my (name|full name|email|email address|patient id|doctor id|phone|password) is\s+(.+)$/;
const FILL_AR = /^(?:اكتب|اكتبلي|حط)\s+(.+?)\s+(?:في|فى)\s+(?:خانه\s+)?(.+)$/;
const FILL3_AR = /^(?:اسمي|الاسم)\s+(.+)$/;
const FILL_FR = /^(?:ecris|écris|ecrivez|écrivez|tape|tapez|mets|mettez|saisis|saisissez)\s+(.+?)\s+(?:dans le champ|dans la case|dans|dans le|dans la)\s+(.+)$/i;
const FILL3_FR = /^(?:je m'appelle|je m’appelle|mon nom est|mon nom c'est)\s+(.+)$/i;
const FILL3_UR = /^(?:میرا نام)\s+(.+?)(?:\s+ہے)?[۔.]?$/;
const FILL3_HI = /^(?:मेरा नाम)\s+(.+?)(?:\s+है)?[।.]?$/;

export function phraseIs(n: string, list: string[]): boolean { return list.some((p) => norm(p) === n); }

/** What the person asked for. `n` is matched after normalising (lower case, Arabic letter variants unified). */
export function interpret(text: string): Cmd {
  const raw = text.trim();
  const n = norm(raw).replace(/^(please|لو سمحت|من فضلك|ممكن|يا اكسس كير|accesscare|access care|s' il (vous|te) plait|براہ کرم|برائے مہربانی|مہربانی کر کے|कृपया)\s+/, '').replace(/\s+(please|لو سمحت|من فضلك|s' il (vous|te) plait|plait|براہ کرم|प्लीज|कृपया)$/, '');
  if (!n) return { type: 'unknown', text: raw };
  for (const [type, list] of EXACT) if (phraseIs(n, list)) return { type } as Cmd;
  if (LANG_AR.test(n) && (LANG_CHANGE.test(n) || n.split(' ').length <= 2)) return { type: 'lang', lang: 'ar' };
  if (LANG_EN.test(n) && (LANG_CHANGE.test(n) || n.split(' ').length <= 2)) return { type: 'lang', lang: 'en' };
  if (LANG_FR.test(n) && (LANG_CHANGE.test(n) || n.split(' ').length <= 2)) return { type: 'lang', lang: 'fr' };
  if (LANG_UR.test(n) && (LANG_CHANGE.test(n) || n.split(' ').length <= 2)) return { type: 'lang', lang: 'ur' };
  if (LANG_HI.test(n) && (LANG_CHANGE.test(n) || n.split(' ').length <= 2)) return { type: 'lang', lang: 'hi' };
  if (/(blind mode|الوضع الصوتي|mode vocal|mode aveugle|صوتی موڈ|نابینا موڈ|वॉइस मोड|वॉयस मोड|ब्लाइंड मोड)/.test(n) && /\b(off|exit|stop|close|disable)\b|اقفل|اطفي|الغي|اخرج|desactive|quitte|arrete|ferme|بند|باہر|बंद|बाहर/.test(n)) return { type: 'exit' };
  if (/(slow|ابطا|براحه|ببطء|lentement|آہستہ|धीरे)/.test(n) && /(speak|talk|اتكلم|كلام|parle|بولو|بات|बोलो|बात)/.test(n)) return { type: 'slower' };
  if (/(latest|last|recent|newest|اخر|dernier|derniere|آخری|آخري|आखिरी)/.test(n) && /(report|تقرير|rapport|رپورٹ|रिपोर्ट)/.test(n)) return { type: 'read_latest_report' };
  if (/(doctor|دكتور|medecin|docteur|ڈاکٹر|डॉक्टर)/.test(n) && /(reply|response|respond|answer|message|رد|رساله|رسايل|reponse|repondu|جواب|پیغام|जवाब|संदेश)/.test(n)) return { type: 'read_doctor_reply' };
  if (/(report|describe|tell|ابلغ|اقول|احكي|signaler|decrire|dire|بتانا|بتاؤں|बताना|बताऊं)/.test(n) && /(symptom|pain|not feeling well|عرض|وجع|تعبان|symptome|douleur|علامت|درد|लक्षण|दर्द)/.test(n)) return { type: 'new_report' };
  if (/(fill|complete|املا|املى|اكمل|remplir|remplis|بھر|भर)/.test(n) && /(form|فورم|خانات|بيانات|formulaire|فارم|फॉर्म)/.test(n)) return { type: 'fill_form' };
  if (/^(help me|ساعدني|aide moi|aidez moi)/.test(n) && /(log ?in|sign ?in|sign ?up|register|ادخل|اسجل|connecter|inscrire)/.test(n)) return { type: 'fill_form' };
  if (/(read|اقرا|lis|lire|پڑھو|पढो)/.test(n) && /(form|فورم|خانات|formulaire|فارم|फॉर्म)/.test(n)) return { type: 'read_form' };
  if (/^scroll (down|up)$|^(انزل|اطلع) (لتحت|لفوق)?$|^(descends|descendre|monte|monter)$|^(نیچے|اوپر) (جاؤ|کرو)$|^(नीचे|ऊपर) (जाओ|करो)$/.test(n)) return { type: 'scroll', dir: /down|انزل|descend|نیچے|नीचे/.test(n) ? 'down' : 'up' };

  // fill a field: "set email to x", "type x in email", "my name is x"
  let m = raw.match(new RegExp(FILL.source, 'i')) ?? null;
  if (m) return { type: 'fill', field: m[1].trim(), value: m[2].trim() };
  m = raw.match(new RegExp(FILL2.source, 'i'));
  if (m) return { type: 'fill', field: m[2].trim(), value: m[1].trim() };
  m = raw.match(new RegExp(FILL3.source, 'i'));
  if (m) return { type: 'fill', field: m[1].trim(), value: m[2].trim() };
  m = raw.match(FILL_AR);
  if (m) return { type: 'fill', field: m[2].trim(), value: m[1].trim() };
  m = raw.match(FILL3_AR) ?? raw.match(FILL3_FR) ?? raw.match(FILL3_UR) ?? raw.match(FILL3_HI);
  if (m) return { type: 'fill', field: 'name', value: m[1].trim() };
  m = raw.match(FILL_FR);
  if (m) return { type: 'fill', field: m[2].trim(), value: m[1].trim() };

  // navigation: "open my profile", "go to settings", "افتح الإعدادات", or just the page name
  const target = (s: string): NavTarget | null => {
    const forms = new Set<string>();
    let x = norm(s).replace(/^(the|my|page|la page|l' ecran|میری|میرا|میرے|मेरी|मेरा|मेरे)\s+/, '').replace(/\s+(page|screen|tab|الصفحه|صفحہ|کا صفحہ|پیج|पेज|का पेज)$/, '');
    forms.add(x); forms.add(norm(s));
    // Arabic: "للصفحة الرئيسية", "لصفحة الإعدادات", "على البروفايل"
    x = x.replace(/^(لل|ل)(?=\S)/, 'ال'); forms.add(x);
    x = x.replace(/^(الصفحه|صفحه)\s+/, ''); forms.add(x);
    for (const [t, words] of TARGETS) if (words.some((w) => forms.has(norm(w)))) return t;
    return null;
  };
  const g = n.match(GO_WORDS) ?? n.match(GO_WORDS_AR) ?? n.match(GO_WORDS_FR) ?? n.match(GO_WORDS_UR) ?? n.match(GO_WORDS_HI);
  if (g) { const t = target(g[1]); if (t) return { type: 'go', to: t }; }
  const bare = target(n); if (bare) return { type: 'go', to: bare };

  const p = n.match(PRESS) ?? n.match(PRESS_AR) ?? n.match(PRESS_FR) ?? n.match(PRESS_UR) ?? n.match(PRESS_HI);
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
// French (accents folded), Urdu, Hindi
const CONSEQUENTIAL_MORE = /\b(envoy|soumet|approuv|valid|partag|supprim|retir|deconnect|connect|annul|rejet|ordonnance|sign|reinitialis|effac)|بھیج|منظور|شیئر|حذف|مٹا|لاگ آؤٹ|منسوخ|رد کر|نسخہ|جوڑ|منقطع|भेज|मंजूर|साझा|शेयर|हटा|मिटा|लॉग आउट|रद्द|अस्वीकार|पर्चा|नुस्खा|जोड|डिस्कनेक्ट/i;
export const isConsequential = (name: string) => CONSEQUENTIAL.test(name) || CONSEQUENTIAL_MORE.test(foldText(name.toLowerCase()));
