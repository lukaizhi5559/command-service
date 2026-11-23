'use strict';
// ── Scene graph: persistent spatial tree over UI elements ───────────────────
// Replaces the flat element-bag model with app → domain → region → container
// → element hierarchy. The walk keeps a cursor (where am I), a trail (how I
// got here), and a signatured view history (views I've seen). Backends: DOM
// ancestors (exact), OCR geometry clustering (approximate). Decision code only
// ever consumes the tree + element annotations — never backend specifics.

const CONTAINER_DEST_NOUNS = /(playlist|folder|album|collection|board|project|channel|chat|workspace|library|list|drive|calendar)/i;
const ENTITY_NOUNS = /(songs?|episodes?|tracks?|items?|files?|media|results?|photos?|videos?|messages?|emails?|posts?)/i;

// ── Node + tree builders ────────────────────────────────────────────────────

let _nid = 0;
function mkNode(kind, label, rect, extra = {}) {
  return { id: `n${++_nid}`, kind, label: String(label || '').slice(0, 80), rect: rect || null,
    role: extra.role || null, state: extra.state || {}, scope: extra.scope || null,
    keys: extra.keys || '', focused: !!extra.focused, children: [], _el: extra.el || null };
}

// Field scope inference — WHAT does this input accept. A searchbox inside an
// "Add to playlist" menu labeled "Find a playlist" filters destinations, not
// entities. Scope is derived from own label/placeholder + ancestor labels.
function deriveScope(el) {
  const own = `${el.label || ''} ${el.placeholder || ''}`.toLowerCase();
  const ancLabels = (el.ancestors || []).map(a => String(a.label || '')).join(' ').toLowerCase();
  const inOverlay = (el.ancestors || []).some(a => /^(menu|dialog|listbox|popover|form)$/i.test(a.role || ''));
  const hay = `${own} ${ancLabels}`;
  if (/\bfind a|choose a|select a|browse|pick a\b/.test(own) && CONTAINER_DEST_NOUNS.test(hay))
    return 'pick:destination';
  if (CONTAINER_DEST_NOUNS.test(own) && inOverlay && /find|search|choose|filter|jump/i.test(own))
    return 'pick:destination';
  if (ENTITY_NOUNS.test(own)) return 'search:entity';
  // Interrogative search placeholders — "What do you want to play?",
  // "Where to?", "Jump to…" — catalog-wide queries with no literal
  // 'search'/'find' word. Global when top-level; entity when task-scoped.
  if (/what do you want|what would you like|where (?:do you want|to)\b|jump to|quick find|start typing/i.test(own))
    return inOverlay ? 'search:entity' : 'global';
  if (/search|find|look for|query/i.test(own)) {
    // A search field inside a task container (menu/dialog/add-panel) is scoped
    // to that task → entity search. Top-level nav/header search is global.
    return (inOverlay || /dialog|overlay/.test(String(el.region || ''))) ? 'search:entity' : 'global';
  }
  return null;
}

