import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allKeys } from '../scripts/i18n-keys';
import { translateTo, DICTS, type DictLang } from '../src/i18n/dict';
import { tr, isRtl, LANGS } from '../src/i18n/lang';
import { understand, detectLang, safetyCheck, newRecord, ruleTurn, startConsult } from '../src/services/conversation/Consult';
import { interpret, isConsequential } from '../src/a11y/commands';
import { initialState, step, matchOption, type Ctx, type DialogState, type Input, type Turn } from '../src/services/voice/VoiceDialog';
import { foldText } from '../src/services/langWords';

const L3: DictLang[] = ['fr', 'ur', 'hi'];
const ph = (s: string) => (s.match(/\{[a-z0-9]+\}/gi) ?? []).sort().join();

test('every interface text has a French, Urdu and Hindi version', async () => {
  const keys = await allKeys();
  assert.ok(keys.length > 1500, `found ${keys.length} texts`);
  for (const l of L3) {
    const miss = keys.filter((k) => !translateTo(k.en, l)).map((k) => k.en);
    assert.deepEqual(miss.slice(0, 10), [], `${miss.length} texts missing for ${l}`);
  }
});

test('translations keep every changing part ({name}, {0}) and are not left in English', () => {
  for (const l of L3) for (const [en, v] of Object.entries(DICTS[l])) {
    assert.equal(ph(v), ph(en), `${l}: "${en}" → "${v}"`);
    if (l !== 'fr' && /[a-z]{4}/.test(en.replace(/\{[^}]+\}|AccessCare|Claude|Anthropic|AI|ID|https?:\S+/g, ''))) {
      assert.ok(l === 'ur' ? /[؀-ۿ]/.test(v) : /[ऀ-ॿ]/.test(v), `${l} not translated: "${en}" → "${v}"`);
    }
  }
});

test('translated text fills in names and numbers', () => {
  assert.equal(tr('Sent to {name}. Your doctor will see exactly what you approved.', 'x', 'fr', { name: 'Dr. Layla' }), 'Envoyé à Dr. Layla. Votre médecin verra exactement ce que vous avez approuvé.');
  assert.match(tr('Your doctor is {name}.', 'x', 'ur', { name: 'Dr. Layla' }), /^آپ کے ڈاکٹر Dr\. Layla ہیں۔$/);
  assert.match(tr('Your doctor is {name}.', 'x', 'hi', { name: 'Dr. Layla' }), /^आपके डॉक्टर Dr\. Layla हैं।$/);
  assert.equal(translateTo('Zorblat quexing wibble', 'fr'), null, 'unknown text is never guessed');
  assert.ok(isRtl('ar') && isRtl('ur') && !isRtl('fr') && !isRtl('hi'));
  assert.deepEqual(LANGS.map((x) => x.id), ['en', 'ar', 'fr', 'ur', 'hi']);
});

test('symptoms are understood in French, Urdu and Hindi, including "not" (never assumed)', () => {
  const c = (s: string, l: 'fr' | 'ur' | 'hi') => understand(s, l).concepts.map((x) => x.value + (x.negated ? ' (no)' : ''));
  assert.ok(c("j'ai mal à la tête depuis hier", 'fr').includes('headache'));
  assert.equal(understand("j'ai mal à la tête depuis hier", 'fr').onset?.value, 'days');
  assert.deepEqual(c('J’ai de la fièvre mais pas de nausées', 'fr').sort(), ['fever', 'nausea (no)']);
  assert.equal(understand('la douleur est forte, 7 sur 10', 'fr').number?.value, 7);
  assert.deepEqual(c('سر میں درد ہے', 'ur'), ['headache']);
  assert.deepEqual(c('بخار نہیں ہے', 'ur'), ['fever (no)']);
  assert.equal(understand('10 میں سے 7', 'ur').number?.value, 7);
  assert.deepEqual(c('मुझे बुखार नहीं है', 'hi'), ['fever (no)']);
  assert.deepEqual(c('मेरे सिर में दर्द है', 'hi'), ['headache']);
  assert.equal(understand('कल से पेट में दर्द', 'hi').body[0]?.value, 'abdomen');
  assert.ok(understand('oui', 'fr').yes && understand('ہاں', 'ur').yes && understand('हां', 'hi').yes);
  assert.ok(understand('bonjour', 'fr').greeting && understand('नमस्ते', 'hi').greeting);
  // unanswered or unknown words are not turned into "no"
  assert.deepEqual(c('je ne sais pas', 'fr'), []);
});

test('the language is recognised from what the patient says', () => {
  assert.equal(detectLang("j'ai mal à la tête", 'en'), 'fr');
  assert.equal(detectLang('سر میں درد', 'en'), 'ur');
  assert.equal(detectLang('मुझे बुखार', 'en'), 'hi');
  assert.equal(detectLang('عندي صداع', 'en'), 'ar');
  assert.equal(foldText('बुख़ार'), foldText('बुखार'), 'with or without the nukta dot');
});

