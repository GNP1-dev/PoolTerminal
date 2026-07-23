//! Direct HTTPS to public APIs (Koios) from the host machine.
//!
//! Finding D: Koios calls previously ran as `curl` over SSH on the node, which
//! put the bearer token in the node's process arguments. Here the request is
//! made with reqwest from the host, so the token travels as a real HTTP header
//! in process memory and never appears on any command line. Also takes the
//! public-API load off the block producer. (koios-http-v74)

/// Make a Koios HTTP request. Returns the response body on 2xx, an empty string
/// on non-2xx (mirroring `curl -sf`), or an Err on transport failure.
#[tauri::command]
pub async fn koios_http(
    url: String,
    method: Option<String>,
    body: Option<String>,
    token: Option<String>,
    max_time: Option<u64>,
) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(max_time.unwrap_or(8)))
        .build()
        .map_err(|e| e.to_string())?;

    let is_post = method
        .as_deref()
        .map(|m| m.eq_ignore_ascii_case("POST"))
        .unwrap_or(false);

    let mut req = if is_post {
        client.post(&url).header("content-type", "application/json")
    } else {
        client.get(&url)
    };

    if let Some(t) = token.as_deref() {
        if !t.is_empty() {
            req = req.header("authorization", format!("Bearer {t}"));
        }
    }
    if let Some(b) = body {
        req = req.body(b);
    }

    let resp = req.send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Ok(String::new());
    }
    resp.text().await.map_err(|e| e.to_string())
}

// Telegram Bot API calls for the Alerts feature. The bot token travels as a
// real HTTPS request from the host (never on a command line, never in the
// rendered DOM). Unlike koios_http, this returns the body on ANY status so the
// caller can show Telegram's own error text (e.g. "chat not found",
// "Unauthorized") in the setup wizard. (telegram-alerts-v75)

/// Call a Telegram Bot API method. `method` is e.g. "sendMessage" or
/// "getUpdates"; `token` is the bot token; `body` is a JSON string (or None for
/// GET-style calls like getUpdates). Returns the raw JSON response body
/// regardless of HTTP status, so the frontend can parse ok/description itself.
#[tauri::command]
pub async fn telegram_send(
    token: String,
    method: String,
    body: Option<String>,
) -> Result<String, String> {
    if token.trim().is_empty() {
        return Err("No bot token provided".into());
    }
    let url = format!("https://api.telegram.org/bot{token}/{method}");
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;

    let req = match &body {
        Some(b) => client
            .post(&url)
            .header("content-type", "application/json")
            .body(b.clone()),
        None => client.get(&url),
    };

    let resp = req.send().await.map_err(|e| e.to_string())?;
    // Return the body on any status - Telegram puts {ok:false, description:...}
    // in the body for errors, which the wizard shows to the user.
    resp.text().await.map_err(|e| e.to_string())
}
