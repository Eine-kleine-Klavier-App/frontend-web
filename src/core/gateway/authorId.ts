// No auth system exists yet, but the backend requires an `X-Author-Id` header on every
// draft/edit/save request (unvalidated for now, deferred to real auth — see
// PianoAppBackend CLAUDE.md). A single hardcoded id is enough for local dev; a real auth
// flow replaces this constant with a token-derived id later, same header, no caller changes.
export const CURRENT_AUTHOR_ID = 'local-dev-user';