// DOM backend — elements carry `ancestors` (nearest-first), `region`, `state`.
// Group elements under their nearest ancestor; ancestors nest in chain order.
function buildDomTree(elements, { app = 'app', domain = 'unknown' } = {}) {
  _nid = 0;
  const root = mkNode('app', app);
  const dom = mkNode('domain', domain);
  root.children.push(dom);
  const regionNodes = new Map();   // region kind → node
  const containerNodes = new Map(); // role|label|rect-bucket → node
  const flat = [];

  for (const e of elements) {
    flat.push(e);
    const regionKind = e.region || 'main';
    if (!regionNodes.has(regionKind)) {
      const rn = mkNode('region', regionKind, null, { role: regionKind });
      rn.parent = dom;
      regionNodes.set(regionKind, rn);
      dom.children.push(rn);
    }
    const regionNode = regionNodes.get(regionKind);

    // Place element under its nearest ancestor chain; deeper ancestors nest.
    let parent = regionNode;
    const anc = [...(e.ancestors || [])].reverse(); // farthest → nearest
    for (const a of anc) {
      if (!a.label && !a.role) continue;
      const key = `${a.role}|${a.label}|${a.rect ? Math.round(a.rect.x / 64) + ',' + Math.round(a.rect.y / 64) : ''}`;
      if (!containerNodes.has(key)) {
        containerNodes.set(key, mkNode('container', a.label || a.role, a.rect, {
          role: a.role, state: { expanded: a.expanded } }));
      }
      const cn = containerNodes.get(key);
      // First-claim parenting — a keyed container seen in another element's
      // chain stays put (no reparenting, no duplicate subtree).
      if (!cn.parent) { cn.parent = parent; parent.children.push(cn); }
      parent = cn;
    }
    const enode = mkNode('element', e.label, e.bbox || (e.rect ? [e.rect.x, e.rect.y, e.rect.width, e.rect.height] : null), {
      role: e._role || e.role, state: e.state || {}, scope: e.type === 'text' ? deriveScope(e) : null,
      keys: e.keys, focused: e.state && e.state.focused, el: e });
    enode.parent = parent;
    parent.children.push(enode);
    e._node = enode;
  }
  // Region rect = member bbox union (DOM regions are semantic, not bands).
  for (const rn of regionNodes.values()) {
    let u = null;
    const walk = n => {
      if (n.rect) {
        u = u ? [Math.min(u[0], n.rect[0]), Math.min(u[1], n.rect[1]),
          Math.max(u[0] + u[2], n.rect[0] + n.rect[2]) - Math.min(u[0], n.rect[0]),
          Math.max(u[1] + u[3], n.rect[1] + n.rect[3]) - Math.min(u[1], n.rect[1])]
          : [...n.rect];
      }
      n.children.forEach(walk);
    };
    rn.children.forEach(walk);
    if (u) rn.rect = u;
  }
  return { tree: root, flat };
}

// OCR backend (stage-1 thin): band clustering — header/footer/left/right/main
// regions; a detected dialog becomes an overlay container. Element annotations
// are weaker but the interface holds for native apps.
function buildOcrTree(elements, { app = 'app', domain = 'native', dlg = null, size = [1440, 900] } = {}) {
  _nid = 0;
  const root = mkNode('app', app);
  const dom = mkNode('domain', domain);
  root.children.push(dom);
  const [W, H] = size;
  const regions = new Map();
  const regionFor = e => {
    const c = e.center || [0, 0];
    if (dlg && c[0] >= dlg.rect[0] && c[0] <= dlg.rect[0] + dlg.rect[2]
        && c[1] >= dlg.rect[1] && c[1] <= dlg.rect[1] + dlg.rect[3]) return 'dialog';
    if (c[1] < 110) return 'header';
    if (c[1] > H - 110) return 'footer';
    if (c[0] < W * 0.22) return 'sidebar-left';
    if (c[0] > W * 0.72) return 'sidebar-right';
    return 'main';
  };
  // Band rects — the same bounds regionFor classifies by, kept on the node
  // so serializers/probes can show and re-parse region boundaries.
  const bandRect = rk => {
    if (rk === 'dialog') return dlg?.rect || null;
    if (rk === 'header') return [0, 0, W, 110];
    if (rk === 'footer') return [0, H - 110, W, 110];
    if (rk === 'sidebar-left') return [0, 110, Math.round(W * 0.22), H - 220];
    if (rk === 'sidebar-right') return [Math.round(W * 0.72), 110, W - Math.round(W * 0.72), H - 220];
    return [Math.round(W * 0.22), 110, Math.round(W * 0.5), H - 220];
  };
  const regionEls = new Map();
  for (const e of elements) {
    const rk = regionFor(e);
    if (!regions.has(rk)) regions.set(rk, mkNode('region', rk === 'dialog' && dlg?.title ? dlg.title : rk, bandRect(rk), { role: rk }));
    if (!regionEls.has(rk)) regionEls.set(rk, []);
    regionEls.get(rk).push(e);
  }
  // Cluster each region's elements into `container` nodes — an OCR parse has
  // no ancestor tree, so list-ness is inferred geometrically: elements sharing
  // an x-band and flowing downward at a roughly regular pitch are members of
  // the same stack (a playlist column, a toolbar row, a card grid). A
  // container's rect is the member union; work lanes traverse it as the unit
  // of membership instead of re-deriving band heuristics per element.
  for (const [rk, rEls] of regionEls) {
    const rn = regions.get(rk);
    const sorted = rEls.filter(e => e.center).sort((a, b) => a.center[1] - b.center[1] || a.center[0] - b.center[0]);
    const hs = sorted.map(e => e.bbox ? e.bbox[3] : 20).filter(h => h > 0).sort((a, b) => a - b);
    const medH = hs.length ? hs[Math.floor(hs.length / 2)] : 24;
    // Two-pass clustering — x-column first, y-gap second. A merged AX+OCR set
    // interleaves debris between rows at different x; y-sort-first splits the
    // row stack on every stray label, but column-first keeps stack members
    // together (a row's own multi-line labels share its x).
    const colTol = Math.max(80, medH * 3);
    const cols = [];
    for (const e of [...sorted].sort((a, b) => a.center[0] - b.center[0])) {
      const last = cols[cols.length - 1];
      if (last && e.center[0] - last._mx <= colTol) {
        last.push(e); last._mx = (last._mx * (last.length - 1) + e.center[0]) / last.length;
      } else { const c = [e]; c._mx = e.center[0]; cols.push(c); }
    }
    for (const col of cols) {
      col.sort((a, b) => a.center[1] - b.center[1]);
      const chs = col.map(e => e.bbox ? e.bbox[3] : medH).filter(h => h > 0).sort((a, b) => a - b);
      const cmH = chs.length ? chs[Math.floor(chs.length / 2)] : medH;
      const gapMax = Math.max(cmH * 3.5, 140);
      let cur = null;
      for (const e of col) {
        const cy = e.center[1];
        const fits = cur && cy - cur._lastY <= gapMax;
        if (!fits) {
          cur = mkNode('container', `${rk}-stack`, null, { role: rk });
          cur.parent = rn; rn.children.push(cur);
          cur._lastY = cy; cur._els = [];
        } else cur._lastY = cy;
        cur._els.push(e);
        const enode = mkNode('element', e.label, e.bbox, { role: e._role, el: e });
        enode.parent = cur; cur.children.push(enode); e._node = enode;
      }
    }
    for (const c of rn.children) {
      if (c.kind !== 'container' || !c._els?.length) continue;
      const xs = c._els.map(e => e.bbox ? e.bbox[0] : e.center[0]);
      const ys = c._els.map(e => e.bbox ? e.bbox[1] : e.center[1]);
      const rs = c._els.map(e => e.bbox ? e.bbox[0] + e.bbox[2] : e.center[0]);
      const bs = c._els.map(e => e.bbox ? e.bbox[1] + e.bbox[3] : e.center[1]);
      c.rect = [Math.min(...xs), Math.min(...ys), Math.max(...rs) - Math.min(...xs), Math.max(...bs) - Math.min(...ys)];
      c.label = `${rk}-stack×${c._els.length}`;
      delete c._els; delete c._mx; delete c._lastY;
    }
  }
  for (const rn of regions.values()) dom.children.push(rn);
  return { tree: root, flat: elements };
}

