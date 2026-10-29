// Words AccessCare understands without AI (English, Modern Standard Arabic and
// Egyptian Arabic): symptoms, body parts, time, strength, pattern, uncertainty,
// corrections and feelings. Used by the rule-based understanding (always on, and
// the fallback when AI is off or does not answer) and to validate AI output.
// This is vocabulary, not diagnosis.

import type { Sensation } from '../../domain/types';
import type { SlotId } from '../../domain/conversation';
import { MORE, NEGATORS_BEFORE, NEGATORS_AFTER, NEG_TAIL } from './lexiconMore';

/** the French, Urdu and Hindi words for an entry */
const more = (key: string): string[] => { const m = MORE[key]; return m ? [...(m.fr ?? []), ...(m.ur ?? []), ...(m.hi ?? [])] : []; };

// ---------------------------------------------------------------- text helpers
import { foldText } from '../langWords';

/**
 * lower-case, Arabic letter variants unified, French accents optional, Hindi spelling
 * variants unified, digits in every script as 0-9, punctuation removed, single spaces.
 * French elisions are split ("l'estomac" → "l' estomac") so the noun matches on its own.
 */
export function norm(text: string): string {
  return foldText(text.toLowerCase()).replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
    .replace(/[\u064b-\u065f\u0670\u06d6-\u06ed\u0640]/g, '') // harakat, hamza marks, tatweel
    .replace(/(^|[\s(])(qu|[ljdmnstc])'(?=\p{L})/gu, "$1$2' ")
    .replace(/[^\p{L}\p{M}\p{N}' ]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

const AR_PREFIXES = ['وبال', 'فبال', 'بال', 'وال', 'فال', 'لل', 'ال', 'و', 'ب', 'ف', 'ل'];
const AR_SUFFIXES = ['', 'ي', 'يا', 'ه', 'ها', 'ك', 'نا', 'هم', 'ين', 'ات'];
/** Arabic (not Urdu: Urdu words never get Arabic prefixes or suffixes removed) */
const isArabic = (s: string) => /[؀-ۿ]/.test(s) && !/[ٹڈڑںھہۂیےۓکگپچژ]/.test(s);
export const isArabicScript = (s: string) => /[؀-ۿ]/.test(s);

function tokenForms(tok: string): string[] {
  const out = new Set([tok]);
  if (isArabic(tok)) {
    for (const p of AR_PREFIXES) if (tok.startsWith(p) && tok.length - p.length >= 2) out.add(tok.slice(p.length));
  } else if (tok.length > 3 && tok.endsWith('s')) out.add(tok.slice(0, -1));
  return [...out];
}

function wordMatches(tok: string, form: string): boolean {
  for (const t of tokenForms(tok)) {
    if (t === form) return true;
    if (isArabic(form)) {
      for (const s of AR_SUFFIXES) {
        if (!s) continue;
        if (t === form + s) return true;
        // taa marbuta before a suffix: ركبه → ركبتي
        if (form.endsWith('ه') && t === form.slice(0, -1) + 'ت' + s) return true;
      }
    }
  }
  return false;
}

export interface Hit { index: number; length: number; form: string }

/** Finds the first occurrence of any form (word or phrase) in normalized tokens. */
export function findAny(tokens: string[], forms: string[]): Hit | null {
  let best: Hit | null = null;
  for (const raw of forms) {
    const f = norm(raw).split(' ');
    for (let i = 0; i + f.length <= tokens.length; i++) {
      let ok = true;
      for (let k = 0; k < f.length; k++) if (!wordMatches(tokens[i + k], f[k])) { ok = false; break; }
      if (ok) {
        const len = f.join(' ').length;
        if (!best || len > best.length || (len === best.length && i < best.index)) best = { index: i, length: len, form: raw };
        break;
      }
    }
  }
  return best;
}
export const tokensOf = (text: string) => norm(text).split(' ').filter(Boolean);
export const hasAny = (text: string, forms: string[]) => !!findAny(tokensOf(text), forms);

const NEGATORS = ['no', 'not', 'without', "don't", 'dont', 'never', 'none', "haven't", 'havent', 'مفيش', 'مافيش', 'مش', 'ما', 'لا', 'بدون', 'غير', 'من غير', 'معنديش', 'ماعنديش', 'مبقاش', 'ليس', 'لا يوجد', ...NEGATORS_BEFORE].map(norm);
const NEG_AFTER = NEGATORS_AFTER.map(norm), NEG_END = NEG_TAIL.map(norm);
/**
 * true when one of the two words before a hit negates it ("no nausea", "مفيش غثيان", "pas de fièvre"),
 * or — in Urdu and Hindi — "no" comes right after it and ends the sentence ("بخار نہیں ہے", "बुखार नहीं").
 * `length` is the hit's number of words (for the Urdu/Hindi check).
 */
export function negatedAt(tokens: string[], index: number, length = 1): boolean {
  for (let k = Math.max(0, index - 2); k < index; k++) if (NEGATORS.includes(tokens[k])) return true;
  const after = index + length;
  if (NEG_AFTER.includes(tokens[after] ?? '') && (after + 1 >= tokens.length || NEG_END.includes(tokens[after + 1]))) return true;
  return false;
}

// ---------------------------------------------------------------- body
export interface BodyWord { region: string; sided?: boolean; area: AreaId; detail?: string; words: string[] }
export type AreaId = 'head' | 'face' | 'neck' | 'chest' | 'abdomen' | 'back' | 'arm' | 'leg' | 'general';

export const BODY: BodyWord[] = [
  { region: 'head', area: 'head', words: ['head', 'skull', 'scalp', 'راس', 'رأس', 'دماغ', 'الدماغ', 'نافوخ'] },
  { region: 'head', area: 'head', detail: 'forehead', words: ['forehead', 'front of my head', 'جبهه', 'جبين', 'قوره', 'مقدمه راسي', 'مقدمه الراس', 'مقدمه راس'] },
  { region: 'head', area: 'head', detail: 'temples', words: ['temple', 'temples', 'صدغ', 'الصدغين', 'صدغي'] },
  { region: 'head', area: 'head', detail: 'back_of_head', words: ['back of my head', 'back of the head', 'ورا راسي', 'ورا الراس', 'مؤخره الراس', 'مؤخره راسي', 'قفا'] },
  { region: 'head', area: 'head', detail: 'one_side', words: ['one side of my head', 'half of my head', 'نص راسي', 'نص دماغي', 'ناحيه واحده', 'جنب واحد'] },
  { region: 'head', area: 'head', detail: 'whole_head', words: ['whole head', 'all over my head', 'all my head', 'راسي كلها', 'دماغي كلها', 'الراس كلها', 'كل راسي'] },
  { region: 'head', area: 'head', detail: 'behind_eyes', words: ['behind my eyes', 'behind the eyes', 'ورا عيني', 'ورا العين', 'خلف العين'] },
  { region: 'face', area: 'face', words: ['face', 'cheek', 'jaw', 'وش', 'وجه', 'خد', 'فك'] },
  { region: 'face', area: 'face', detail: 'eye', words: ['eye', 'eyes', 'عين', 'عيون', 'عينيا'] },
  { region: 'face', area: 'face', detail: 'ear', words: ['ear', 'ears', 'ودن', 'وداني', 'اذن', 'ودان'] },
  { region: 'face', area: 'face', detail: 'teeth', words: ['tooth', 'teeth', 'gum', 'gums', 'سنان', 'سن', 'ضرس', 'لثه'] },
  { region: 'face', area: 'face', detail: 'nose', words: ['nose', 'مناخير', 'انف', 'منخار'] },
  { region: 'neck', area: 'neck', words: ['neck', 'رقبه', 'رقبتي'] },
  { region: 'neck', area: 'neck', detail: 'throat', words: ['throat', 'زور', 'حلق', 'بلعوم'] },
  { region: 'chest', area: 'chest', words: ['chest', 'breast', 'ribs', 'صدر', 'ضلوع', 'صدري'] },
  { region: 'abdomen', sided: true, area: 'abdomen', words: ['stomach', 'belly', 'tummy', 'abdomen', 'abdominal', 'gut', 'بطن', 'معده', 'كرش', 'مصارين'] },
  { region: 'upper_back', area: 'back', detail: 'upper', words: ['upper back', 'shoulder blade', 'ضهري من فوق', 'اعلي الظهر', 'اعلي الضهر', 'لوح الكتف'] },
  { region: 'lower_back', area: 'back', detail: 'lower', words: ['lower back', 'low back', 'ضهري من تحت', 'اسفل الظهر', 'اسفل الضهر', 'اخر ضهري', 'فقرات تحت'] },
  { region: 'upper_back', area: 'back', words: ['back', 'spine', 'ضهر', 'ظهر', 'العمود الفقري', 'فقرات'] },
  { region: 'shoulder', sided: true, area: 'arm', words: ['shoulder', 'كتف'] },
  { region: 'upper_arm', sided: true, area: 'arm', words: ['upper arm', 'arm', 'bicep', 'دراع', 'ذراع'] },
  { region: 'elbow', sided: true, area: 'arm', words: ['elbow', 'كوع', 'مرفق'] },
  { region: 'forearm', sided: true, area: 'arm', words: ['forearm', 'ساعد'] },
  { region: 'wrist', sided: true, area: 'arm', words: ['wrist', 'رسغ', 'معصم'] },
  { region: 'hand', sided: true, area: 'arm', words: ['hand', 'hands', 'finger', 'fingers', 'palm', 'thumb', 'ايد', 'يد', 'كف', 'صباع', 'صوابع', 'اصابع', 'ابهام'] },
  { region: 'hip', sided: true, area: 'leg', words: ['hip', 'ورك', 'حوض'] },
  { region: 'thigh', sided: true, area: 'leg', words: ['thigh', 'فخد', 'فخذ'] },
  { region: 'knee', sided: true, area: 'leg', words: ['knee', 'knees', 'ركبه', 'ركب'] },
  { region: 'lower_leg', sided: true, area: 'leg', words: ['leg', 'legs', 'shin', 'calf', 'ساق', 'رجل', 'رجلين', 'سمانه'] },
  { region: 'ankle', sided: true, area: 'leg', words: ['ankle', 'كاحل', 'عرقوب'] },
  { region: 'foot', sided: true, area: 'leg', words: ['foot', 'feet', 'toe', 'toes', 'heel', 'قدم', 'كعب', 'صوابع رجلي'] },
];

/** the English and Arabic words (spelling-mistake matching uses only these) */
const BODY_BASE = new Map(BODY.map((b) => [b, b.words.slice()]));
for (const b of BODY) b.words.push(...more(`body:${b.region}/${b.detail ?? ''}`));

// ---------------------------------------------------------------- symptoms
export interface Concept {
  id: string;
  en: string;
  /** Arabic name (Egyptian wording) */
  ar: string;
  /** grammatically feminine in Arabic */
  fem?: boolean;
  words: string[];
  /** body regions implied by the word itself ("headache" → head) */
  regions?: string[];
  area?: AreaId;
  sensation?: Sensation;
  /** follow-up questions, in order, for this symptom */
  plan: SlotId[];
  /** associated symptoms worth asking about (concept ids) */
  related?: string[];
}

export const CONCEPTS: Concept[] = [
  { id: 'headache', en: 'headache', ar: 'صداع', area: 'head', regions: ['head'], sensation: 'pain', plan: ['onset', 'onset_type', 'location', 'severity', 'pattern', 'associated'], related: ['nausea', 'vision', 'fever', 'stiff_neck', 'dizziness', 'speech', 'weakness'],
    words: ['headache', 'headaches', 'migraine', 'head hurts', 'head is hurting', 'head pain', 'pain in my head', 'my head hurts', 'head ache', 'صداع نصفي', 'شقيقه', 'راسي بتوجعني', 'راسي وجعاني', 'دماغي بتوجعني', 'وجع في دماغي', 'وجع في راسي', 'الم في راسي', 'الم في الراس', 'الم في مقدمه راسي', 'راسي هتنفجر', 'دماغي وجعاني', 'وجع راس', 'وجع دماغ', 'راسي تقيله', 'صداع'] },
  { id: 'abdominal_pain', en: 'stomach pain', ar: 'وجع في البطن', area: 'abdomen', regions: ['abdomen'], sensation: 'pain', plan: ['location', 'onset', 'severity', 'pattern', 'associated'], related: ['nausea', 'vomiting', 'diarrhea', 'fever'],
    words: ['stomach ache', 'stomachache', 'stomach pain', 'stomach hurts', 'belly ache', 'belly pain', 'tummy ache', 'abdominal pain', 'cramps', 'cramping', 'بطني بتوجعني', 'بطني وجعاني', 'وجع في بطني', 'وجع بطن', 'الم في البطن', 'الم في بطني', 'مغص', 'معدتي بتوجعني', 'معدتي وجعاني', 'تقلصات'] },
  { id: 'chest_pain', en: 'chest pain', ar: 'وجع في الصدر', area: 'chest', regions: ['chest'], sensation: 'pain', plan: ['onset', 'location', 'severity', 'associated'], related: ['breathing', 'sweating', 'dizziness', 'nausea'],
    words: ['chest pain', 'chest hurts', 'chest tightness', 'tight chest', 'pain in my chest', 'chest feels tight', 'chest is tight', 'chest feels heavy', 'pressure in my chest', 'وجع في صدري', 'صدري بيوجعني', 'صدري وجعاني', 'الم في الصدر', 'الم في صدري', 'تقل في صدري', 'ضغط على صدري'] },
  { id: 'back_pain', en: 'back pain', ar: 'وجع في الضهر', area: 'back', regions: [], sensation: 'pain', plan: ['location', 'onset', 'severity', 'pattern'],
    words: ['back pain', 'backache', 'back hurts', 'my back hurts', 'ضهري بيوجعني', 'ضهري وجعاني', 'وجع في ضهري', 'الم في الظهر', 'الم في ضهري', 'وجع ضهر'] },
  { id: 'sore_throat', en: 'sore throat', ar: 'وجع في الزور', area: 'neck', regions: ['neck'], sensation: 'pain', plan: ['onset', 'severity', 'associated'], related: ['fever', 'cough'],
    words: ['sore throat', 'throat hurts', 'throat pain', 'زوري بيوجعني', 'زوري وجعاني', 'وجع في زوري', 'التهاب في الزور', 'حلقي بيوجعني', 'الم في الحلق'] },
  { id: 'dizziness', fem: true, en: 'dizziness', ar: 'دوخة', area: 'general', plan: ['onset', 'pattern', 'associated'], related: ['fainting', 'headache', 'nausea'],
    words: ['dizzy', 'dizziness', 'lightheaded', 'light headed', 'vertigo', 'room is spinning', 'spinning', 'دوخه', 'دايخ', 'دايخه', 'بدوخ', 'الدنيا بتلف', 'دماغي بتلف', 'دوار'] },
  { id: 'nausea', en: 'nausea', ar: 'غثيان', area: 'general', plan: ['onset', 'pattern'],
    words: ['nausea', 'nauseous', 'nauseated', 'feel sick', 'want to throw up', 'queasy', 'قرفان', 'نفسي غامه', 'عايز ارجع', 'عايزه ارجع', 'لعيان نفسي', 'نفسي لاعبه', 'غثيان'] },
  { id: 'vomiting', en: 'vomiting', ar: 'ترجيع', area: 'general', plan: ['onset', 'pattern'],
    words: ['vomiting', 'vomit', 'vomited', 'throwing up', 'threw up', 'رجعت', 'برجع', 'استفراغ', 'ترجيع كتير', 'قيء', 'ترجيع'] },
  { id: 'diarrhea', en: 'diarrhea', ar: 'إسهال', area: 'general', plan: ['onset', 'pattern'],
    words: ['diarrhea', 'diarrhoea', 'loose stool', 'اسهال', 'بطني سايبه', 'معدتي سايبه'] },
  { id: 'fever', fem: true, en: 'fever', ar: 'سخونية', area: 'general', plan: ['onset', 'pattern', 'associated'], related: ['cough', 'sore_throat', 'headache'],
    words: ['fever', 'feverish', 'temperature', 'hot and cold', 'chills', 'سخونيه', 'سخن', 'سخنه', 'حراره', 'حمي', 'رعشه', 'سقعه'] },
  { id: 'cough', fem: true, en: 'cough', ar: 'كحة', area: 'chest', plan: ['onset', 'pattern', 'associated'], related: ['fever', 'breathing'],
    words: ['cough', 'coughing', 'كحه', 'بكح', 'سعال', 'كحه جامده'] },
  { id: 'breathing', fem: true, en: 'trouble breathing', ar: 'صعوبة في التنفس', area: 'chest', plan: ['onset', 'severity'],
    words: ['short of breath', 'shortness of breath', 'trouble breathing', 'hard to breathe', 'breathless', 'cant breathe', "can't breathe", 'ضيق تنفس', 'ضيق في التنفس', 'نفسي مقطوع', 'مش عارف اتنفس', 'صعوبه في التنفس', 'مخنوق', 'نهجان'] },
  { id: 'fatigue', en: 'tiredness', ar: 'تعب وإرهاق', area: 'general', plan: ['onset', 'pattern'],
    words: ['tired', 'tiredness', 'fatigue', 'exhausted', 'no energy', 'weak all over', 'تعبان', 'تعبانه', 'مرهق', 'مرهقه', 'ارهاق', 'هبطان', 'مفيش طاقه', 'خمول'] },
  { id: 'rash', en: 'rash', ar: 'طفح جلدي', area: 'general', sensation: 'itching', plan: ['onset', 'pattern'],
    words: ['rash', 'spots', 'hives', 'red patches', 'طفح', 'حبوب', 'بقع حمرا', 'حساسيه في جلدي', 'هرش'] },
  { id: 'numbness', en: 'numbness', ar: 'تنميل', area: 'general', sensation: 'numbness', plan: ['side', 'onset', 'onset_type', 'pattern'],
    words: ['numb', 'numbness', 'pins and needles', 'tingling', 'منمل', 'منمله', 'خدر', 'شكشكه', 'تنميل'] },
  { id: 'weakness', en: 'weakness', ar: 'ضعف', area: 'general', sensation: 'weakness', plan: ['side', 'onset', 'onset_type'],
    words: ['weakness', 'weakness in', 'cant move my', "can't move my", 'weak arm', 'weak leg', 'ضعف في', 'مش قادر احرك', 'تقل في دراعي', 'تقل في رجلي'] },
  { id: 'vision', fem: true, en: 'vision problems', ar: 'مشكلة في النظر', area: 'face', regions: ['face'], plan: ['onset', 'onset_type'],
    words: ['blurry vision', 'blurred vision', 'cant see', "can't see well", 'seeing double', 'double vision', 'زغلله', 'مش شايف كويس', 'نظري ضعف فجاه', 'بشوف اتنين'] },
  { id: 'speech', fem: true, en: 'trouble speaking', ar: 'صعوبة في الكلام', area: 'face', regions: [], plan: ['onset_type', 'onset'],
    words: ['slurred speech', 'slurring', 'slurred', 'speech is slurred', 'trouble speaking', 'difficulty speaking', 'trouble talking', 'words come out wrong', "can't get my words out", 'cant find my words', "can't find the right words", 'speech problem', 'لساني تقيل', 'لساني تقل', 'كلامي تقيل', 'كلامي متلخبط', 'بتلخبط في الكلام', 'صعوبه في الكلام', 'صعوبه في النطق', 'مش قادر انطق', 'مش عارف انطق', 'الكلام مش طالع'] },
  { id: 'stiff_neck', en: 'stiff neck', ar: 'تيبس في الرقبة', area: 'neck', regions: ['neck'], plan: ['onset'],
    words: ['stiff neck', 'neck is stiff', 'رقبتي متخشبه', 'تيبس في الرقبه', 'رقبتي ناشفه'] },
  { id: 'fainting', en: 'fainting', ar: 'إغماء', area: 'general', plan: ['onset'],
    words: ['fainted', 'passed out', 'blacked out', 'اغمي عليا', 'اغمي علي', 'اتغمي عليا', 'فقدت الوعي'] },
  { id: 'sweating', en: 'sweating', ar: 'عرق', area: 'general', plan: [],
    words: ['sweating', 'sweaty', 'cold sweat', 'عرقان', 'بعرق', 'عرق بارد'] },
  { id: 'pain', en: 'pain', ar: 'وجع', area: 'general', sensation: 'pain', plan: ['side', 'location', 'sensation', 'onset', 'severity', 'pattern'],
    words: ['pain', 'hurts', 'hurting', 'ache', 'aching', 'sore', 'painful', 'الم', 'بيوجعني', 'بتوجعني', 'وجعاني', 'واجعني', 'بيوجع', 'بتوجع', 'موجوع', 'وجع'] },
  { id: 'unwell', en: 'feeling unwell', ar: 'مش مرتاح', area: 'general', plan: [],
    words: ['not feeling well', 'feel unwell', 'feel bad', 'feel strange', 'not normal', 'not myself', 'something is wrong', 'sick', 'مش طبيعي', 'مش مظبوط', 'حاسس اني مش طبيعي', 'مش كويس', 'تعبان شويه', 'حاسس بحاجه غريبه', 'مش مرتاح'] },
];
const CONCEPT_BASE = new Map(CONCEPTS.map((c) => [c.id, c.words.slice()]));
for (const c of CONCEPTS) c.words.push(...more(`concept:${c.id}`));
export const CONCEPT_BY_ID: Record<string, Concept> = Object.fromEntries(CONCEPTS.map((c) => [c.id, c]));

// ---------------------------------------------------------------- slot values
export interface ValueWord { value: string; en: string; ar: string; words: string[] }

export const SEVERITY: ValueWord[] = [
  { value: 'mild', en: 'mild', ar: 'خفيف', words: ['mild', 'a little', 'slight', 'not bad', 'light', 'small', 'خفيفه', 'شويه', 'بسيط', 'بسيطه', 'مش جامد', 'خفيف'] },
  { value: 'moderate', en: 'moderate', ar: 'متوسط', words: ['moderate', 'medium', 'so so', 'middle', 'متوسطه', 'نص نص', 'وسط', 'متوسط'] },
  { value: 'severe', en: 'severe', ar: 'شديد', words: ['severe', 'very bad', 'terrible', 'strong', 'really bad', 'unbearable', 'awful', 'worst', 'شديده', 'جامد', 'جامده', 'قوي', 'قويه', 'جدا', 'مش مستحمل', 'مش قادر استحمل', 'فظيع', 'رهيب', 'موت', 'شديد'] },
];
export const ONSET: ValueWord[] = [
  { value: 'today', en: 'today', ar: 'النهارده', words: ['today', 'this morning', 'this afternoon', 'tonight', 'this evening', 'an hour ago', 'hours ago', 'few hours', 'just now', 'since morning', 'اليوم', 'الصبح', 'من الصبح', 'الصبحيه', 'من شويه', 'من ساعه', 'من ساعتين', 'من كام ساعه', 'بالليل', 'العصر', 'الضهر', 'النهارده'] },
  { value: 'days', en: 'a few days ago', ar: 'من كام يوم', words: ['yesterday', 'last night', 'two days', '2 days', 'three days', '3 days', 'few days', 'couple of days', 'days ago', 'امبارح', 'امس', 'من يومين', 'يومين', 'تلات ايام', 'ثلاث ايام', 'كام يوم', 'اول امبارح', 'من كام يوم'] },
  { value: 'week', en: 'about a week ago', ar: 'من حوالي أسبوع', words: ['a week', 'one week', 'last week', 'about a week', 'اسبوع', 'من اسبوع', 'الاسبوع اللي فات', 'جمعه'] },
  { value: 'longer', en: 'more than a week ago', ar: 'من أكتر من أسبوع', words: ['weeks', 'a month', 'months', 'a long time', 'years', 'for ages', 'اسبوعين', 'اسابيع', 'شهر', 'شهور', 'من زمان', 'سنين', 'سنه', 'من فتره'] },
];
export const ONSET_TYPE: ValueWord[] = [
  { value: 'sudden', en: 'started suddenly', ar: 'بدأ فجأة', words: ['suddenly', 'sudden', 'all of a sudden', 'out of nowhere', 'at once', 'فجاه', 'فجأه', 'مره واحده', 'على طول كده', 'من غير مقدمات'] },
  { value: 'gradual', en: 'came on gradually', ar: 'زاد بالتدريج', words: ['gradually', 'slowly', 'bit by bit', 'got worse over time', 'built up', 'تدريجي', 'بالتدريج', 'شويه شويه', 'بالراحه', 'زاد مع الوقت', 'بيزيد'] },
];
export const PATTERN: ValueWord[] = [
  { value: 'constant', en: 'all the time', ar: 'على طول', words: ['constant', 'all the time', 'always', 'continuous', 'never stops', 'nonstop', 'علطول', 'دايما', 'دائما', 'مستمر', 'مبيروحش', 'مش بيروح', 'على طول'] },
  { value: 'comes_and_goes', en: 'comes and goes', ar: 'بييجي ويروح', words: ['comes and goes', 'on and off', 'sometimes', 'now and then', 'off and on', 'بيروح ويجي', 'ساعات', 'احيانا', 'مش على طول', 'كل شويه', 'بييجي ويروح'] },
];
export const SIDE: ValueWord[] = [
  { value: 'left', en: 'left side', ar: 'الناحية الشمال', words: ['left', 'شمال', 'يسار', 'الشمال', 'اليسار'] },
  { value: 'right', en: 'right side', ar: 'الناحية اليمين', words: ['right side', 'right', 'يمين', 'اليمين'] },
  { value: 'both', en: 'both sides', ar: 'الناحيتين', words: ['both', 'both sides', 'الاتنين', 'الجهتين', 'الاثنين', 'الناحيتين'] },
];
export const SENSATIONS: ValueWord[] = [
  { value: 'pain', en: 'pain', ar: 'وجع', words: ['pain', 'ache', 'hurts', 'sore', 'الم', 'وجع'] },
  { value: 'burning', en: 'burning', ar: 'حرقان', words: ['burning', 'burns', 'بيحرق', 'نار', 'حرقان'] },
  { value: 'numbness', en: 'numbness', ar: 'تنميل', words: ['numb', 'numbness', 'منمل', 'تنميل'] },
  { value: 'tingling', en: 'tingling', ar: 'وخز', words: ['tingling', 'pins and needles', 'prickling', 'نغزات', 'زي الابر', 'شكشكه', 'وخز'] },
  { value: 'itching', en: 'itching', ar: 'حكة', words: ['itch', 'itching', 'itchy', 'حكه', 'هرش', 'بياكلني'] },
  { value: 'swelling', en: 'swelling', ar: 'تورم', words: ['swelling', 'swollen', 'وارم', 'منفوخ', 'تورم'] },
  { value: 'weakness', en: 'weakness', ar: 'ضعف', words: ['weak', 'weakness', 'ضعيف', 'ضعف'] },
];
for (const [p, list] of [['sev', SEVERITY], ['onset', ONSET], ['otype', ONSET_TYPE], ['pat', PATTERN], ['side', SIDE], ['sens', SENSATIONS]] as [string, ValueWord[]][]) for (const v of list) v.words.push(...more(`${p}:${v.value}`));
/** location detail options, by area */
export const LOCATIONS: Partial<Record<AreaId, ValueWord[]>> = {
  head: [
    { value: 'forehead', en: 'forehead', ar: 'الجبهة', words: [] },
    { value: 'temples', en: 'temples', ar: 'الصدغين', words: [] },
    { value: 'back_of_head', en: 'back of the head', ar: 'ورا الراس', words: [] },
    { value: 'one_side', en: 'one side of the head', ar: 'ناحية واحدة من الراس', words: [] },
    { value: 'whole_head', en: 'the whole head', ar: 'الراس كلها', words: [] },
    { value: 'behind_eyes', en: 'behind the eyes', ar: 'ورا العينين', words: [] },
  ],
  abdomen: [
    { value: 'upper', en: 'upper belly', ar: 'فوق البطن (فم المعدة)', words: ['upper', 'top', 'above', 'فوق', 'اعلي', 'فم المعده', 'تحت الضلوع'] },
    { value: 'lower', en: 'lower belly', ar: 'تحت البطن', words: ['lower', 'bottom', 'below', 'تحت', 'اسفل', 'تحت السره'] },
    { value: 'right', en: 'right side of the belly', ar: 'يمين البطن', words: ['right side', 'right', 'يمين', 'اليمين'] },
    { value: 'left', en: 'left side of the belly', ar: 'شمال البطن', words: ['left side', 'left', 'شمال', 'الشمال', 'يسار'] },
    { value: 'around_navel', en: 'around the belly button', ar: 'حوالين السرة', words: ['belly button', 'navel', 'middle', 'around the belly button', 'سره', 'السره', 'حوالين السره', 'النص'] },
    { value: 'whole', en: 'the whole belly', ar: 'البطن كلها', words: ['whole', 'all over', 'everywhere', 'كلها', 'كله', 'في كل حته', 'البطن كلها'] },
  ],
  chest: [
    { value: 'center', en: 'middle of the chest', ar: 'نص الصدر', words: ['middle', 'center', 'centre', 'نص', 'النص', 'وسط'] },
    { value: 'left', en: 'left side of the chest', ar: 'شمال الصدر', words: ['left', 'شمال', 'يسار'] },
    { value: 'right', en: 'right side of the chest', ar: 'يمين الصدر', words: ['right', 'يمين'] },
    { value: 'whole', en: 'the whole chest', ar: 'الصدر كله', words: ['whole', 'all over', 'كله', 'كلها'] },
  ],
  back: [
    { value: 'upper', en: 'upper back', ar: 'الضهر من فوق', words: ['upper', 'top', 'فوق', 'اعلي'] },
    { value: 'middle', en: 'middle of the back', ar: 'نص الضهر', words: ['middle', 'نص', 'وسط'] },
    { value: 'lower', en: 'lower back', ar: 'الضهر من تحت', words: ['lower', 'bottom', 'تحت', 'اسفل'] },
    { value: 'one_side', en: 'one side of the back', ar: 'ناحية واحدة من الضهر', words: ['one side', 'side', 'جنب', 'ناحيه'] },
  ],
};
for (const [area, list] of Object.entries(LOCATIONS)) for (const v of list ?? []) if (area !== 'head') v.words.push(...more(`loc:${area}:${v.value}`));
// head detail words come from BODY entries
for (const b of BODY) if (b.area === 'head' && b.detail) { const v = LOCATIONS.head!.find((x) => x.value === b.detail); if (v) v.words.push(...b.words); }

// ---------------------------------------------------------------- conversation cues
export const CUES = {
  notSure: ["not sure", "don't know", 'dont know', 'no idea', 'unsure', 'hard to say', "can't tell", 'مش متاكد', 'مش عارف', 'مش عارفه', 'معرفش', 'لا اعرف', 'غير متاكد', 'مش فاكر', 'مش فاكره', 'الله اعلم'],
  cantDescribe: ["can't describe", 'cant describe', "don't know how to describe", 'hard to describe', "don't know how to explain", 'مش عارف اوصف', 'مش عارفه اوصف', 'مش قادر اوصف', 'صعب اوصف', 'مش عارف اقول', 'مش عارف اشرح'],
  fear: ['scared', 'afraid', 'worried', 'anxious', 'frightened', 'panic', 'nervous', 'خايف', 'خايفه', 'قلقان', 'قلقانه', 'مرعوب', 'متوتر', 'متوتره', 'قلق'],
  pause: ['wait', 'hold on', 'give me a minute', 'one moment', 'pause', 'stop for now', 'استني', 'ثانيه', 'لحظه', 'دقيقه', 'استنى شويه', 'خليني افكر'],
  stop: ['stop', "i don't want to continue", 'enough', 'leave it', 'كفايه', 'مش عايز اكمل', 'مش عايزه اكمل', 'سيبني', 'خلاص كده'],
  speakingHard: ["can't speak well", 'hard to talk', 'hard to speak', 'difficult to speak', 'مش قادر اتكلم كويس', 'صعب عليا الكلام', 'مش عارف اتكلم كويس'],
  correction: ['actually', 'i meant', 'i mean', 'sorry', 'correction', 'not', 'no wait', 'instead', 'changed my mind', 'قصدي', 'اقصد', 'لا ده', 'لا هو', 'مش كده', 'غلط', 'بالعكس', 'اسف', 'صحح', 'تصحيح', 'لا لا'],
  yes: ['yes', 'yeah', 'yep', 'correct', 'right', "that's right", 'exactly', 'sure', 'ok', 'okay', 'نعم', 'ايوه', 'ايوا', 'اه', 'صح', 'مظبوط', 'بالظبط', 'تمام', 'اكيد', 'ماشي'],
  no: ['no', 'nope', 'not really', 'wrong', 'incorrect', 'لا', 'لاء', 'لأ', 'مش صح', 'غلط', 'لا خالص', 'مش كده'],
  nothingElse: ["that's all", 'that is all', 'nothing else', 'no thanks', 'nothing', 'none', 'none of them', 'none of these', 'done', "that's it", 'ولا حاجه', 'ولا واحده', 'بس كده', 'مفيش حاجه تانيه', 'مفيش', 'خلاص', 'لا شكرا', 'كده تمام'],
  question: ['?', '؟'],
  questionStart: ['is it', 'is this', 'is that', 'should i', 'can i', 'could it', 'what is', 'what does', 'what should', 'why', 'how long', 'how can', 'do i need', 'will it', 'هل', 'ليه', 'ايه سبب', 'ايه اللي', 'ازاي', 'امتي', 'ينفع', 'اعمل ايه', 'ده خطير', 'ده معناه ايه', 'المفروض'],
};

for (const [k, list] of Object.entries(CUES)) list.push(...more(`cue:${k}`));

// ---------------------------------------------------------------- spelling mistakes
/** Jaro-Winkler similarity (0..1). */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const la = a.length, lb = b.length;
  if (!la || !lb) return 0;
  const md = Math.max(0, Math.floor(Math.max(la, lb) / 2) - 1);
  const ma = new Array(la).fill(false), mb = new Array(lb).fill(false);
  let m = 0;
  for (let i = 0; i < la; i++) for (let j = Math.max(0, i - md); j < Math.min(lb, i + md + 1); j++) if (!mb[j] && a[i] === b[j]) { ma[i] = mb[j] = true; m++; break; }
  if (!m) return 0;
  let t = 0, k = 0;
  for (let i = 0; i < la; i++) if (ma[i]) { while (!mb[k]) k++; if (a[i] !== b[k]) t++; k++; }
  const jaro = (m / la + m / lb + (m - t / 2) / m) / 3;
  let p = 0; while (p < 4 && a[p] === b[p]) p++;
  return jaro + p * 0.1 * (1 - jaro);
}
const COMMON = new Set(['have', 'having', 'feel', 'feeling', 'very', 'really', 'since', 'today', 'there', 'their', 'about', 'with', 'what', 'when', 'where', 'this', 'that', 'thing', 'think', 'hello', 'thanks', 'thank', 'please', 'help', 'doctor', 'today', 'morning', 'night', 'yesterday', 'week', 'little', 'more', 'much', 'from', 'here', 'heavy', 'hurts', 'hurt', 'hurting', 'pains', 'sorry', 'okay', 'alright', 'start', 'started', 'still', 'again', 'other', 'right', 'left', 'both', 'body', 'side', 'some', 'like', 'know', 'dont', 'cant', 'cannot', 'also', 'just', 'even', 'well', 'good', 'great', 'fine', 'worse', 'better', 'never', 'always', 'every', 'hours', 'days', 'head', 'chest', 'stomach', 'back', 'neck', 'throat', 'heart', 'eyes', 'legs', 'arms', 'hand', 'hands', 'foot', 'feet', 'knee', 'knees']);
/**
 * A symptom word the patient probably misspelled ("hedache", "diziness", "feaver").
 * Only single words of 4+ letters that matched nothing exactly; the result is an
 * interpretation the patient is asked to confirm, never a fact.
 */
export function misspelledConcept(tokens: string[], covered: Set<number> = new Set()): { id: string; token: string; index: number; score: number }[] {
  const out: { id: string; token: string; index: number; score: number }[] = [];
  const exact = new Set(CONCEPTS.flatMap((c) => c.words).map(norm));
  for (const b of BODY) for (const w of b.words) exact.add(norm(w));
  tokens.forEach((tok, index) => {
    if (covered.has(index) || !/^[a-z']+$/.test(tok) || tok.length < 4 || COMMON.has(tok) || exact.has(tok) || /\d/.test(tok)) return;
    let best: { id: string; token: string; index: number; score: number } | null = null;
    for (const c of CONCEPTS) {
      if (c.id === 'unwell') continue;
      for (const w of CONCEPT_BASE.get(c.id) ?? []) {
        if (w.includes(' ') || w.length < 4 || isArabic(w)) continue;
        const f = norm(w);
        const sc = similarity(tok, f);
        const close = sc >= 0.9 || (sc >= 0.78 && tok.slice(0, 2) === f.slice(0, 2) && Math.min(tok.length, f.length) / Math.max(tok.length, f.length) >= 0.7 && tok.length >= 5);
        if (close && (!best || sc > best.score)) best = { id: c.id, token: tok, index, score: sc };
      }
    }
    if (best) out.push(best);
  });
  return out;
}

/** A body word the patient probably misspelled ("stumach", "sholder"). Interpretation only. */
export function misspelledBody(tokens: string[]): { word: BodyWord; token: string; index: number }[] {
  const out: { word: BodyWord; token: string; index: number }[] = [];
  const exact = new Set(BODY.flatMap((b) => b.words).map(norm));
  tokens.forEach((tok, index) => {
    if (!/^[a-z']+$/.test(tok) || tok.length < 4 || COMMON.has(tok) || exact.has(tok)) return;
    let best: { word: BodyWord; sc: number } | null = null;
    for (const b of BODY) for (const w of BODY_BASE.get(b) ?? []) {
      if (w.includes(' ') || w.length < 4 || isArabic(w)) continue;
      const sc = similarity(tok, norm(w));
      if (sc >= 0.9 && (!best || sc > best.sc)) best = { word: b, sc };
    }
    if (best) out.push({ word: best.word, token: tok, index });
  });
  return out;
}
