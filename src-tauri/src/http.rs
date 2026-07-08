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
