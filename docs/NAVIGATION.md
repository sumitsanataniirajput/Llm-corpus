# Navigation and page-module reliability

This document describes the navigation shell: one hamburger, one drawer, every
page in a grouped menu, and the route registry that keeps the menu, the router,
the bootstrap and the test suite from disagreeing.

Branch: `arena/fcde7427-llm-corpus` · build `2026-11-20.1`

---

## 1. One navigation system

| Before | Now |
| --- | --- |
| Bottom bar on phones (5 links) **and** a sidebar on desktop | One hamburger in the app bar, one drawer, every width |
| Two active-state implementations (`data-route` on the bar, a label→route map for the sidebar) | One: `data-route` on every item |
| Five routes reachable on a phone, twenty-four on a desktop | All 24 routes reachable on every device |
| Drawer pinned open on desktop, `#menu-toggle` hidden there | Drawer closed on load everywhere; the hamburger is always present |

There is no other navigation surface: no bottom bar, no floating menu, no
duplicate link row. Page-level shortcut buttons (the dashboard's "quick
actions") are content, not chrome, and stay where they are.

### Behaviour

* **Closed on load** at every size — the page you land on is the page you see.
* **Open**: hamburger, or `router.openSidebar()`.
* **Close**: hamburger again, the drawer's × button, a tap on the scrim,
  Escape, or choosing a page.
* While open: `body.nav-open` stops the page behind it scrolling, the drawer
  lists are the only thing that scrolls, focus moves to the current page's item,
  and closing returns focus to the hamburger.
* ARIA: `aria-expanded` + `aria-controls` on the hamburger, `aria-hidden` and
  `inert` on the closed drawer, `aria-current="page"` on the active item.

### Touch, mobile and safe areas

* Every entry and section heading is at least `2.75rem` (44 px) tall, with
  `touch-action: manipulation` so taps are not delayed by double-tap zoom.
* `.sidebar-nav` scrolls with momentum (`-webkit-overflow-scrolling: touch`),
  contains its overscroll (`overscroll-behavior: contain`) and only pans
  vertically.
* The drawer pads by `--safe-top` / `--safe-bottom` (notch and home indicator),
  uses `100dvh` so the mobile URL bar cannot clip it, and `.main-content`
  reserves the bottom inset instead of a bottom-bar height.

---

## 2. Grouped, expandable sections

| Section | Pages |
| --- | --- |
| Workspace | Dashboard, Statistics |
| Build & Data | Models, Training Center, Datasets, Evaluation, Experiments |
| AI & Intelligence | AI Information, Chat, Prediction Lab, Neural Lab |
| Compute & Devices | Compute, Device Compute, Multi-Device Training, Cloud Storage |
| Teaching & Distillation | AI Teacher Network, AI API Keys, Teacher Selection, Knowledge Distillation, Dataset Quality Review, Student Model Studio |
| Observability | Training Intelligence, API Usage & Budgets |
| System | Settings |

Each section is a native `<details>`/`<summary>`: it expands without JavaScript,
works with a keyboard, a screen reader and a TV remote, and the chevron rotates
to show its state. The section holding the current page opens itself, and the
user's own open/closed choices are remembered in
`localStorage["corpus_nav_groups"]` (a new key — nothing existing is touched).

---

## 3. The route registry

`frontend/js/routes.js` declares every page once:

```js
{ route: 'ai-teachers', module: 'teachers', script: 'js/teachers.js',
  label: 'AI Teacher Network', icon: 'fa-graduation-cap', group: 'teaching' }
```

Consumers:

| Consumer | Uses the registry for |
| --- | --- |
| `js/router.js` | renderer lookup, script lookup, sidebar sections and items, active state, aliases |
| `js/app-bootstrap.js` | verifying that **every** module registered a `render()` before the first navigation |
| `frontend/tests/*` | the contract tests (no second copy of the table anywhere) |

Adding a page is one edit. Forgetting an entry in some other table — the cause
of the "module not loaded" class of bug — is no longer possible, and `npm test`
fails if a registry entry has no file, no global, or no `render()`.

Old hashes are aliased rather than redirected to the dashboard:
`#/ai-api-keys`, `#/api-keys` and `#/providers` all open AI API Keys
(`provider-management`), and the hash is rewritten to the canonical route.

---

## 4. What was broken, and why

**AI Teacher Network and Dataset Quality Review showed "module not loaded"**
even though both scripts had loaded and both globals existed.

`navigate()` called `renderer()` with no arguments. Two routes share one module
(`teachers` backs AI Teacher Network and AI API Keys; `distillation` backs
Knowledge Distillation and Dataset Quality Review), so those renderers were
written route-aware:

```js
function renderTeachers(route) {
  return renderModulePage(route, 'AI Teacher Network', ...);   // route === undefined
}
```

With `route` undefined, `PAGE_MODULES[undefined]` was empty, the recovery step
found no script to re-request, and the router drew the diagnostics panel —
truthfully reporting that no module was mapped for that route, because it had
been handed no route at all.

Fixes, all three of them:

1. `navigate()` now passes the route: `renderer(route)`.
2. The per-page wrappers are gone; one `renderPage(route)` reads label, icon,
   module and script from the registry, so there is no route string to forget.
3. `routes` is built from the registry, so a route cannot exist without a
   renderer (and a test asserts no renderer hard-codes its own route).

**A duplicate global silently broke auth UI:** `js/components.js` did
`window.ui = (function(){…})()`, replacing the object `js/auth.js` had already
added `showOffline`, `hideOffline`, `setLoading` and `closeAuth` to. Any auth
event then threw `ui.hideOffline is not a function`. `components.js` now merges
(`Object.assign(window.ui || {}, …)`), and a test fails if any other global is
claimed by two files.

---

## 5. Automated checks

| Test file | What it proves |
| --- | --- |
| `route-wiring.test.mjs` | registry executed and inspected: unique routes, existing scripts, a `window.<module>` and `render()` per module, one `<script>` per file before the bootstrap, registry loaded before router, no hard-coded renderer routes, no duplicate globals, the exact 24 labels grouped into ≥5 sections, aliases, build id everywhere |
| `route-render.test.mjs` | boots `index.html` with the real scripts and walks **all 24 routes at 390×844 and 1440×900** through the real router: `render(route)` called with the right route, real heading rendered, no "module not loaded", no error panel, no render error in the diagnostics log, active item and open section correct, hash/session storage consistent, aliases and deep links resolve, unknown routes fall back to the dashboard |
| `navigation-shell.test.mjs` | no bottom bar in markup, CSS or runtime; one hamburger; 24 items in 7 sections with the right membership; open/close/Escape/scrim/close-button/focus/scroll-lock/ARIA; section auto-open and remembered state; desktop behaves identically; CSS contract for touch size, scrolling, safe areas and the absence of a pinned desktop sidebar |
| `app-boot.test.mjs` | every script executes in document order, every registry module registers, and a wiped module recovers with a cache-busting re-request — including a module shared by two routes |
| `scripts/tests/verify-deployment.test.mjs` | the live site is checked for the registry and the hamburger, and **fails if it still serves the removed bottom bar** |

Run them with:

```bash
npm test                 # frontend + deployment tooling
node --test frontend/tests/route-render.test.mjs   # the route sweep alone
```

---

## 6. What was not touched

Navigation is a client-side shell change. No backend endpoint, migration,
Supabase table, credential, training job, dataset or user setting is modified.
The only storage writes are the drawer's own `localStorage["corpus_nav_groups"]`
entry and the existing `corpus:last-route` session key the router already used.
Existing signed-in sessions, saved models, datasets, checkpoints and settings
are read exactly as before.
