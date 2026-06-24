// Google Calendar OAuth (desktop, PKCE loopback) + Keychain token storage.
// Desktop (macOS) only in this plan; iOS is a separate plan.
use base64::Engine;
use percent_encoding::{utf8_percent_encode, AsciiSet, CONTROLS};
use sha2::{Digest, Sha256};

const AUTH_ENDPOINT: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const SCOPE: &str = "https://www.googleapis.com/auth/calendar.events";

// Percent-encode query-value characters that are not unreserved (RFC 3986).
// Unreserved chars (never encoded): A-Z a-z 0-9 - . _ ~
// We encode everything else that could appear in URLs/scopes: : / ? # [ ] @ ! $ & ' ( ) * + , ; = space %
const QUERY_VALUE: &AsciiSet = &CONTROLS
    .add(b' ')
    .add(b'"')
    .add(b'#')
    .add(b'%')
    .add(b'<')
    .add(b'>')
    .add(b'[')
    .add(b'\\')
    .add(b']')
    .add(b'^')
    .add(b'`')
    .add(b'{')
    .add(b'|')
    .add(b'}')
    .add(b'/')
    .add(b':')
    .add(b'?')
    .add(b'@')
    .add(b'!')
    .add(b'$')
    .add(b'&')
    .add(b'\'')
    .add(b'(')
    .add(b')')
    .add(b'*')
    .add(b'+')
    .add(b',')
    .add(b';')
    .add(b'=');

/// (verifier, challenge). verifier is 64 url-safe chars; challenge is
/// base64url(sha256(verifier)) with no padding (PKCE "S256").
pub fn pkce_pair() -> (String, String) {
    let mut raw = [0u8; 48];
    getrandom::getrandom(&mut raw).expect("getrandom");
    // 48 bytes → 64 url-safe base64 chars (no padding).
    let verifier = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(raw);
    let digest = Sha256::digest(verifier.as_bytes());
    let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(digest);
    (verifier, challenge)
}

fn enc(s: &str) -> String {
    utf8_percent_encode(s, QUERY_VALUE).to_string()
}

/// Build the Google authorization-code consent URL (PKCE S256, offline access).
pub fn auth_url(client_id: &str, redirect_uri: &str, challenge: &str, state: &str) -> String {
    format!(
        "{AUTH_ENDPOINT}?response_type=code&client_id={cid}&redirect_uri={ru}\
         &scope={scope}&code_challenge={chal}&code_challenge_method=S256\
         &state={state}&access_type=offline&prompt=consent",
        cid = enc(client_id),
        ru = enc(redirect_uri),
        scope = enc(SCOPE),
        chal = enc(challenge),
        state = enc(state),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_challenge_is_s256_of_verifier() {
        let (verifier, challenge) = pkce_pair();
        assert_eq!(verifier.len(), 64, "verifier length");
        // Recompute S256 independently.
        use sha2::{Digest, Sha256};
        let digest = Sha256::digest(verifier.as_bytes());
        let expected = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(digest);
        use base64::Engine;
        assert_eq!(challenge, expected, "challenge must be base64url(sha256(verifier))");
        assert!(!challenge.contains('='), "no padding");
        assert!(!challenge.contains('+') && !challenge.contains('/'), "url-safe alphabet");
    }

    #[test]
    fn pkce_pairs_are_unique() {
        let (a, _) = pkce_pair();
        let (b, _) = pkce_pair();
        assert_ne!(a, b, "verifiers must be random");
    }

    #[test]
    fn auth_url_has_required_params() {
        let url = auth_url("CID.apps.googleusercontent.com", "http://127.0.0.1:5599/cb", "CHAL", "STATE");
        assert!(url.starts_with("https://accounts.google.com/o/oauth2/v2/auth?"));
        assert!(url.contains("client_id=CID.apps.googleusercontent.com"));
        assert!(url.contains("code_challenge=CHAL"));
        assert!(url.contains("code_challenge_method=S256"));
        assert!(url.contains("state=STATE"));
        assert!(url.contains("access_type=offline"));
        assert!(url.contains("prompt=consent"));
        // redirect + scope are percent-encoded
        assert!(url.contains("redirect_uri=http%3A%2F%2F127.0.0.1%3A5599%2Fcb"));
        assert!(url.contains("scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fcalendar.events"));
    }
}
