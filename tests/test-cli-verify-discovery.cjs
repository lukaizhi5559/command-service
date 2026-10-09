'use strict';

// Tests for _discoverVerifyCmd — the auth-verification subcommand picker used
// by cli.agent preflight_check. Covers:
//   - cobra-style `Available Commands:` tables (nylas, gh, kubectl shape)
//   - nested auth namespaces: `nylas auth status` via helpParts
//   - legacy {a,b,c} positional enums (gcalcli shape)
//   - local-only subcommands never chosen as auth proof

const { _discoverVerifyCmd } = require('../src/skills/cli.agent.cjs');

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; failures.push(name); console.log(`  ✗ ${name} ${extra}`); }
}

const NYLAS_MAIN_HELP = `Nylas CLI

Usage:
  nylas [command]

Available Commands:
  auth        Manage authentication grants
  email       Work with email messages
  calendar    Work with calendars
  completion  Generate the autocompletion script for the specified shell
  config      Manage CLI configuration
  doctor      Diagnose your local environment
  help        Help about any command
  init        Initialize the Nylas CLI
  version     Print the version

Flags:
  -h, --help   help for nylas

Use "nylas [command] --help" for more information about a command.`;

const NYLAS_AUTH_HELP = `Manage authentication grants

Usage:
  nylas auth [command]

Available Commands:
  add         Add a grant
  detect      Detect provider settings
  list        List grants
  login       Authenticate a grant
  logout      Revoke local tokens
  providers   List providers
  remove      Remove a grant
  revoke      Revoke a grant
  scopes      Manage scopes
  show        Show grant details
  status      Show authentication status
  switch      Switch active grant
  whoami      Show the current authenticated account

Flags:
  -h, --help   help for auth`;

const GCALCLI_HELP = `usage: gcalcli [-h] [--client-id CLIENT_ID] {init,list,search,edit,delete,agenda,calw,month,quick,add,import,remind,config,util} ...

Google Calendar Command Line Interface

positional arguments:
  {init,list,search,edit,delete,agenda,calw,month,quick,add,import,remind,config,util}
    init                initialize authentication
    list                list available calendars
    search              search for events
    edit                edit calendar events
    delete              delete events
    agenda              get an agenda for a time period
    quick               quick-add an event
    add                 add an event
    import              import events
    remind              send reminders
    config              edit config
    util                utility commands`;

(async () => {
  // 1. Nested cobra auth namespace — the nylas case. `<cli> auth --help`
  //    exposes `status`/`whoami`; `auth status` proves auth state.
  const nylasPick = await _discoverVerifyCmd('/fake/nylas', 'nylas', NYLAS_MAIN_HELP, [
    { subcmd: 'auth', output: NYLAS_AUTH_HELP },
  ]);
  check('nylas nested auth namespace → ["auth","status"]',
    Array.isArray(nylasPick) && nylasPick.join(' ') === 'auth status',
    `got ${JSON.stringify(nylasPick)}`);

  // 2. Nested namespace prefers status over list/whoami ordering noise.
  const authOnlyList = `Usage:\n  acct auth [command]\n\nAvailable Commands:\n  list        List accounts\n  login       Log in\n`;
  const acctPick = await _discoverVerifyCmd('/fake/acct', 'acct', 'no commands', [
    { subcmd: 'auth', output: authOnlyList },
  ]);
  check('auth namespace with only list → ["auth","list"]',
    Array.isArray(acctPick) && acctPick.join(' ') === 'auth list',
    `got ${JSON.stringify(acctPick)}`);

  // 3. Flat cobra table — `status` with an API-backed description auto-picks
  //    without LLM classification.
  const flatCobra = `Usage:\n  gh [command]\n\nAvailable Commands:\n  auth        Authenticate gh and git with GitHub\n  browse      Open the repository in the browser\n  issue       Manage issues\n  status      Show your account status\n`;
  const flatPick = await _discoverVerifyCmd('/fake/gh', 'gh', flatCobra, []);
  check('flat cobra `status` (API-backed desc) → ["status"]',
    Array.isArray(flatPick) && flatPick.join(' ') === 'status',
    `got ${JSON.stringify(flatPick)}`);

  // 4. Legacy {a,b,c} enum path still works (gcalcli).
  const gcalPick = await _discoverVerifyCmd('/fake/gcalcli', 'gcalcli', GCALCLI_HELP, []);
  check('brace enum → a verify candidate (list/agenda/status)',
    Array.isArray(gcalPick) && ['list', 'agenda', 'status'].includes(gcalPick[0]),
    `got ${JSON.stringify(gcalPick)}`);

  // 5. Local-only subcommands are never auth proof.
  const localOnly = `Usage:\n  tool [command]\n\nAvailable Commands:\n  config      Manage local config settings\n  version     Print version\n  init        Initialize the tool\n`;
  const localPick = await _discoverVerifyCmd('/fake/tool', 'tool', localOnly, []);
  check('local-only table → null', localPick === null, `got ${JSON.stringify(localPick)}`);

  // 6. Auth namespace with no verify-ish leaf falls through to flat parse.
  const authNoVerify = `Usage:\n  cli auth [command]\n\nAvailable Commands:\n  login       Log in\n  logout      Log out\n`;
  const fallthrough = await _discoverVerifyCmd('/fake/cli', 'cli',
    `Usage:\n  cli [command]\n\nAvailable Commands:\n  auth        Authentication\n  whoami      Show your account\n`,
    [{ subcmd: 'auth', output: authNoVerify }]);
  check('auth ns w/o verify leaf → falls through to flat whoami',
    Array.isArray(fallthrough) && fallthrough.join(' ') === 'whoami',
    `got ${JSON.stringify(fallthrough)}`);

  // 7. Empty help → null, no throw.
  const none = await _discoverVerifyCmd('/fake/x', 'x', '', []);
  check('empty help → null', none === null, `got ${JSON.stringify(none)}`);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) { console.log('failures:', failures.join('; ')); process.exit(1); }
  process.exit(0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