// Element children of a node in spatial order (top→bottom, left→right).
function childrenIn(node) {
  const out = [];
  (function walk(n) {
    for (const c of n.children || []) {
      if (c.kind === 'element' && c._el) out.push(c._el);
      else walk(c);
    }
  })(node);
  return out.sort((a, b) => (a.bbox?.[1] ?? 0) - (b.bbox?.[1] ?? 0) || (a.bbox?.[0] ?? 0) - (b.bbox?.[0] ?? 0));
}

// Container node holding the MOST pred-matching descendant elements — the
// work list is the container densest in the entity being preserved (a sidebar
// of four "Quiet Hour" rows beats a stray main-content chip or a now-playing
// bar with the same words). Ties prefer a rect-bearing container, then the
// leftmost (work lists are usually rail-first). Rect-less winners get a
// member-union rect so callers always have a surface boundary.
function findContainerWith(node, pred) {
  let best = null, bestN = 0;
  (function walk(n) {
    for (const c of n.children || []) walk(c);
    if (n.kind === 'container') {
      const hits = (n.children || []).filter(c => c.kind === 'element' && c._el && pred(c._el) && c._el.center);
      // Row-stack score — matching members must share an x-column (±80px
      // cluster). A footer/media bar can hold three "Quiet Hour" labels
      // (title/artist/time) scattered across the bar; a real work list
      // holds them as rows at one x. Largest aligned cluster wins.
      const xs = hits.map(c => c._el.center[0]).sort((a, b) => a - b);
      let m = 0, run = 0;
      for (let i = 0; i < xs.length; i++) {
        run = i && xs[i] - xs[i - 1] <= 80 ? run + 1 : 1;
        if (run > m) m = run;
      }
      const better = m > bestN
        || (m === bestN && m > 0 && best && !best.rect && n.rect)
        || (m === bestN && m > 0 && best && n.rect && best.rect && n.rect[0] < best.rect[0]);
      if (better) { best = n; bestN = m; }
    }
  })(node);
  if (best && !best.rect) {
    const mem = childrenIn(best).filter(e => e.center || e.bbox);
    if (mem.length) {
      const xs = mem.map(e => e.bbox ? e.bbox[0] : e.center[0]);
      const ys = mem.map(e => e.bbox ? e.bbox[1] : e.center[1]);
      const rs = mem.map(e => e.bbox ? e.bbox[0] + e.bbox[2] : e.center[0]);
      const bs = mem.map(e => e.bbox ? e.bbox[1] + e.bbox[3] : e.center[1]);
      best.rect = [Math.min(...xs), Math.min(...ys), Math.max(...rs) - Math.min(...xs), Math.max(...bs) - Math.min(...ys)];
    }
  }
  return best;
}

