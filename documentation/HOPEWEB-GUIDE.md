# Hopeweb guide — where every file goes

> **Please read this first.** I could not open or test Hopeweb while writing this project, so this guide does not
> describe Hopeweb’s buttons or menus — I would be guessing, and wrong guesses waste your time. It gives you the
> exact rule that works in any file manager or web-site builder that lets you create folders and files, plus the
> exact list of files. If Hopeweb cannot create sub-folders or cannot hold `.js` files next to `index.html`,
> tell me what its file screen looks like and I will adapt the layout.

## The one rule

**The contents of the `web/` folder become the top level (the “web root”) of your site.**
So `web/index.html` → `index.html` at the top, `web/js/api.js` → `js/api.js`, and so on. Do not rename files,
and keep lower-case names exactly as written — on most hosts `Config.js` and `config.js` are different files.

Only `web/` is uploaded to the web host. Never upload `supabase/`, `android/`, `tests/` or `documentation/`
to the web host — they are not part of the website.

## Fastest way

1. Download this project as a ZIP (GitHub → **Code** → **Download ZIP**) and unzip it.
2. Create `web/js/config.js` on your computer (see `SETUP.md` Part B).
3. If Hopeweb can upload a folder or a ZIP: upload everything **inside** `web/`.
4. If it only lets you create files one at a time: create the folders below, then for each file create a file
   with the same name, open the original in a text editor (Notepad, TextEdit, VS Code), copy everything
   (Ctrl+A, Ctrl+C) and paste it in (Ctrl+V). Save.

## Folders to create in the web root

```
(web root)
├── assets/
│   └── icons/
├── css/
├── js/
│   └── pages/
└── pages/
```

## The three primary files

| File name | Location | Action | What it is | How to test |
|---|---|---|---|---|
| `index.html` | web root | Create (or replace the existing `index.html`) | The single page of the console: sign-in screen and application shell. Loads `style.css` and `script.js`. | Open your site address: the sign-in screen appears. |
| `style.css` | web root | Create or replace | Main stylesheet. It imports the three files in `css/`. | The sign-in screen is styled (not plain black text on white). |
| `script.js` | web root | Create or replace | Start-up script: checks `js/config.js`, handles sign-in, then starts the router that loads the pages. | With no `js/config.js` you see “Configuration file missing” — that proves `script.js` runs. |

## Every other file

The complete list — file name, location, action and purpose for **every** file in the project — is in
`documentation/FILE-INDEX.md`. The complete code of each file is the file itself in this repository; nothing is
shortened or left as a placeholder.

How the web files connect:

```
index.html ── loads ──► style.css ──► css/themes.css, css/components.css, css/responsive.css
     │
     ├── loads from the internet: Supabase SDK, Chart.js, SweetAlert2, Font Awesome
     ├── loads js/config.js            (your addresses and PUBLIC keys — you create this file)
     └── loads script.js ──► js/auth.js ──► js/supabase-client.js
                        └─► js/router.js ──► pages/<name>.html  +  js/pages/<name>.js   (one pair per menu item)
                                              each page uses js/api.js, js/components.js, js/permissions.js, …
```

## Files that do NOT go to the web host

| Folder | Where it goes instead | Guide |
|---|---|---|
| `supabase/migrations/*.sql` | Pasted one by one into the Supabase **SQL Editor** | `SETUP.md` Part A |
| `supabase/policies/schedule_jobs.sql` | Supabase SQL Editor, once | `SETUP.md` Part A step 9 |
| `supabase/functions/` | Deployed with the Supabase CLI from your computer | `SETUP.md` Part D |
| `supabase/seed/demo_seed.sql` | A separate practice project only | `SETUP.md` Part I |
| `android/` | Opened in Android Studio on your computer | `DEPLOYMENT.md` |
| `tests/` | Run on your computer (optional) | `DEPLOYMENT.md` |

## Check list after uploading

1. `https://your-site/` shows the sign-in screen.
2. `https://your-site/js/config.js` shows your config text (and contains **no** key starting with `sb_secret_` or a
   key whose role is `service_role`).
3. `https://your-site/pages/dashboard.html` shows a fragment of HTML (proves the `pages/` folder uploaded).
4. Sign in → the Dashboard loads with zeros. Zeros are correct for a new system; the console never shows invented numbers.
5. If the menu loads but a page says a “Page file … is missing”, a file in `js/pages/` or `pages/` is missing or misnamed.

## When you change something later

Replace only the file that changed, keeping the same name and location. After replacing a `.js` or `.css` file,
reload the site with Ctrl+F5 so the browser does not use its saved copy.
