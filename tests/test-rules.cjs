'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinkdrop-rules-test-'));
const rulesPath = path.join(tmpDir, 'rules.json');
process.env.THINKDROP_RULES_PATH = rulesPath;

const rules = require('../src/skill-helpers/rules.cjs');

function readDocument() {
  return JSON.parse(fs.readFileSync(rulesPath, 'utf8'));
}

function check(label, condition) {
  assert.ok(condition, label);
  console.log(`  PASS: ${label}`);
}

try {
  fs.writeFileSync(rulesPath, JSON.stringify({
    passphrase: { salt: 'private-salt', hash: 'private-hash' },
    rules: [
      {
        id: 'enabled-rule',
        enabled: true,
        seam: 'observation',
        when: { hostMatch: 'example.com' },
        then: { action: 'notify', msg: 'hello' },
        source: 'user',
        fireOnce: false,
        cooldownMs: 120000,
        lastFiredAt: 123,
        firedAt: null,
      },
      {
        id: 'disabled-rule',
        enabled: false,
        seam: 'entry',
        when: { promptMatch: 'delete' },
        then: { action: 'block' },
        source: 'system',
        fireOnce: true,
        cooldownMs: null,
        lastFiredAt: 456,
        firedAt: 789,
      },
    ],
  }, null, 2));

  const listed = rules.listRules();
  check('listRules includes enabled and disabled rules', listed.length === 2);
  check('listRules includes condition and action metadata',
    listed[0].when.hostMatch === 'example.com' && listed[0].then.action === 'notify');
  check('listRules includes management metadata',
    listed[0].source === 'user' &&
    listed[0].fireOnce === false &&
    listed[0].cooldownMs === 120000 &&
    listed[0].lastFiredAt === 123);
  check('listRules excludes passphrase material',
    !Object.prototype.hasOwnProperty.call(listed[0], 'passphrase') &&
    !JSON.stringify(listed).includes('private-salt') &&
    !JSON.stringify(listed).includes('private-hash'));

  check('setRuleEnabled persists the disabled state',
    rules.setRuleEnabled('enabled-rule', false).ok === true &&
    readDocument().rules.find(r => r.id === 'enabled-rule').enabled === false);
  check('setRuleEnabled persists the enabled state',
    rules.setRuleEnabled('enabled-rule', true).ok === true &&
    readDocument().rules.find(r => r.id === 'enabled-rule').enabled === true);
  check('removeRule persists deletion',
    rules.removeRule('disabled-rule').ok === true &&
    !readDocument().rules.some(r => r.id === 'disabled-rule'));

  rules.addRule({
    id: 'second-rule',
    when: { hostMatch: 'example.org' },
    then: { action: 'notify' },
  });
  const passphraseBeforeClear = readDocument().passphrase;
  const cleared = rules.clearRules();
  check('clearRules removes all rules and reports the count',
    cleared.ok === true && cleared.removed === 2 && readDocument().rules.length === 0);
  check('clearRules preserves passphrase material',
    JSON.stringify(readDocument().passphrase) === JSON.stringify(passphraseBeforeClear));
  check('clearRules is safe when already empty',
    rules.clearRules().ok === true && rules.clearRules().removed === 0);

  console.log('\nRules storage tests passed');
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