// ── Element annotation (flat elements carry tree-derived metadata) ──────────
// Keeps the existing walk working on flat elements while every element now
// knows its container, scope, menu membership, keys, and focus.
function annotateElements(elements, backend = 'dom') {
  for (const e of elements) {
    if (backend === 'dom') {
      const anc = e.ancestors || [];
      const nearest = anc[0] || null;
      e._container = nearest ? (nearest.label || nearest.role) : null;
      e._containerRole = nearest ? nearest.role : null;
      e._containerPath = anc.map(a => a.label || a.role).filter(Boolean).slice(0, 3).join(' ▸ ');
      e._inOpenMenu = anc.some(a => /^(menu|dialog|listbox|popover)$/i.test(a.role || '') && a.expanded !== false);
      // Scope derives for every element type — it's a label classifier, and
      // callers gate typing on roleAllowsType anyway. Gating it to
      // type==='text' left search fields that arrive as icon/button
      // composites (YOLO-merged) unscoped → never type targets → probed as
      // clicks → the 30s hover ping-pong.
      e._scope = deriveScope(e);
      e._keys = e.keys || '';
      e._focused = !!(e.state && e.state.focused);
    } else {
      e._container = e._node && e._node.parent ? e._node.parent.label : null;
      e._containerRole = e._node && e._node.parent ? e._node.parent.role : null;
      e._inOpenMenu = e._containerRole === 'dialog';
      // OCR elements carry no ancestors — deriveScope still resolves
      // own-label patterns ("what do you want to play?") so the acquire
      // gate works on the OCR backend too.
      e._scope = deriveScope(e);
    }
  }
  return elements;
}

// ── Signatures + scene state ────────────────────────────────────────────────

function viewSig(tree, domain) {
  const labels = [];
  const walk = n => { if (n.kind === 'container' || n.kind === 'region') labels.push(n.label || n.role || ''); n.children.forEach(walk); };
  walk(tree);
  return `${domain}|${labels.sort().join(',').slice(0, 200)}`;
}

function initScene(domain) {
  return { tree: null, cursor: null, domain, trail: [], views: new Map(), sig: null,
           layers: new Map() };
}

// ── Overlay-layer lifecycle ────────────────────────────────────────────────
// Transient layers (menus, dialogs, popovers) are first-class scene objects:
// they open, persist, and must close or be dismissed. Each observe calls
// observeLayers with the parse's popup windows (CGWindowList ground truth)
// plus any scene-tree overlays (dialog-region nodes). A layer is keyed by
// kind+rect-bucket; it gets openedIter/lastSeenIter stamps and emits
// layer-open/layer-close transitions for the lane's policies:
//   foreign overlay persisting → dismiss (Escape)
//   lane-owned overlay        → its contents are the active candidate set
function observeLayers(scene, { popups = [], dlg = null, iter = 0 } = {}) {
  const events = [];
  const seen = new Set();
  const key = (kind, rect) => `${kind}:${rect ? rect.map(v => Math.round(v / 24)).join(',') : '?'}`;
  const touch = (kind, rect, src) => {
    const k = key(kind, rect);
    seen.add(k);
    const l = scene.layers.get(k);
    if (l) { l.lastSeenIter = iter; l.rect = rect || l.rect; }
    else {
      scene.layers.set(k, { kind, rect, src, openedIter: iter, lastSeenIter: iter, owner: null });
      events.push({ type: 'layer-open', kind, rect, src });
    }
  };
  for (const p of popups) touch('menu', p.rect, 'window');
  if (dlg?.rect) touch('dialog', dlg.rect, 'tree');
  for (const [k, l] of scene.layers) {
    if (!seen.has(k)) {
      scene.layers.delete(k);
      events.push({ type: 'layer-close', kind: l.kind, rect: l.rect,
                    persistIters: iter - l.openedIter });
    }
  }
  return events;
}

