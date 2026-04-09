'use strict';

/**
 * ui.axClick skill
 *
 * Clicks a UI element in a native desktop app using the OS Accessibility API —
 * no screenshot, no vision model, no coordinate guessing.
 *
 * Strategy (in order):
 *   1. macOS  — osascript System Events: find element by label/role in the target app's AX tree
 *   2. Windows — PowerShell UIAutomation: find element by AutomationId/Name/ControlType
 *   3. Fallback — if AX lookup fails (app not accessible), returns success:false so
 *                 recoverSkill can replan with browser.act or keyboard shortcuts
 *
 * Args:
 *   app        {string}  Required. App name as it appears in the Dock/taskbar.
 *                        e.g. "Slack", "Discord", "Figma", "Xcode", "Windsurf"
 *   label      {string}  Required. Accessibility label / visible text of the element.
 *                        e.g. "New Message", "Send", "File", "Search"
 *   role       {string}  Optional. AX role to narrow the search.
 *                        macOS roles: "button" | "menuItem" | "textField" | "checkBox" |
 *                                     "radioButton" | "popUpButton" | "link" | "staticText" |
 *                                     "group" | "list" | "table" | "window" | "any"
 *                        Default: "any" (searches all roles)
 *   windowIndex {number} Optional. Which window of the app to target (1-based). Default: 1.
 *   button     {string}  Optional. "left" | "right" | "double". Default: "left".
 *   settleMs   {number}  Optional. Wait after click for UI to react. Default: 300.
 *   timeoutMs  {number}  Optional. Max time for AX lookup. Default: 10000.
 *
 * Returns:
 *   { success: true,  app, label, role, method, elapsed }
 *   { success: false, error: string, axError: string }  ← recoverSkill should replan
 */

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const logger = require('../logger.cjs');

const DEFAULT_SETTLE_MS  = 300;
const DEFAULT_TIMEOUT_MS = 10000;

// ---------------------------------------------------------------------------
// Platform detection
// ---------------------------------------------------------------------------

const IS_MAC     = process.platform === 'darwin';
const IS_WINDOWS = process.platform === 'win32';

// ---------------------------------------------------------------------------
// macOS — osascript System Events AX click
// ---------------------------------------------------------------------------

const MAC_ROLE_MAP = {
  button:       'button',
  menuItem:     'menu item',
  textField:    'text field',
  checkBox:     'checkbox',
  radioButton:  'radio button',
  popUpButton:  'pop up button',
  link:         'link',
  staticText:   'static text',
  group:        'group',
  list:         'list',
  table:        'table',
  window:       'window',
  any:          null,
};

/**
 * Build an AppleScript that:
 *  1. Activates the app
 *  2. Searches the AX tree of windowIndex for an element matching label (and optionally role)
 *  3. Clicks it
 *
 * Uses a broad search: tries exact description match first, then partial contains match.
 */
function buildMacAxScript(app, label, role, windowIndex, button) {
  const axRole = MAC_ROLE_MAP[role] || null;
  const winIdx = windowIndex || 1;
  const clickAction = button === 'right' ? 'perform action "AXShowMenu" of' : 'click';

  const clickScript = button === 'double'
    ? `click theElement\n      delay 0.05\n      click theElement`
    : `${clickAction} theElement`;

  // Search block: role-targeted fast path or full flat search via entire contents
  const searchBlock = axRole ? `
      -- Role-targeted search
      set theElement to missing value
      try
        set candidates to every ${axRole} of theWindow
        repeat with el in candidates
          try
            if value of attribute "AXTitle" of el is "${label}" then
              set theElement to el
              exit repeat
            end if
          end try
          try
            if value of attribute "AXDescription" of el is "${label}" then
              set theElement to el
              exit repeat
            end if
          end try
        end repeat
      end try
      if theElement is missing value then
        try
          set candidates to every ${axRole} of theWindow
          repeat with el in candidates
            try
              if value of attribute "AXTitle" of el contains "${label}" then
                set theElement to el
                exit repeat
              end if
            end try
            try
              if value of attribute "AXDescription" of el contains "${label}" then
                set theElement to el
                exit repeat
              end if
            end try
          end repeat
        end try
      end if` : `
      -- Full flat search via entire contents (exact then partial)
      set theElement to missing value
      set allElements to {}
      try
        set allElements to entire contents of theWindow
      end try
      repeat with el in allElements
        try
          if value of attribute "AXTitle" of el is "${label}" then
            set theElement to el
            exit repeat
          end if
        end try
        try
          if value of attribute "AXDescription" of el is "${label}" then
            set theElement to el
            exit repeat
          end if
        end try
        try
          if value of attribute "AXValue" of el is "${label}" then
            set theElement to el
            exit repeat
          end if
        end try
      end repeat
      if theElement is missing value then
        repeat with el in allElements
          try
            if value of attribute "AXTitle" of el contains "${label}" then
              set theElement to el
              exit repeat
            end if
          end try
          try
            if value of attribute "AXDescription" of el contains "${label}" then
              set theElement to el
              exit repeat
            end if
          end try
        end repeat
      end if`;

  return `
tell application "${app}"
  activate
end tell
delay 0.3
tell application "System Events"
  tell process "${app}"
    set frontmost to true
    set theWindow to window ${winIdx}
    set theElement to missing value
    ${searchBlock}
    if theElement is missing value then
      error "Element not found: ${label}"
    end if
    ${clickScript}
  end tell
end tell
`.trim();
}