test('urgent words are caught in French, Urdu and Hindi', () => {
  const s = (t: string, l: 'fr' | 'ur' | 'hi') => safetyCheck(newRecord(l), t);
  assert.deepEqual(s("je n'arrive pas à respirer", 'fr'), ['difficulty breathing']);
  assert.deepEqual(s('douleur dans la poitrine', 'fr'), ['chest pain or pressure']);
  assert.deepEqual(s('سانس نہیں آ رہی', 'ur'), ['difficulty breathing']);
  assert.deepEqual(s('میں بے ہوش ہو گیا', 'ur'), ['fainting']);
  assert.deepEqual(s('सांस नहीं आ रही', 'hi'), ['difficulty breathing']);
  assert.deepEqual(s('सीने में दर्द', 'hi'), ['chest pain or pressure']);
});

test('Blind Mode commands in French, Urdu and Hindi', () => {
  assert.deepEqual(interpret('ouvre les paramètres'), { type: 'go', to: 'settings' });
  assert.equal(interpret('retour').type, 'back');
  assert.equal(interpret('parle plus lentement').type, 'slower');
  assert.equal(interpret('désactive le mode vocal').type, 'exit');
  assert.equal(interpret('lis mon dernier rapport').type, 'read_latest_report');
  assert.deepEqual(interpret('passe en arabe'), { type: 'lang', lang: 'ar' });
  assert.deepEqual(interpret('ترتیبات کھولو'), { type: 'go', to: 'settings' });
  assert.equal(interpret('واپس').type, 'back');
  assert.equal(interpret('ہاں').type, 'yes');
  assert.deepEqual(interpret('सेटिंग्स खोलो'), { type: 'go', to: 'settings' });
  assert.deepEqual(interpret('उर्दू में बदलो'), { type: 'lang', lang: 'ur' });
  assert.deepEqual(interpret('हिंदी'), { type: 'lang', lang: 'hi' });
  assert.deepEqual(interpret('français'), { type: 'lang', lang: 'fr' });
  assert.equal(interpret('नहीं').type, 'no');
  assert.ok(isConsequential('Envoyer') || isConsequential('Approuver et envoyer'));
});

const CTX: Ctx = { signedIn: true, shared: true, claudeAccount: true, aiSupported: false, aiOn: false, doctorName: 'Dr. Layla Hassan' };
function loop(st: DialogState, inputs: string[]): Turn {
  let turn: Turn = { state: st, say: [], options: [], effects: [], listen: false };
  const settle = (t: Turn): Turn => {
    for (const e of t.effects) {
      if (e.type === 'consult_start') { const c = startConsult(t.state.lang, e.change ? t.state.consult : undefined); return settle(step(t.state, { kind: 'event', name: 'consult_turn', data: { rec: c.rec, say: c.say, options: c.options, review: c.review, urgent: c.urgent } }, CTX)); }
      if (e.type === 'converse') { const c = ruleTurn(t.state.consult!, e.input as Input as never); return settle(step(t.state, { kind: 'event', name: 'consult_turn', data: { rec: c.rec, say: c.say, options: c.options, review: c.review, urgent: c.urgent } }, CTX)); }
    }
    return t;
  };
  for (const i of inputs) turn = settle(step(turn.state, { kind: 'utterance', text: i }, CTX));
  return turn;
}

for (const [l, ins, script] of [
  ['fr', ['nouvelle consultation', "j'ai mal à la tête depuis ce matin", 'progressivement', 'le front'], /[àéèçù]/],
  ['ur', ['نئی مشاورت', 'صبح سے سر میں درد ہے', 'آہستہ آہستہ', 'ماتھا'], /[؀-ۿ]/],
  ['hi', ['नया परामर्श', 'सुबह से सिर में दर्द है', 'धीरे-धीरे', 'माथा'], /[ऀ-ॿ]/],
] as const) {
  test(`a voice consultation in ${l}: questions are asked and answers understood in that language`, () => {
    const t0 = step(initialState(l), { kind: 'start' }, CTX);
    assert.match(t0.say.join(' '), script);
    const t = loop(t0.state, [...ins]);
    assert.equal(t.state.phase, 'consult');
    const said = t.say.join(' ');
    assert.ok(!/\b(the|you|your|and|what|did|it|is|where|how)\b/i.test(said), `English left: ${said}`);
    const c = t.state.consult!.complaints[0];
    assert.equal(c.concept, 'headache');
    assert.equal(c.facts.onset?.value, 'today');
    assert.equal(c.facts.onset_type?.value, 'gradual');
    assert.equal(c.facts.location?.value, 'forehead');
  });
}

test('voice menu words in French, Urdu and Hindi', () => {
  assert.equal(matchOption('mes messages', ['messages', 'new_consult', 'doctor']), 'messages');
  assert.equal(matchOption('میرا ڈاکٹر', ['messages', 'new_consult', 'doctor']), 'doctor');
  assert.equal(matchOption('संदेश', ['messages', 'new_consult', 'doctor']), 'messages');
  assert.equal(matchOption('ourdou', ['set_ur', 'set_hi', 'set_fr']), 'set_ur');
});