// Called on every observe. Domain change → store old view, re-anchor at root.
function observeScene(scene, tree, domain) {
  const prevDomain = scene.domain;
  scene.tree = tree;
  if (domain && domain !== prevDomain) {
    if (scene.sig && scene.tree) scene.views.set(scene.sig, { tree: scene.tree, domain: prevDomain, ts: Date.now() });
    scene.trail.push({ edge: 'domain-jump', from: prevDomain, to: domain, ts: Date.now() });
    scene.domain = domain;
    scene.cursor = tree.children[0] || tree; // domain node = re-anchor
    scene.sig = viewSig(tree, domain);
    return { domainJump: true, from: prevDomain, to: domain };
  }
  scene.cursor = scene.cursor || tree.children[0] || tree;
  scene.sig = viewSig(tree, domain || prevDomain);
  return { domainJump: false };
}

function trailPush(scene, { edge, action, label, nodeId }) {
  scene.trail.push({ edge, action, label: String(label || '').slice(0, 60), nodeId,
    domain: scene.domain, sig: scene.sig, ts: Date.now() });
  if (scene.trail.length > 60) scene.trail.shift();
}

// backOut: domain changed since last step → re-anchor at root (re-feed top
// view). Same domain → pop the last edge, cursor climbs to parent node.
function backOut(scene) {
  const last = [...scene.trail].reverse().find(t => t.edge !== 'domain-jump');
  if (last && last.domain !== scene.domain) {
    scene.cursor = scene.tree ? (scene.tree.children[0] || scene.tree) : null;
    return { kind: 'anchor', note: `domain changed ${last.domain} → ${scene.domain} — re-feeding top view` };
  }
  if (last) {
    const node = scene.tree && findNode(scene.tree, n => n.id === last.nodeId);
    scene.cursor = (node && node.parent) || (scene.tree && scene.tree.children[0]) || scene.tree;
    const idx = scene.trail.lastIndexOf(last);
    if (idx >= 0) scene.trail.splice(idx, 1);
    return { kind: 'edge-pop', to: scene.cursor ? scene.cursor.label : 'root' };
  }
  scene.cursor = scene.tree ? (scene.tree.children[0] || scene.tree) : null;
  return { kind: 'anchor', note: 'no trail — re-anchored at domain' };
}

function findNode(node, pred) {
  if (pred(node)) return node;
  for (const c of node.children) { const r = findNode(c, pred); if (r) return r; }
  return null;
}

// Does el (flat element) live inside node subtree? Ancestry when linked,
// else rect containment.
function subtreeContains(node, el) {
  if (el._node) { let n = el._node; while (n) { if (n === node) return true; n = n.parent; } return false; }
  if (!node.rect || !el.center) return false;
  return el.center[0] >= node.rect[0] && el.center[0] <= node.rect[0] + node.rect[2]
    && el.center[1] >= node.rect[1] && el.center[1] <= node.rect[1] + node.rect[3];
}

// ── Serialization — the model-facing spatial layout ─────────────────────────

function serialize(tree, { maxLines = 44, cursor = null } = {}) {
  const lines = [];
  const walk = (n, depth, prefix) => {
    if (lines.length >= maxLines) return;
    const meta = [n.role, n.scope ? `scope:${n.scope}` : '', n.state && n.state.focused ? 'FOCUSED' : '',
      n.keys ? `keys:${n.keys}` : '', n === cursor ? '◄ you-are-here' : ''].filter(Boolean).join(' ');
    lines.push(`${prefix}${depth ? '├ ' : ''}${n.kind} "${n.label}"${meta ? '  ' + meta : ''}`);
    for (const c of n.children) walk(c, depth + 1, prefix + (depth ? '│  ' : '  '));
  };
  walk(tree, 0, '');
  return lines.join('\n');
}

