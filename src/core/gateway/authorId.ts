// The MOCK "me" identity for the still-mocked browse layer (Explore/Library/author profiles use
// it for `isMe` / "your scores" against fixture data). This is NO LONGER an auth credential —
// real backend calls now carry a Bearer access token via `authorizedFetch` (see core/auth). It
// stays only until the browse listings become real and can key off the signed-in user id.
export const CURRENT_AUTHOR_ID = 'local-dev-user';
