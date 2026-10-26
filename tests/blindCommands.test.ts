import { test } from 'node:test';
import assert from 'node:assert/strict';
import { interpret, bestMatch, isConsequential } from '../src/a11y/commands';

const t = (s: string) => interpret(s);

test('Blind Mode understands navigation and control requests in English', () => {
  assert.deepEqual(t('Open my patient dashboard'), { type: 'go', to: 'home' });
  assert.deepEqual(t('go to my profile'), { type: 'go', to: 'profile' });
  assert.deepEqual(t('Open the settings'), { type: 'go', to: 'settings' });
  assert.equal(t('Read my latest medical report').type, 'read_latest_report');
  assert.equal(t("Open my doctor's latest response").type, 'read_doctor_reply');
  assert.deepEqual(t('Change the language to Arabic'), { type: 'lang', lang: 'ar' });
  assert.equal(t('Tell me what options are available on this screen').type, 'help');
  assert.equal(t('Read this form to me').type, 'read_form');
  assert.equal(t('Help me complete this form').type, 'fill_form');
  assert.equal(t('Help me log in').type, 'fill_form');
  assert.equal(t('Go back').type, 'back');
  assert.equal(t('Repeat what you just said').type, 'repeat');
  assert.equal(t('Stop speaking').type, 'stop');
  assert.equal(t('Speak more slowly').type, 'slower');
  assert.equal(t('Turn off Blind Mode').type, 'exit');
  assert.equal(t('I want to report a new symptom').type, 'new_report');
  assert.equal(t('Explain that again').type, 'explain');
  assert.deepEqual(t('press Copy ID'), { type: 'press', name: 'copy id' });
  assert.deepEqual(t('set email to sara@example.com'), { type: 'fill', field: 'email', value: 'sara@example.com' });
  assert.deepEqual(t('my name is Nour Salem'), { type: 'fill', field: 'name', value: 'Nour Salem' });
});

test('Blind Mode understands Egyptian and Modern Standard Arabic requests', () => {
  assert.deepEqual(t('افتح الإعدادات'), { type: 'go', to: 'settings' });
  assert.deepEqual(t('وديني على البروفايل'), { type: 'go', to: 'profile' });
  assert.deepEqual(t('روح للصفحة الرئيسية'), { type: 'go', to: 'home' });
  assert.equal(t('اقرالي آخر تقرير').type, 'read_latest_report');
  assert.equal(t('الدكتور رد عليا؟').type, 'read_doctor_reply');
  assert.equal(t('ارجع').type, 'back');
  assert.equal(t('كرر').type, 'repeat');
  assert.equal(t('اسكت').type, 'stop');
  assert.equal(t('اتكلم براحة').type, 'slower');
  assert.equal(t('اقفل الوضع الصوتي').type, 'exit');
  assert.deepEqual(t('حول للإنجليزي'), { type: 'lang', lang: 'en' });
  assert.equal(t('ساعدني أملى الفورم').type, 'fill_form');
  assert.equal(t('إيه الاختيارات').type, 'help');
  assert.equal(t('أيوه').type, 'yes');
  assert.equal(t('لأ').type, 'no');
});

test('unknown words are not forced into a command; control names are matched carefully', () => {
  assert.equal(t('the weather is nice').type, 'unknown');
  const items = [{ name: 'Copy ID' }, { name: 'Save ID' }, { name: 'I am a Patient Tell your doctor what you feel' }, { name: 'Log out' }];
  assert.equal(bestMatch('save id', items)!.item.name, 'Save ID');
  assert.ok(bestMatch('i am a patient', items)!.score >= 0.82);
  assert.ok(bestMatch('banana', items)!.score < 0.72);
  assert.ok(isConsequential('Log out') && isConsequential('Approve and send') && isConsequential('Yes, connect to this doctor') && isConsequential('ابعت'));
  assert.ok(!isConsequential('Settings') && !isConsequential('Copy ID'));
});