// ── Boundary-map serialization — the probe view's coarse layout ─────────────
// One line per region: rect, element count, first-N non-empty labels. This is
// scene-0's view — regions are the navigable units; elements only appear when
// the caller drills a level.
function serializeRegions(tree, { samplesPerRegion = 4, url = null, cursor = null, changed = [] } = {}) {
  const lines = [`app "${tree.label || 'app'}"${url ? `   url "${String(url).slice(0, 80)}"` : ''}`];
  const dom = (tree.children || []).find(n => n.kind === 'domain') || tree;
  for (const rn of dom.children || []) {
    if (rn.kind !== 'region') continue;
    const els = [];
    const walk = n => { if (n.kind === 'element') els.push(n); n.children.forEach(walk); };
    walk(rn);
    const samples = els.map(e => String(e.label || '').trim()).filter(Boolean)
      .slice(0, samplesPerRegion).map(s => s.slice(0, 24));
    const rect = rn.rect ? `@(${rn.rect.map(v => Math.round(v)).join(',')})` : '';
    const flags = `${rn === cursor ? ' ◄ you-are-here' : ''}${changed.includes(rn.label) ? ' ◄ changed' : ''}`;
    lines.push(`├ region "${rn.label}" ${rect} ${els.length} els${samples.length ? ' — ' + samples.join(' · ') : ''}${flags}`);
  }
  return lines.join('\n');
}

