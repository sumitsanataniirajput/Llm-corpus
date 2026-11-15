---
name: fastapi-best-practices
description: Use when writing or changing a FastAPI service: routes, Pydantic models, dependencies, database sessions, errors, configuration and tests. Covers request/response models, async vs sync handlers, status codes and the mistakes that leak data or block the server.
---

# FastAPI best practices

Check how the project is already organised and follow it. Defaults for a new service:

## Layout

- Small project: `main.py` creates `app` and includes routers. Bigger: `routers/` (one `APIRouter` per area), `schemas.py` (Pydantic), `models.py` (database), `deps.py` (dependencies), `config.py`.
- Create routers with a `prefix` and `tags`, include them with `app.include_router(...)`.

## Request and response models

- Declare Pydantic models for bodies and ALWAYS a `response_model` for what you return, so internal fields (password hashes, internal ids) never leak.
- Separate input and output models: `NoteCreate`, `NoteUpdate`, `NoteOut` (with `model_config = ConfigDict(from_attributes=True)` to read from ORM objects).
- Constrain values in the model (`Field(min_length=1, max_length=200)`, `ge=0`), not with `if` checks in the handler.
- Return the right status: `status_code=201` on create, `204` on delete (no body), `404` via `HTTPException(status_code=404, detail="Note not found")`.

## Handlers

- Use `async def` only when everything inside is awaited (async DB driver, `httpx.AsyncClient`). A blocking call (sync SQLAlchemy, `requests`, file reads, `time.sleep`) inside `async def` freezes the whole server: make that handler a plain `def` (FastAPI runs it in a thread pool).
- Query parameters for filters and paging (`skip`, `limit` with a maximum), path parameters for ids.

## Dependencies and the database

- Share things through `Depends(...)`: a `get_db()` generator that opens a session, `yield`s it and closes it in `finally`; the current user; settings.
- One session per request. Commit once, after the whole change; roll back on error.
- Create the tables before the routes that query them are served (at startup or with migrations such as Alembic).

## Errors and security

- Raise `HTTPException` for expected failures; add an `@app.exception_handler` for your own exception types. Do not return raw stack traces.
- Read secrets and URLs from environment variables (`pydantic-settings` `BaseSettings`), never hard-code them.
- Hash passwords (for example `passlib` or `argon2`), never store them plain; never log tokens.
- Add `CORSMiddleware` only with the specific origins the frontend needs, not `["*"]` together with credentials.

## Tests

- Use `fastapi.testclient.TestClient(app)`; override dependencies with `app.dependency_overrides[get_db] = ...` to use a test database.
- Test the status code and the JSON body of each route, including a 404 and a validation error (422).
- The interactive docs are at `/docs`: a quick way to see every route and its models.
