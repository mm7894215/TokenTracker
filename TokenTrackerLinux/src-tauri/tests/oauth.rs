use tokentracker_linux::oauth::{
    callback_url, is_allowed_oauth_url, parse_auth_callback, PendingAuthCode,
};

#[test]
fn parses_only_the_expected_auth_callback() {
    assert_eq!(
        parse_auth_callback("tokentracker://auth/callback?insforge_code=abc%2F123"),
        Some("abc/123".to_string())
    );

    for invalid in [
        "https://auth/callback?insforge_code=abc",
        "tokentracker://open/callback?insforge_code=abc",
        "tokentracker://auth/done?insforge_code=abc",
        "tokentracker://auth/callback/extra?insforge_code=abc",
        "tokentracker://auth/callback",
        "tokentracker://auth/callback?insforge_code=",
        "tokentracker://auth/callback?insforge_code=one&insforge_code=two",
        "tokentracker://auth/callback#insforge_code=abc",
    ] {
        assert_eq!(parse_auth_callback(invalid), None, "accepted {invalid}");
    }
}

#[test]
fn opens_only_absolute_https_oauth_urls() {
    assert!(is_allowed_oauth_url(
        "https://auth.example.com/oauth?client_id=1"
    ));

    for invalid in [
        "http://auth.example.com/oauth",
        "file:///tmp/token",
        "javascript:alert(1)",
        "data:text/plain,secret",
        "/relative/oauth",
        "https://",
    ] {
        assert!(!is_allowed_oauth_url(invalid), "accepted {invalid}");
    }
}

#[test]
fn builds_a_loopback_callback_url_with_an_encoded_code() {
    assert_eq!(
        callback_url("http://127.0.0.1:17680", "a/b+c?d").as_deref(),
        Some("http://127.0.0.1:17680/auth/callback?insforge_code=a%2Fb%2Bc%3Fd&app=1")
    );
    assert_eq!(callback_url("https://example.com", "code"), None);
}

#[test]
fn pending_auth_code_is_consumed_once_and_latest_wins() {
    let pending = PendingAuthCode::default();
    pending.store("first".to_string());
    pending.store("second".to_string());

    assert_eq!(pending.take().as_deref(), Some("second"));
    assert_eq!(pending.take(), None);
}
