---
name: flask-best-practices
description: Use when writing or changing a Flask app: app factory, blueprints, configuration, templates, forms, database access, error handlers and tests. Covers structure, safe templates and the mistakes that cause circular imports and leaked secrets.
---

# Flask best practices

Check how the project is organised and follow it. Defaults for a new app:

## Structure

- Small app: one `app.py`. Growing app: an application factory `create_app()` in `app/__init__.py`, with routes in blueprints (`Blueprint("notes", __name__)`) registered in the factory. This avoids circular imports and makes testing easy.
- Keep extensions (`db = SQLAlchemy()`) in their own module, created without an app and attached with `db.init_app(app)` in the factory.
- Templates in `templates/` with a `base.html` and `{% extends %}` / `{% block %}`; static files in `static/` referenced with `url_for('static', filename='...')`.

## Configuration and secrets

- Load config from environment variables (`app.config.from_prefixed_env()` or `os.environ`): `SECRET_KEY`, `DATABASE_URL`. Never commit real secrets; `debug` only locally.
- A missing `SECRET_KEY` breaks sessions and flashes: set one even in development (from the environment, not a literal in code that will be published).

## Routes and forms

- Name routes by function and build links with `url_for('notes.detail', note_id=n.id)`, never hard-coded paths.
- Validate every form field on the server (`request.form`, or Flask-WTF forms). After a successful POST `redirect(url_for(...))` (post/redirect/get), then `flash()` a message.
- Use typed converters (`/notes/<int:note_id>`) and `db.get_or_404(Note, note_id)` / `abort(404)` for missing things.
- State changes only on POST/PUT/DELETE, never on GET. Add CSRF protection (Flask-WTF `CSRFProtect`) for HTML forms.

## Templates and security

- Jinja2 autoescapes: never use `|safe` or `Markup()` on text a user wrote.
- Do not build SQL with string formatting. Use the ORM or bound parameters.
- Check ownership of an object before editing it, not only that the user is logged in.
- Store password hashes (`werkzeug.security.generate_password_hash`), never plain passwords.

## Database (Flask-SQLAlchemy)

- Define models with `db.Model`, call `db.create_all()` (or use Flask-Migrate) BEFORE the first request that queries a table.
- Avoid N+1: `joinedload` / `selectinload` options when you loop over related rows.
- `db.session.commit()` once per request after the whole change; roll back on error.

## Errors and tests

- Register `@app.errorhandler(404)` and `(500)` that render friendly pages; never show stack traces to users.
- Tests: `app = create_app({"TESTING": True, ...})`, `client = app.test_client()`, then check status code, redirect target and the resulting page or JSON. Use a separate test database.