// ── Active-surface resolution ──────────────────────────────────────────────
// The surface the decision model may see, this scene: the newest transient
// bounded rect (dialog | menu | native popup | fresh-diff cluster), else null
// → the caller falls back to the goal container. Detection is geometry+diff —
// a popup announces itself as a tight cluster of elements absent last scene.
function surfaceRect({ els = [], dlg = null, menuRect = null, layers = null, winW = 1440, winH = 900, prevFp = null, fp = null, armPt = null, exclude = null } = {}) {
  // A surface is a BOUNDED popup — anything covering >55% of the window is
  // the page (or a garbage rect), never a transient surface.
  const _bounded = r => r && r[2] * r[3] <= winW * winH * 0.55;
  // Arm-anchored cluster FIRST — while a lane arm is open, the surface that
  // matters is the menu that just popped at the click point. A persistent
  // misdetected panel must not shadow it. Merged OCR blobs (several menu
  // rows fused into one tall element) decompose via their rows[] sub-boxes —
  // the menu lives at sub-row pitch (~28px), not element pitch.
  if (armPt) {
    const near = [];
    for (const e of els) {
      if (!e.center || !e.bbox) continue;
      if (String(e.label || '').trim().length <= 1) continue;
      const subs = (e.rows || []).filter(r => r && r.bbox && r.bbox[3] > 6);
      const pts = subs.length >= 2
        ? subs.map(r => ({ b: r.bbox, cy: r.bbox[1] + r.bbox[3] / 2, t: r.text }))
        : [{ b: e.bbox, cy: e.center[1], t: e.label }];
      for (const p of pts) {
        if (p.b[3] > 96) continue;
        // Exclude at SUB-BOX level, not element level — the armed row's
        // merged blob routinely fuses the menu's TOP items into the row
        // element; skipping the whole element hides Delete under it.
        if (exclude && p.t && exclude.has({ label: p.t })) continue;
        if (Math.abs(p.b[0] + p.b[2] / 2 - armPt[0]) > 300) continue;
        if (p.cy < armPt[1] - 360 || p.cy > armPt[1] + 560) continue;
        near.push(p);
      }
    }
    near.sort((a, b) => a.cy - b.cy);
    let best = [], run = [];
    for (const p of near) {
      if (run.length && p.cy - run[run.length - 1].cy > 90) {
        if (run.length > best.length) best = run; run = [];
      }
      run.push(p);
    }
    if (run.length > best.length) best = run;
    if (best.length >= 4) {
      const x0 = Math.min(...best.map(p => p.b[0])), y0 = Math.min(...best.map(p => p.b[1]));
      const x1 = Math.max(...best.map(p => p.b[0] + p.b[2])), y1 = Math.max(...best.map(p => p.b[1] + p.b[3]));
      const w = x1 - x0, h = y1 - y0;
      if (w <= 660 && h <= 800 && w * h <= winW * winH * 0.55)
        return { rect: [x0 - 12, y0 - 12, w + 24, h + 24], kind: 'menu' };
    }
  }
  if (dlg?.rect && _bounded(dlg.rect)) return { rect: dlg.rect, kind: 'dialog' };
  if (menuRect && _bounded(menuRect)) return { rect: menuRect, kind: 'menu' };
  if (layers) {
    // Newest native popup (CGWindowList layer-101) wins among open layers.
    let newest = null;
    for (const [, l] of layers)
      if (l.rect && _bounded(l.rect) && (!newest || l.lastSeenIter > newest.lastSeenIter)) newest = l;
    if (newest) return { rect: newest.rect, kind: `native-${newest.kind || 'menu'}` };
  }
  // Persistent menu cluster — a popup open since scene 0 is never "fresh",
  // but it IS a surface. Menu-flagged elements (menuitem/option roles,
  // _inOpenMenu, menu/listbox container) in a contiguous y-run bound it.
  {
    const flagged = els.filter(e => e.center && e.bbox && e.bbox[3] <= 60
      && String(e.label || '').trim().length > 1
      && !(exclude && exclude.has(e))
      && (e._inOpenMenu
        || /menuitem|option/.test(String(e._role || e.role || e.type || ''))
        || /menu|listbox|popover/.test(String(e._containerRole || ''))))
      .sort((a, b) => a.center[1] - b.center[1]);
    let best = [], run = [];
    for (const e of flagged) {
      if (run.length && e.center[1] - run[run.length - 1].center[1] > 80) {
        if (run.length > best.length) best = run; run = [];
      }
      run.push(e);
    }
    if (run.length > best.length) best = run;
    if (best.length >= 4) {
      const x0 = Math.min(...best.map(e => e.bbox[0])), y0 = Math.min(...best.map(e => e.bbox[1]));
      const x1 = Math.max(...best.map(e => e.bbox[0] + e.bbox[2])), y1 = Math.max(...best.map(e => e.bbox[1] + e.bbox[3]));
      const w = x1 - x0, h = y1 - y0;
      if (w <= 660 && h <= 800 && w * h <= winW * winH * 0.55)
        return { rect: [x0 - 12, y0 - 12, w + 24, h + 24], kind: 'menu' };
    }
  }
  // Fresh-diff cluster — a popup is N fresh items in a tight, thin-pitch
  // rect. Fresh = absent vs the PREVIOUS scene (prevFp), not cumulative-ever-
  // seen: a second identical menu must still read as a new surface.
  const fresh = els.filter(e =>
      (prevFp && fp ? !prevFp.has(fp(e)) : e._isNew) && e.center && e.bbox)
    .sort((a, b) => a.center[1] - b.center[1]);
  if (fresh.length < 4) return null;
  let best = [], run = [fresh[0]];
  for (let i = 1; i < fresh.length; i++) {
    const gap = fresh[i].center[1] - fresh[i - 1].center[1];
    if (gap > 0 && gap <= 72) run.push(fresh[i]);
    else { if (run.length > best.length) best = run; run = [fresh[i]]; }
  }
  if (run.length > best.length) best = run;
  if (best.length < 4) return null;
  // Menu-shaped: thin median item height (rows are ~55+, menu items ~24-32),
  // popup-sized rect, popup density.
  const hs = best.map(e => e.bbox[3]).sort((a, b) => a - b);
  const medH = hs[Math.floor(hs.length / 2)];
  const x0 = Math.min(...best.map(e => e.bbox[0])), y0 = Math.min(...best.map(e => e.bbox[1]));
  const x1 = Math.max(...best.map(e => e.bbox[0] + e.bbox[2])), y1 = Math.max(...best.map(e => e.bbox[1] + e.bbox[3]));
  const w = x1 - x0, h = y1 - y0;
  if (medH > 46 || w > 620 || h > 760 || w * h > winW * winH * 0.5) return null;
  return { rect: [x0 - 10, y0 - 10, w + 20, h + 20], kind: 'overlay' };
}

module.exports = {
  mkNode, buildDomTree, buildOcrTree, annotateElements, deriveScope,
  viewSig, initScene, observeScene, observeLayers, trailPush, backOut, findNode,
  subtreeContains, childrenIn, findContainerWith, serialize, serializeRegions,
  surfaceRect,
};
