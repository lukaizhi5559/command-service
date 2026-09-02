'use strict';

/**
 * category-config.cjs — Per-category enrichment config for tier selection.
 *
 * The page category provides CONTEXT only, not the tier decision.
 * State patterns determine the tier; categories enrich the LLM prompt with:
 *   - Shortcut vocabulary (what shortcuts exist for this app type)
 *   - Command system (slash commands, prefixes)
 *   - Region vocabulary (title/body/cell/code/canvas)
 *   - Category notes (quirks, escape safety, etc.)
 *   - Common state patterns for this category
 *
 * Unknown apps use 'web_generic' — state patterns still work, just without
 * category-specific enrichment.
 */

// ─── Category configs ──────────────────────────────────────────────────────

const CATEGORY_CONFIGS = {
  // ── Document editors (Notion, Google Docs) ────────────────────────────
  document_editor: {
    regions: ['title', 'body', 'code', 'toggle', 'callout'],
    notes: [
      'Escape exits the current block — do NOT press Escape to dismiss overlays (it loses cursor position)',
      'Slash command (/) opens block insertion menu — use for lists, headings, code blocks',
      'Enter creates a new block; Shift+Enter creates a line break within a block',
      'For typing content (text, todo, list, items, headings) → ALWAYS use Just-type (1), not Tab-Map. Tab-Map clicks elements and loses cursor position in editors.',
    ],
    commonPatterns: ['canvas_editing', 'creation_deep_link', 'form_dialog_open'],
  },

  // ── Email compose (Gmail, Outlook) ─────────────────────────────────────
  email_compose: {
    regions: ['to', 'cc', 'bcc', 'subject', 'body'],
    allowedTiers: [1, 4], // Just-type, Tab-Map only — no Meta+F/Gesture/Arrow-Grid
    notes: [
      'Escape closes the compose window — do NOT press Escape unless you want to discard the email',
      'Tab navigates between To/Subject/Body fields — use Tab-Map for multi-field filling',
      'Ctrl+Enter / Cmd+Enter sends the email — only press when all fields are filled',
    ],
    commonPatterns: ['form_dialog_open', 'multi_step_form'],
  },

  // ── AI chat (ChatGPT, Claude, Gemini) ──────────────────────────────────
  ai_chat: {
    regions: ['input'],
    allowedTiers: [1, 4], // Just-type, Tab-Map only
    notes: [
      'Single input field — type the message and press Enter to send',
      'No multi-field forms — Just-type is almost always correct',
    ],
    commonPatterns: ['single_field_focused'],
  },

  // ── Social feed (Twitter, LinkedIn, Facebook) ──────────────────────────
  social_feed: {
    regions: ['post_compose', 'comment', 'feed'],
    allowedTiers: [1, 4], // Just-type, Tab-Map only — no Meta+F/Shortcuts/Gesture/Arrow-Grid
    notes: [
      'Post compose is usually a single field — Just-type works',
      'Reply/comment boxes may need clicking first before typing',
    ],
    commonPatterns: ['single_field_focused', 'find_and_click_text'],
  },

  // ── Calendar (Google Calendar, Outlook Calendar) ───────────────────────
  calendar: {
    regions: ['title', 'date', 'time', 'guests', 'location', 'description'],
    notes: [
      'Press "c" to create a new event (Google Calendar shortcut)',
      'Event creation form has multiple fields — use Tab-Map for filling',
      'Date/time pickers are mini-calendars — Tab-Map or click to select',
    ],
    commonPatterns: ['shortcut_available', 'form_dialog_open', 'multi_step_form'],
  },

  // ── Spreadsheet (Google Sheets, Airtable) ──────────────────────────────
  spreadsheet: {
    regions: ['cell', 'formula_bar', 'header', 'name_box'],
    notes: [
      'Cells are addressed by coordinates (A1, B2) — use keyboard navigation, NOT Tab-Map clicks (grid is canvas-rendered)',
      'CELL NAVIGATION: Press Cmd+J (Mac) / Ctrl+J (Windows) to focus the Name Box, type the cell address (e.g. A1), press Enter to focus that cell',
      'CELL ENTRY: After focusing a cell, type the value, then press Tab to move to the next cell (right), or Enter to move down',
      'Ctrl+Home / Cmd+Fn+LeftArrow jumps to cell A1 directly',
      'Formula bar shows cell content — type to edit',
      'For entering column headers in row 1: navigate to A1 (Cmd+J → A1 → Enter), type first header, Tab to B1, type second header, Tab to C1, etc.',
    ],
    commonPatterns: ['canvas_editing', 'cell_navigation', 'spatial_interaction'],
    // Structured key sequences available for this category (used by Tier 3 Shortcut Keys)
    categoryKeys: [
      { key: 'Meta+j', desc: 'Focus Name Box — then type cell address (e.g. A1) and press Enter to jump to that cell (Mac)' },
      { key: 'Control+j', desc: 'Focus Name Box — then type cell address and press Enter (Windows)' },
      // Removed: Control+Home — doesn't reliably focus cell A1 in Google Sheets
    ],
  },

  // ── Code editor (GitHub, VS Code Web, Replit) ──────────────────────────
  code_editor: {
    regions: ['code', 'terminal', 'file_tree'],
    notes: [
      'Focus is usually in the code editor — type to insert code',
      'Ctrl+Enter may run/submit code — check appKnowledge for shortcuts',
    ],
    commonPatterns: ['canvas_editing', 'single_field_focused'],
  },

  // ── Design canvas (Figma, Canva — limited DOM support) ─────────────────
  design_canvas: {
    regions: ['canvas', 'panel', 'toolbar'],
    notes: [
      'Main workspace is canvas-rendered — DOM signals may be unreliable',
      'Side panels have DOM controls — Tab-Map works for panels',
      'Drag-drop on canvas needs Gesture tier with pixel coordinates',
    ],
    commonPatterns: ['spatial_interaction', 'no_focus_need_click'],
  },

  // ── Media player (Spotify, YouTube) ────────────────────────────────────
  media_player: {
    regions: ['search', 'player_controls', 'playlist'],
    notes: [
      'Search bar is the main input — Just-type for search',
      'Playback controls are clickable buttons — Tab-Map or Meta+F',
      'Drag-to-reorder playlists needs Gesture tier',
    ],
    commonPatterns: ['single_field_focused', 'find_and_click_text', 'spatial_interaction'],
  },

  // ── Shopping (Amazon, eBay) ────────────────────────────────────────────
  shopping: {
    regions: ['search', 'cart', 'checkout', 'product'],
    notes: [
      'Search bar is usually auto-focused — Just-type for product search',
      'Checkout forms have multiple fields — Tab-Map for filling',
      'Add to cart / Buy buttons — Meta+F or Tab-Map to find and click',
    ],
    commonPatterns: ['single_field_focused', 'form_dialog_open', 'find_and_click_text'],
  },

  // ── Project management (Trello, Asana, Jira) ──────────────────────────
  project_management: {
    regions: ['card', 'board', 'list', 'comment'],
    notes: [
      'Drag cards between columns — Gesture tier',
      'Card creation is usually a single field — Just-type',
      'Card details may have multiple fields — Tab-Map',
    ],
    commonPatterns: ['spatial_interaction', 'single_field_focused', 'form_dialog_open'],
  },

  // ── Messaging (Slack, Discord, Teams) ──────────────────────────────────
  messaging: {
    regions: ['message_input', 'channel', 'thread'],
    notes: [
      'Message input is usually focused — Just-type + Enter to send',
      'Channel navigation — Meta+F to find channel by name',
    ],
    commonPatterns: ['single_field_focused', 'find_and_click_text'],
  },

  // ── CRM/Database (Salesforce, HubSpot) ─────────────────────────────────
  crm_database: {
    regions: ['form', 'list', 'detail', 'search'],
    notes: [
      'Record creation forms have many fields — Tab-Map',
      'Search bar for finding records — Just-type',
      'List views — Tab-Map to navigate and click records',
    ],
    commonPatterns: ['form_dialog_open', 'multi_step_form', 'find_and_click_text'],
  },

  // ── Forms/Survey (Google Forms, Typeform) ──────────────────────────────
  forms_survey: {
    regions: ['question', 'option', 'response'],
    notes: [
      'Forms have multiple fields — Tab-Map for filling',
      'Radio/checkbox options — Tab-Map to select',
    ],
    commonPatterns: ['form_dialog_open', 'multi_step_form'],
  },

  // ── Booking (Calendly, OpenTable) ──────────────────────────────────────
  booking: {
    regions: ['date_picker', 'time_slot', 'form', 'confirm'],
    notes: [
      'Date/time selection — Tab-Map or click',
      'Booking forms — Tab-Map for multiple fields',
    ],
    commonPatterns: ['form_dialog_open', 'find_and_click_text'],
  },

  // ── Cloud storage (Google Drive, Dropbox) ──────────────────────────────
  cloud_storage: {
    regions: ['file_list', 'search', 'upload', 'context_menu'],
    notes: [
      'File search — Just-type in search bar',
      'File navigation — Tab-Map or Meta+F to find files',
      'Upload/create buttons — Meta+F or Tab-Map',
    ],
    commonPatterns: ['single_field_focused', 'find_and_click_text'],
  },

  // ── Admin/Dashboard (analytics, admin panels) ──────────────────────────
  admin_dashboard: {
    regions: ['sidebar', 'content', 'filter', 'search'],
    notes: [
      'Dashboards are read-heavy — list_browse or DONE',
      'Filter/search controls — Just-type or Tab-Map',
      'Settings navigation — Meta+F to find settings links',
    ],
    commonPatterns: ['list_browse', 'find_and_click_text', 'single_field_focused'],
  },

  // ── News/Content (news sites, blogs) ───────────────────────────────────
  news_content: {
    regions: ['article', 'search', 'comment'],
    notes: [
      'Content is for reading — list_browse or DONE',
      'Search for articles — Just-type in search bar',
    ],
    commonPatterns: ['list_browse', 'read_deep_link', 'single_field_focused'],
  },

  // ── Search engine (Google Search, Bing) ────────────────────────────────
  search_engine: {
    regions: ['search_box', 'results'],
    notes: [
      'Search box is auto-focused — Just-type + Enter',
      'Results page — list_browse or Meta+F to find specific results',
    ],
    commonPatterns: ['single_field_focused', 'list_browse', 'search_deep_link_read'],
  },

  // ── Learning/LMS (Canvas, Coursera, Udemy) ─────────────────────────────
  learning_lms: {
    regions: ['course_list', 'module', 'quiz', 'search'],
    notes: [
      'Course navigation — Tab-Map or Meta+F',
      'Quiz forms — Tab-Map for multiple questions',
    ],
    commonPatterns: ['list_browse', 'form_dialog_open', 'find_and_click_text'],
  },

  // ── Web generic (fallback for unknown apps) ────────────────────────────
  web_generic: {
    regions: [],
    notes: [],
    commonPatterns: ['no_focus_need_click', 'form_dialog_open', 'single_field_focused'],
  },
};

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Get the category config for a page category.
 * Falls back to 'web_generic' for unknown/null/empty categories.
 * @param {string} category — page category string
 * @returns {{ regions: string[], notes: string[], commonPatterns: string[], allowedTiers?: number[] }}
 */
function getCategoryConfig(category) {
  if (!category || typeof category !== 'string') {
    return CATEGORY_CONFIGS.web_generic;
  }
  return CATEGORY_CONFIGS[category] || CATEGORY_CONFIGS.web_generic;
}

/**
 * Get the list of all known category names.
 * @returns {string[]}
 */
function getKnownCategories() {
  return Object.keys(CATEGORY_CONFIGS);
}

module.exports = {
  getCategoryConfig,
  getKnownCategories,
  CATEGORY_CONFIGS,
};