function runOsascript(script, timeoutMs) {
  return new Promise((resolve, reject) => {
    const tmpFile = path.join(os.tmpdir(), `axclick_${Date.now()}_${Math.random().toString(36).slice(2)}.applescript`);
    try {
      fs.writeFileSync(tmpFile, script, 'utf8');
    } catch (writeErr) {
      return reject(new Error(`Failed to write temp script: ${writeErr.message}`));
    }
    const child = execFile('osascript', [tmpFile], { timeout: timeoutMs }, (err, stdout, stderr) => {
      try { fs.unlinkSync(tmpFile); } catch (_) {}
      if (err) {
        reject(new Error(stderr?.trim() || err.message));
      } else {
        resolve(stdout?.trim() || '');
      }
    });
    child.on('error', (err) => {
      try { fs.unlinkSync(tmpFile); } catch (_) {}
      reject(err);
    });
  });
}

async function axClickMac(app, label, role, windowIndex, button, timeoutMs) {
  const script = buildMacAxScript(app, label, role, windowIndex, button);
  logger.debug('[ui.axClick] macOS AX script', { app, label, role, windowIndex });
  await runOsascript(script, timeoutMs);
  return { method: 'ax_macos_system_events' };
}

// ---------------------------------------------------------------------------
// Windows — PowerShell UIAutomation click
// ---------------------------------------------------------------------------

function buildWindowsPSScript(app, label, role, button) {
  const controlType = role && role !== 'any' ? `ControlType.${role.charAt(0).toUpperCase() + role.slice(1)}` : null;
  const ctFilter = controlType ? `| Where-Object { $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::${role} }` : '';
  const clickMethod = button === 'right' ? 'RightClick' : button === 'double' ? 'DoubleClick' : 'Click';

  return `
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$root = [System.Windows.Automation.AutomationElement]::RootElement
$cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, "${label}")
$el = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
if ($el -eq $null) { Write-Error "Element not found: ${label}"; exit 1 }
$pattern = $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
if ($pattern -ne $null) { $pattern.Invoke() } else { 
  $rect = $el.Current.BoundingRectangle
  $x = [int]($rect.X + $rect.Width / 2)
  $y = [int]($rect.Y + $rect.Height / 2)
  Add-Type -AssemblyName System.Windows.Forms
  [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point($x, $y)
  Start-Sleep -Milliseconds 100
  [System.Windows.Forms.SendKeys]::SendWait(" ")
}
`.trim();
}

function runPowerShell(script, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr?.trim() || err.message));
      } else {
        resolve(stdout?.trim() || '');
      }
    });
    child.on('error', reject);
  });
}

async function axClickWindows(app, label, role, button, timeoutMs) {
  const script = buildWindowsPSScript(app, label, role, button);
  logger.debug('[ui.axClick] Windows UIAutomation script', { app, label, role });
  await runPowerShell(script, timeoutMs);
  return { method: 'ax_windows_uiautomation' };
}

// ---------------------------------------------------------------------------
// Main skill
// ---------------------------------------------------------------------------

async function uiAxClick(args = {}) {
  const { app, label, role = 'any' } = args;
  const windowIndex = parseInt(args.windowIndex ?? 1, 10);
  const button      = args.button || 'left';
  const settleMs    = Math.min(5000, Math.max(0, parseInt(args.settleMs ?? DEFAULT_SETTLE_MS, 10)));
  const timeoutMs   = Math.min(60000, Math.max(3000, parseInt(args.timeoutMs ?? DEFAULT_TIMEOUT_MS, 10)));

  if (!app)   return { success: false, error: 'app is required — name of the target application (e.g. "Slack", "Figma")' };
  if (!label) return { success: false, error: 'label is required — accessibility label or visible text of the element to click' };

  if (!['left', 'right', 'double'].includes(button)) {
    return { success: false, error: `Unknown button "${button}". Must be: left | right | double` };
  }

  logger.info('[ui.axClick] Starting', { app, label, role, windowIndex, button, settleMs, timeoutMs });
  const startTime = Date.now();

  try {
    let result;

    if (IS_MAC) {
      result = await axClickMac(app, label, role, windowIndex, button, timeoutMs);
    } else if (IS_WINDOWS) {
      result = await axClickWindows(app, label, role, button, timeoutMs);
    } else {
      return {
        success: false,
        error: 'ui.axClick is only supported on macOS and Windows. On Linux, use xdotool via shell.run.',
        axError: 'unsupported_platform'
      };
    }

    if (settleMs > 0) {
      await new Promise(r => setTimeout(r, settleMs));
    }

    const elapsed = Date.now() - startTime;
    logger.info('[ui.axClick] Done', { app, label, role, ...result, elapsed });

    return { success: true, app, label, role, button, ...result, elapsed };

  } catch (err) {
    const elapsed = Date.now() - startTime;
    logger.warn('[ui.axClick] AX lookup failed', { app, label, role, error: err.message, elapsed });

    return {
      success: false,
      error: `Accessibility click failed for "${label}" in ${app}: ${err.message}`,
      axError: err.message,
      app,
      label,
      role,
      elapsed
    };
  }
}

module.exports = { uiAxClick };
