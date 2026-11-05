'use strict';
/**
 * shell-run-pty-quote.test.cjs — _ptyQuote must neutralize zsh metacharacters.
 *
 * _ptyRunProcess joins argv into a command line for the user's zsh PTY
 * session. A denylist that misses glob chars lets a bare `?`/`*`/`[` reach
 * the shell — observed: `open https://google.com/search?q=x` →
 * "zsh: no matches found" → step failure + cli.agent recovery burn.
 *
 * Run from command-service dir:
 *   node tests/shell-run-pty-quote.test.cjs
 */
const assert = require('assert');
const { _ptyQuote } = require('../src/skills/shell.run.cjs');

let tests = 0, passed = 0;
function check(name, cond) {
  tests++;
  if (cond) { passed++; console.log(`  PASS: ${name}`); }
  else { console.error(`  FAIL: ${name}`); }
}

console.log('\npty quote tests');

// Bare-safe tokens stay bare (readability of the joined command line).
check('plain flag stays bare', _ptyQuote('-la') === '-la');
check('path stays bare', _ptyQuote('/usr/bin/open') === '/usr/bin/open');
check('relative file stays bare', _ptyQuote('file.txt') === 'file.txt');
check('host:port stays bare', _ptyQuote('127.0.0.1:3007') === '127.0.0.1:3007');

// zsh glob/history metachars are quoted.
check('URL with ? is single-quoted', _ptyQuote('https://www.google.com/search?q=smoothstack%20company') === `'https://www.google.com/search?q=smoothstack%20company'`);
check('glob star quoted', _ptyQuote('*.js').startsWith(`'`));
check('brackets quoted', _ptyQuote('file[0].txt').startsWith(`'`));
check('tilde quoted', _ptyQuote('~/Downloads/x').startsWith(`'`));
check('history bang quoted', _ptyQuote('hello!').startsWith(`'`));
check('leading = (zsh =cmd expansion) quoted', _ptyQuote('=foo').startsWith(`'`));
check('spaces still quoted', _ptyQuote('hello world').startsWith(`'`));
check('empty string becomes empty quotes, not a vanishing arg', _ptyQuote('') === `''`);

// Embedded single quotes are escaped correctly.
check('single quote escaped', _ptyQuote(`it's`) === `'it'\\''s'`);

// Functional check: the quoted URL survives a real zsh parse unchanged.
const { spawnSync } = require('child_process');
const url = 'https://www.google.com/search?q=smoothstack%20company&lang=en';
const r = spawnSync('zsh', ['-c', `printf '%s' ${_ptyQuote(url)}`], { encoding: 'utf8' });
check('zsh round-trips quoted URL verbatim', r.status === 0 && r.stdout === url);

console.log(`\n${passed}/${tests} passed`);
process.exit(passed === tests ? 0 : 1);
