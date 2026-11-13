//! The local translation engine (M1): PLaMo 3 Translate behind an OpenAI-compatible server the user runs
//! (llama-server, LM Studio, Ollama). It answers with translated text only, so each snippet is cut into
//! sentences (`sentences.rs`), sent one sentence per line, and paired back by line. Translation is all it
//! does: the AI provider chain and its JSON contract (`llm.rs`) are not involved.

use std::sync::LazyLock;
use std::time::Duration;

use serde_json::{Value, json};
use tokio::sync::Semaphore;

use crate::llm::LlmError;
use crate::msg;
use crate::segments::{self, Origin, Translated, Unit};
use crate::sentences::{self, Sentences};

pub const PROMPT_VERSION: &str = "plamo-v1";
const PROVIDER: &str = "local";
/// shortcut: assumes the context and slots of plamo-server (16,384 tokens, 3 slots); read llama-server's /props when someone runs a smaller one.
const CONTEXT_TOKENS: usize = 16_384;
const SLOTS: usize = 3;
const STOP: [&str; 2] = ["<|plamo:tag|>", "<|plamo:bos|>"];
/// The server's slots share one context, and requests that overflow it together all fail. The job `Gate`
/// and the overlay's semaphore count apart, so only a count here keeps each request inside its share.
static IN_FLIGHT: Semaphore = Semaphore::const_new(SLOTS);
/// No proxy: a system proxy must not see a server on this PC. A server that is not running is found at once.
static CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder().no_proxy().connect_timeout(Duration::from_secs(3)).timeout(Duration::from_secs(600)).build().expect("static client config")
});

/// The user's server, at a URL already checked.
pub struct Server {
    url: String,
}

/// One answered request.
struct Reply {
    content: String,
    model: Option<String>,
    /// Prompt and completion tokens, as the server counted them.
    tokens: (u64, u64),
}

/// What a batch's requests have met so far.
#[derive(Default)]
struct Calls {
    requests: usize,
    /// Prompt and completion tokens in all, and the most one request used: what `request`'s char-based
    /// bounds are checked against.
    tokens: (u64, u64),
    largest: u64,
    answered: bool,
    failures: usize,
    error: Option<LlmError>,
}

impl Calls {
    /// `segments::translate_snippets`'s rule: the server is gone, or it keeps failing with nothing answered.
    fn stopped(&self) -> bool {
        matches!(self.error, Some(LlmError::Unavailable(_))) || (!self.answered && self.failures >= 2)
    }
}

impl Server {
    /// `url` as the settings take it: http or https, with or without a trailing `/` or `/v1`. No user or
    /// password: the URL is a plain setting that backups keep, and the errors and logs show it.
    pub fn new(url: &str) -> Result<Self, String> {
        let url = url.trim().trim_end_matches('/');
        let url = url.strip_suffix("/v1").unwrap_or(url).trim_end_matches('/');
        let ok = |u: &url::Url| {
            matches!(u.scheme(), "http" | "https") && u.username().is_empty() && u.password().is_none() && u.query().is_none() && u.fragment().is_none()
        };
        match url::Url::parse(url) {
            Ok(u) if ok(&u) => Ok(Self { url: url.to_string() }),
            _ => Err(msg!("translate.localUrlInvalid")),
        }
    }

    pub fn url(&self) -> &str {
        &self.url
    }

    /// The model the server has loaded: the one named PLaMo, else the first it lists.
    pub async fn model(&self) -> Result<String, LlmError> {
        let list = self.send(CLIENT.get(format!("{}/v1/models", self.url))).await?;
        let ids: Vec<&str> = list["data"].as_array().into_iter().flatten().filter_map(|m| m["id"].as_str()).collect();
        let plamo = ids.iter().find(|id| id.to_ascii_lowercase().contains("plamo"));
        plamo.or(ids.first()).map(|id| id.to_string()).ok_or_else(|| LlmError::Unavailable(msg!("translate.localNoModel", url = self.url.as_str())))
    }

    /// Like `segments::translate_snippets`: one entry per snippet, and never failing as a whole. A batch's
    /// blocks go one request at a time, so 並列実行数 batches keep that many requests on the server.
    pub(crate) async fn translate(&self, snippets: &[String], to: &str) -> Translated {
        let mut out = Translated { results: vec![None; snippets.len()], error: None };
        // Also the connection check: with no server running, nothing is sent.
        let model = match self.model().await {
            Ok(model) => model,
            Err(e) => {
                out.error = Some(e);
                return out;
            }
        };
        let mut calls = Calls::default();
        for (snippet, result) in snippets.iter().zip(&mut out.results) {
            if calls.stopped() {
                break;
            }
            let answer = self.snippet(&model, to, snippet, &mut calls).await;
            *result = answer.map(|(units, answered_by)| (units, Origin { provider: PROVIDER.into(), model: answered_by.or_else(|| Some(model.clone())) }));
        }
        log::info!(
            "local translate: {} blocks in {} requests, {} prompt and {} completion tokens, at most {} in one (share {})",
            snippets.len(),
            calls.requests,
            calls.tokens.0,
            calls.tokens.1,
            calls.largest,
            CONTEXT_TOKENS / SLOTS
        );
        out.error = calls.error;
        out
    }

    /// One snippet: the block in one request, then sentence by sentence with the block as context when
    /// its lines do not pair up. Also the model that answered.
    async fn snippet(&self, model: &str, to: &str, snippet: &str, calls: &mut Calls) -> Option<(Vec<Unit>, Option<String>)> {
        let s = sentences::split(snippet);
        let lines: Vec<String> = s.lines().collect();
        if let Some(body) = request(model, to, None, &lines.join("\n"))
            && let Some(r) = self.call(calls, &body).await
            && let Some(units) = align(&s, &r.content).filter(|units| segments::acceptable(units))
        {
            return Some((units, r.model));
        }
        // Temperature 0 would answer a lone sentence the same way again.
        if s.len() == 1 || calls.stopped() {
            return None;
        }
        let context = segments::plain_text(snippet);
        let (mut units, mut answered_by) = (Vec::with_capacity(lines.len()), None);
        for (source, line) in s.sources().zip(&lines) {
            let r = self.call(calls, &request(model, to, Some(&context), line)?).await?;
            answered_by = r.model.or(answered_by);
            units.push(Unit { source: source.to_string(), translation: joined(&reply_lines(&r.content)) });
        }
        segments::acceptable(&units).then_some((units, answered_by))
    }

    async fn call(&self, calls: &mut Calls, body: &Value) -> Option<Reply> {
        calls.requests += 1;
        match self.chat(body).await {
            Ok(r) => {
                calls.answered = true;
                calls.tokens = (calls.tokens.0 + r.tokens.0, calls.tokens.1 + r.tokens.1);
                calls.largest = calls.largest.max(r.tokens.0 + r.tokens.1);
                Some(r)
            }
            Err(e) => {
                calls.failures += usize::from(!matches!(e, LlmError::Malformed(_) | LlmError::Declined(_)));
                calls.error = Some(e);
                None
            }
        }
    }

    async fn chat(&self, body: &Value) -> Result<Reply, LlmError> {
        let _slot = IN_FLIGHT.acquire().await.map_err(|e| LlmError::Failed(e.to_string()))?;
        let req = CLIENT.post(format!("{}/v1/chat/completions", self.url)).header(reqwest::header::CONTENT_TYPE, "application/json").body(body.to_string());
        reply(&self.send(req).await?).map_err(|e| LlmError::Malformed(self.failed(e)))
    }

    /// One request. No answer, or one that says there is no server to translate with here, is `Unavailable`.
    async fn send(&self, req: reqwest::RequestBuilder) -> Result<Value, LlmError> {
        let resp = req.send().await.map_err(|e| {
            let cause =
                std::iter::successors(Some(&e as &(dyn std::error::Error + 'static)), |c| c.source()).last().map(ToString::to_string).unwrap_or_default();
            if e.is_connect() {
                self.unavailable(cause)
            } else {
                LlmError::Failed(self.failed(format!("{e}: {cause}")))
            }
        })?;
        let status = resp.status();
        let body = resp.text().await.map_err(|e| LlmError::Failed(self.failed(e)))?;
        let head = || body.chars().take(300).collect::<String>();
        if status.is_success() {
            return serde_json::from_str(&body).map_err(|e| LlmError::Malformed(self.failed(format!("{e}: {}", head()))));
        }
        let detail = format!("HTTP {status}: {}", head());
        Err(match status.as_u16() {
            401 | 403 | 404 | 503 => self.unavailable(detail),
            400 => LlmError::Declined(self.failed(detail)),
            _ => LlmError::Failed(self.failed(detail)),
        })
    }

    fn unavailable(&self, detail: String) -> LlmError {
        LlmError::Unavailable(msg!("translate.localUnavailable", url = self.url.as_str(), detail = detail))
    }

    /// Any other failure, coded too: the settings status and a job's error show it.
    fn failed(&self, detail: impl std::fmt::Display) -> String {
        msg!("translate.localFailed", url = self.url.as_str(), detail = detail.to_string())
    }
}

/// The request for `text`, or none when it cannot fit its share of the server's context. Tokens are
/// bounded from chars (measured: about 1 per Japanese char, 0.25 per English one); the context goes first.
fn request(model: &str, to: &str, context: Option<&str>, text: &str) -> Option<Value> {
    let chars = |s: &str| s.chars().count();
    let max_tokens = chars(text) + 64;
    let plain = format!("[plamo-translate]\ntarget_lang={to}");
    let with_context = context.map(|c| format!("{plain}\n---\n{c}"));
    let fits = |system: &String| (chars(system) + chars(text)) * 5 / 4 + max_tokens <= CONTEXT_TOKENS / SLOTS;
    let system = with_context.into_iter().chain([plain]).find(fits)?;
    Some(json!({
        "model": model,
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": text}],
        "temperature": 0,
        "max_tokens": max_tokens,
        "stop": STOP,
    }))
}

/// The translation in a chat completion. One that did not end on its own (`length`: cut off) is none.
fn reply(body: &Value) -> Result<Reply, String> {
    let choice = &body["choices"][0];
    let finish = choice["finish_reason"].as_str().unwrap_or("none");
    match (finish, choice["message"]["content"].as_str().filter(|c| !c.trim().is_empty())) {
        ("stop", Some(content)) => Ok(Reply {
            content: tighten(content),
            model: body["model"].as_str().map(str::to_string),
            tokens: (body["usage"]["prompt_tokens"].as_u64().unwrap_or(0), body["usage"]["completion_tokens"].as_u64().unwrap_or(0)),
        }),
        _ => Err(format!("finish_reason={finish}")),
    }
}

/// Units from a reply to `s`'s lines: a line per sentence, or any number of lines for a lone sentence.
fn align(s: &Sentences<'_>, content: &str) -> Option<Vec<Unit>> {
    let lines = reply_lines(content);
    let translations: Vec<String> = match s.len() {
        1 => vec![joined(&lines)],
        n if n == lines.len() => lines.iter().map(|l| l.to_string()).collect(),
        _ => return None,
    };
    Some(s.sources().zip(translations).map(|(source, translation)| Unit { source: source.to_string(), translation }).collect())
}

/// `html` without the spaces between Japanese text and a tag that has Japanese on its other side (not one
/// between two tags, which may part two elements). PLaMo
/// spaces every inline element of a reply once it spaces a `<code>` there (「前に <a>ドキュメント</a> を」);
/// Japanese puts no space between Japanese words, and the one before `<code>git status</code>` stays.
fn tighten(html: &str) -> String {
    let mut pieces = Vec::new();
    let mut rest = html;
    while let Some(c) = rest.chars().next() {
        let len = sentences::tag_len(rest).unwrap_or(c.len_utf8());
        pieces.push(&rest[..len]);
        rest = &rest[len..];
    }
    let tag = |p: &&str| p.len() > 1 && p.starts_with('<');
    let japanese = |p: Option<&&str>| p.and_then(|p| p.chars().next()).is_some_and(crate::markdown::joins_without_space);
    let dropped = |i: usize| {
        let (before, after) = (&pieces[..i], &pieces[i + 1..]);
        pieces[i] == " "
            && before.last().is_some_and(tag) != after.first().is_some_and(tag)
            && japanese(before.iter().rev().find(|p| !tag(p)))
            && japanese(after.iter().find(|p| !tag(p)))
    };
    (0..pieces.len()).filter(|&i| !dropped(i)).map(|i| pieces[i]).collect()
}

fn reply_lines(content: &str) -> Vec<&str> {
    content.lines().map(str::trim).filter(|l| !l.is_empty()).collect()
}

/// Lines that translate one sentence, as one text.
fn joined(lines: &[&str]) -> String {
    segments::joined_translation(&lines.iter().map(|l| Unit { source: String::new(), translation: (*l).to_string() }).collect::<Vec<_>>())
}

#[cfg(test)]
pub(crate) mod tests {
    use std::sync::{Arc, Mutex};

    use super::*;

    pub(crate) type Seen = Arc<Mutex<Vec<(String, Value)>>>;

    /// A server on a loopback port that answers each request with `answer(path, body)`. Its URL, and
    /// the requests it has seen.
    pub(crate) async fn serve(answer: impl Fn(&str, &Value) -> (u16, Value) + Send + Sync + 'static) -> (String, Seen) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let (answer, seen) = (Arc::new(answer), Seen::default());
        let log = seen.clone();
        tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                let (answer, log) = (answer.clone(), log.clone());
                tokio::spawn(async move {
                    let mut buf = Vec::new();
                    let mut chunk = [0; 4096];
                    let (head, body) = loop {
                        let n = stream.read(&mut chunk).await.unwrap();
                        if n == 0 {
                            return;
                        }
                        buf.extend_from_slice(&chunk[..n]);
                        let Some(end) = buf.windows(4).position(|w| w == b"\r\n\r\n") else {
                            continue;
                        };
                        let head = String::from_utf8_lossy(&buf[..end]).to_string();
                        let len: usize =
                            head.lines().find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse().unwrap())).unwrap_or(0);
                        if buf.len() >= end + 4 + len {
                            break (head, buf[end + 4..end + 4 + len].to_vec());
                        }
                    };
                    let path = head.split(' ').nth(1).unwrap_or_default().to_string();
                    let body: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
                    let (status, reply) = answer(&path, &body);
                    log.lock().unwrap().push((path, body));
                    let reply = reply.to_string();
                    let response =
                        format!("HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}", reply.len());
                    let _ = stream.write_all(response.as_bytes()).await;
                });
            }
        });
        (url, seen)
    }

    fn completion(content: &str) -> Value {
        json!({
            "model": "plamo-3-translate-q4",
            "choices": [{"finish_reason": "stop", "message": {"role": "assistant", "content": content}}],
            "usage": {"prompt_tokens": 40, "completion_tokens": 20},
        })
    }

    fn system(body: &Value) -> &str {
        body["messages"][0]["content"].as_str().unwrap()
    }

    fn text(body: &Value) -> &str {
        body["messages"][1]["content"].as_str().unwrap()
    }

    /// Lists two models, PLaMo second, and translates every line it gets as 訳:<line>.
    pub(crate) fn plamo(path: &str, body: &Value) -> (u16, Value) {
        if path == "/v1/models" {
            return (200, json!({"object": "list", "data": [{"id": "other-model"}, {"id": "PLaMo-3-translate"}]}));
        }
        (200, completion(&text(body).lines().map(|l| format!("訳:{l}")).collect::<Vec<_>>().join("\n")))
    }

    fn unit(source: &str, translation: &str) -> Unit {
        Unit { source: source.into(), translation: translation.into() }
    }

    fn snippets(texts: &[&str]) -> Vec<String> {
        texts.iter().map(|t| t.to_string()).collect()
    }

    /// A URL where nothing listens.
    pub(crate) fn closed_port() -> String {
        format!("http://{}", std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap())
    }

    #[tokio::test]
    async fn a_block_comes_back_as_its_sentences_paired_by_line() {
        let (url, seen) = serve(plamo).await;
        let t = Server::new(&url).unwrap().translate(&snippets(&["Use <code>git\n status</code>. Then <a href=\"/c\">commit</a>."]), "ja").await;
        let (units, origin) = t.results[0].clone().unwrap();
        assert_eq!(
            units,
            [
                unit("Use <code>git\n status</code>. ", "訳:Use <code>git status</code>."),
                unit("Then <a href=\"/c\">commit</a>.", "訳:Then <a href=\"/c\">commit</a>.")
            ]
        );
        assert_eq!(origin, Origin { provider: "local".into(), model: Some("plamo-3-translate-q4".into()) }, "the model the answer names");
        assert!(t.error.is_none());
        let seen = seen.lock().unwrap();
        assert_eq!(seen.iter().map(|(path, _)| path.as_str()).collect::<Vec<_>>(), ["/v1/models", "/v1/chat/completions"]);
        let chat = &seen[1].1;
        assert_eq!(chat["model"], "PLaMo-3-translate", "the PLaMo model the server lists, for servers that load several");
        assert_eq!((system(chat), text(chat)), ("[plamo-translate]\ntarget_lang=ja", "Use <code>git status</code>.\nThen <a href=\"/c\">commit</a>."));
        assert_eq!((&chat["temperature"], &chat["stop"]), (&json!(0), &json!(["<|plamo:tag|>", "<|plamo:bos|>"])));
    }

    #[tokio::test]
    async fn a_block_whose_lines_do_not_pair_up_is_sent_again_a_sentence_at_a_time_with_the_block_as_context() {
        let (url, seen) = serve(|path, body| match path {
            "/v1/models" => plamo(path, body),
            _ if system(body).contains("---") => (200, completion(&format!("訳:{}", text(body)))),
            _ => (200, completion("二文を一行にまとめた訳")),
        })
        .await;
        let t = Server::new(&url).unwrap().translate(&snippets(&["First <em>one</em>. Second &amp; last."]), "en").await;
        let (units, origin) = t.results[0].clone().unwrap();
        assert_eq!(units, [unit("First <em>one</em>. ", "訳:First <em>one</em>."), unit("Second &amp; last.", "訳:Second &amp; last.")]);
        assert_eq!(origin.model.as_deref(), Some("plamo-3-translate-q4"), "the model the retries' answers name");
        let seen = seen.lock().unwrap();
        let retries: Vec<&str> = seen[2..].iter().map(|(_, b)| system(b)).collect();
        assert_eq!(retries, ["[plamo-translate]\ntarget_lang=en\n---\nFirst one. Second & last."; 2], "the block's text, after ---");
    }

    #[tokio::test]
    async fn a_lone_sentence_answered_on_several_lines_is_one_unit_and_not_sent_again() {
        let (url, seen) = serve(|path, body| match path {
            "/v1/models" => plamo(path, body),
            _ => (200, completion("最初の行\n\n次の行")),
        })
        .await;
        let t = Server::new(&url).unwrap().translate(&snippets(&["One long sentence."]), "ja").await;
        assert_eq!(t.results[0].clone().unwrap().0, [unit("One long sentence.", "最初の行次の行")]);
        assert_eq!(seen.lock().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn a_translation_cut_off_by_its_length_is_not_taken() {
        let (url, _) = serve(|path, body| match path {
            "/v1/models" => plamo(path, body),
            _ => (200, json!({"model": "m", "choices": [{"finish_reason": "length", "message": {"content": "途中まで"}}]})),
        })
        .await;
        let t = Server::new(&url).unwrap().translate(&snippets(&["One. Two."]), "ja").await;
        assert!(t.results[0].is_none());
        let e = t.error.unwrap();
        assert!(matches!(e, LlmError::Malformed(_)), "{e:?}");
        assert_eq!(code(&e).0, "translate.localFailed");
    }

    #[tokio::test]
    async fn blocks_cut_off_or_declined_do_not_stop_the_batch_and_a_lone_sentence_is_sent_once() {
        let (url, seen) = serve(|path, body| match path {
            "/v1/models" => plamo(path, body),
            _ if text(body).starts_with("Long") => (200, json!({"model": "m", "choices": [{"finish_reason": "length", "message": {"content": "途中"}}]})),
            _ if text(body).starts_with("Odd") => (400, json!({"error": {"message": "the request exceeds the available context size"}})),
            _ => plamo(path, body),
        })
        .await;
        let t = Server::new(&url).unwrap().translate(&snippets(&["Long one.", "Long two.", "Odd one.", "Odd two.", "Fine one."]), "ja").await;
        assert!(t.results[..4].iter().all(Option::is_none));
        assert_eq!(t.results[4].clone().unwrap().0, [unit("Fine one.", "訳:Fine one.")], "those blocks' text, not the server");
        assert_eq!(seen.lock().unwrap().len(), 1 + 5, "a lone sentence is not sent again");
        let e = t.error.unwrap();
        assert!(matches!(e, LlmError::Declined(_)), "{e:?}");
        assert_eq!(code(&e).0, "translate.localFailed", "the last block's 400");
    }

    #[tokio::test]
    async fn a_translation_that_lost_its_placeholders_is_not_taken() {
        let (url, _) = serve(|path, body| match path {
            "/v1/models" => plamo(path, body),
            _ => (200, completion(&text(body).replace("⟦1⟧", "").replace("⟦2⟧", "").lines().map(|l| format!("訳:{l}")).collect::<Vec<_>>().join("\n"))),
        })
        .await;
        let t = Server::new(&url).unwrap().translate(&snippets(&["See ⟦1⟧ here.", "See ⟦1⟧ here. And ⟦2⟧ there."]), "ja").await;
        assert!(t.results[0].is_none(), "a lone sentence");
        assert!(t.results[1].is_none(), "a block, then each of its sentences");
    }

    #[tokio::test]
    async fn a_block_the_server_failed_is_taken_from_its_sentences() {
        let (url, _) = serve(|path, body| match path {
            "/v1/models" => plamo(path, body),
            _ if text(body).contains('\n') => (500, json!({"error": {"message": "the context is full"}})),
            _ => plamo(path, body),
        })
        .await;
        let t = Server::new(&url).unwrap().translate(&snippets(&["One. Two."]), "ja").await;
        assert_eq!(t.results[0].clone().unwrap().0, [unit("One. ", "訳:One."), unit("Two.", "訳:Two.")]);
    }

    #[tokio::test]
    async fn a_server_failing_every_request_gets_two_not_one_per_block() {
        let (url, seen) = serve(|path, body| match path {
            "/v1/models" => plamo(path, body),
            _ => (500, json!({})),
        })
        .await;
        let blocks: Vec<String> = (0..12).map(|n| format!("Block {n} first. Block {n} second.")).collect();
        let t = Server::new(&url).unwrap().translate(&blocks, "ja").await;
        assert!(t.results.iter().all(Option::is_none));
        let e = t.error.unwrap();
        assert!(matches!(e, LlmError::Failed(_)), "{e:?}");
        let (name, params) = code(&e);
        assert!(name == "translate.localFailed" && params["detail"].as_str().unwrap().starts_with("HTTP 500"), "{name} {params}");
        assert_eq!(seen.lock().unwrap().len(), 1 + 2);
    }

    #[tokio::test]
    async fn no_request_is_sent_while_the_servers_three_slots_are_taken() {
        let (url, seen) = serve(plamo).await;
        // As three requests from jobs, the overlay and retries in flight together would hold them.
        let slots = IN_FLIGHT.acquire_many(3).await.unwrap();
        let (server, blocks) = (Server::new(&url).unwrap(), snippets(&["One."]));
        let mut t = std::pin::pin!(server.translate(&blocks, "ja"));
        // The model list takes no slot; the window starts once it is answered, however slowly.
        while seen.lock().unwrap().is_empty() {
            assert!(tokio::time::timeout(Duration::from_millis(10), &mut t).await.is_err());
        }
        assert!(tokio::time::timeout(Duration::from_millis(300), &mut t).await.is_err(), "a fourth request waits");
        assert_eq!(seen.lock().unwrap().len(), 1);
        drop(slots);
        assert!(t.await.results[0].is_some());
    }

    #[tokio::test]
    async fn every_request_holds_one_of_the_servers_three_slots_until_it_is_answered() {
        let held = Arc::new(Mutex::new(Vec::new()));
        let log = held.clone();
        let (url, _) = serve(move |path, body| {
            if path != "/v1/models" {
                // Other tests' requests can hold slots too: fewer may be free, never all three.
                log.lock().unwrap().push(IN_FLIGHT.available_permits() < 3);
            }
            plamo(path, body)
        })
        .await;
        let blocks: Vec<String> = (0..4).map(|n| format!("Block {n}.")).collect();
        Server::new(&url).unwrap().translate(&blocks, "ja").await;
        assert_eq!(*held.lock().unwrap(), [true; 4]);
    }

    fn code(e: &LlmError) -> (String, Value) {
        let v: Value = serde_json::from_str(&e.message()).unwrap();
        (v["code"].as_str().unwrap().to_string(), v["params"].clone())
    }

    #[tokio::test]
    async fn a_server_that_is_not_running_is_unavailable_before_any_block_is_sent() {
        let url = closed_port();
        let blocks: Vec<String> = (0..12).map(|n| format!("Block {n}.")).collect();
        let t = Server::new(&url).unwrap().translate(&blocks, "ja").await;
        assert!(t.results.iter().all(Option::is_none));
        let e = t.error.unwrap();
        assert!(matches!(e, LlmError::Unavailable(_)), "{e:?}");
        let (name, params) = code(&e);
        assert_eq!((name.as_str(), params["url"].as_str()), ("translate.localUnavailable", Some(url.as_str())));

        let (url, seen) = serve(|_, _| (503, json!({"error": {"message": "Loading model"}}))).await;
        let t = Server::new(&url).unwrap().translate(&blocks, "ja").await;
        assert_eq!(code(&t.error.unwrap()).0, "translate.localUnavailable", "a server still loading its model");
        assert_eq!(seen.lock().unwrap().len(), 1, "one request for the batch, not one per block");

        let (url, seen) = serve(|_, _| (200, json!({"object": "list", "data": []}))).await;
        let t = Server::new(&url).unwrap().translate(&blocks, "ja").await;
        let e = t.error.unwrap();
        assert!(matches!(e, LlmError::Unavailable(_)), "{e:?}");
        assert_eq!(code(&e), ("translate.localNoModel".into(), json!({"url": url})), "a server with no model loaded");
        assert_eq!(seen.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn a_server_that_turns_requests_away_mid_batch_stops_it_with_the_code() {
        let blocks: Vec<String> = (0..12).map(|n| format!("Block {n} first. Block {n} second.")).collect();
        for status in [401, 403, 404, 503] {
            // The first block is answered: the server goes away after that.
            let chats = std::sync::atomic::AtomicUsize::new(0);
            let (url, seen) = serve(move |path, body| match path {
                "/v1/models" => plamo(path, body),
                _ if chats.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0 => plamo(path, body),
                _ => (status, json!({})),
            })
            .await;
            let t = Server::new(&url).unwrap().translate(&blocks, "ja").await;
            assert!(t.results[0].is_some(), "{status}");
            assert_eq!(code(&t.error.unwrap()).0, "translate.localUnavailable", "{status}");
            assert_eq!(seen.lock().unwrap().len(), 3, "{status}: the model list, the first two blocks, then nothing");
        }
    }

    #[test]
    fn the_url_is_checked_and_taken_with_or_without_v1() {
        for (typed, url) in [
            ("http://127.0.0.1:8077", "http://127.0.0.1:8077"),
            (" http://127.0.0.1:8077/ ", "http://127.0.0.1:8077"),
            ("http://localhost:1234/v1", "http://localhost:1234"),
            ("https://gpu.lan/plamo/v1/", "https://gpu.lan/plamo"),
        ] {
            assert_eq!(Server::new(typed).unwrap().url(), url, "{typed}");
        }
        for typed in [
            "",
            "localhost:8077",
            "127.0.0.1:8077",
            "ftp://x",
            "http://",
            "http://:8077",
            "http://user@",
            "http://x:8077/?a=1",
            "http://x:8077#a",
            "http://user:pass@gpu.lan:8077",
            "http://user@x",
            "http://:pass@x",
            "file:///C:/x",
        ] {
            let e = Server::new(typed).err().unwrap();
            assert!(e.starts_with(r#"{"code":"translate.localUrlInvalid""#), "{typed}: {e}");
        }
    }

    #[test]
    fn a_request_fits_its_share_of_the_context_or_is_not_made() {
        let with = request("m", "ja", Some("The river. The bank was muddy."), "The bank was muddy.").unwrap();
        assert_eq!(system(&with), "[plamo-translate]\ntarget_lang=ja\n---\nThe river. The bank was muddy.");
        let long_context = "Context. ".repeat(1500);
        let dropped = request("m", "ja", Some(&long_context), "The bank was muddy.").unwrap();
        assert_eq!(system(&dropped), "[plamo-translate]\ntarget_lang=ja", "the context goes before the text does");

        let block = "a".repeat(2000);
        let body = request("m", "en", None, &block).unwrap();
        let max_tokens = body["max_tokens"].as_u64().unwrap() as usize;
        assert!(max_tokens > block.len(), "room for a translation longer than its source in tokens");
        assert!(request("m", "en", None, &"あ".repeat(5000)).is_none(), "a block that cannot fit is cut into sentences instead");
    }

    #[test]
    fn a_reply_is_taken_only_when_the_model_stopped_on_its_own() {
        let r = reply(&completion("訳")).unwrap();
        assert_eq!((r.content.as_str(), r.model.as_deref(), r.tokens), ("訳", Some("plamo-3-translate-q4"), (40, 20)));
        let finished = |reason: &str, content: &str| reply(&json!({"choices": [{"finish_reason": reason, "message": {"content": content}}]})).is_ok();
        assert!(finished("stop", "訳") && !finished("length", "訳") && !finished("stop", " \n"));
        assert!(reply(&json!({"error": "x"})).is_err());
    }

    #[test]
    fn a_space_with_japanese_on_both_sides_of_a_tag_goes() {
        // As PLaMo answered a block whose first line spaced its <code>.
        let spaced = "<code>git status</code> を実行します。\nコミットする前に <a href=\"https://x.dev/a b\">ドキュメント</a> を読みます。";
        let tight = "<code>git status</code> を実行します。\nコミットする前に<a href=\"https://x.dev/a b\">ドキュメント</a>を読みます。";
        assert_eq!((tighten(spaced).as_str(), reply(&completion(spaced)).unwrap().content.as_str()), (tight, tight));
        assert_eq!(tighten("「設定」 <b>を</b>開く"), "「設定」<b>を</b>開く", "full-width punctuation is Japanese too");
        for kept in [
            "<kbd>Ctrl</kbd> + <kbd>P</kbd> を押す",
            "東京 大学",
            "<em>A</em> <em>B</em>",
            "前に ⟦1⟧ を",
            "前に <br> 次に",
            "<code>はい</code> <code>いいえ</code>",
            "前に
<b>次</b>",
            "あ< い",
        ] {
            assert_eq!(tighten(kept), kept);
        }
    }

    #[test]
    fn lines_pair_with_sentences_only_when_they_count_the_same() {
        let s = sentences::split("One. Two.");
        assert_eq!(align(&s, "一。\n\n  二。 \n").unwrap(), [unit("One. ", "一。"), unit("Two.", "二。")], "blank lines and padding ignored");
        assert!(align(&s, "一。二。").is_none() && align(&s, "一。\n二。\n三。").is_none());
        assert_eq!(align(&sentences::split("One."), "The\nend.").unwrap(), [unit("One.", "The end.")]);
    }

    /// Run with `PLAMO_URL=http://127.0.0.1:<port> cargo test -p lattice-core live_plamo -- --ignored --nocapture`
    /// against a llama-server running PLaMo 3 Translate.
    #[tokio::test]
    #[ignore = "needs a running PLaMo server (PLAMO_URL)"]
    async fn live_plamo() {
        let server = Server::new(&std::env::var("PLAMO_URL").unwrap()).unwrap();
        let model = server.model().await.unwrap();
        println!("model: {model}");
        let r = server.chat(&request(&model, "ja", Some("We walked along the river. The bank was muddy."), "The bank was muddy.").unwrap()).await.unwrap();
        println!("bank with river context: {}", r.content);
        let block = "Run <code>git status</code> to see what changed. Then read <a href=\"https://git-scm.com/docs\">the docs</a> before you commit. It takes a minute.";
        let t = server.translate(&snippets(&[block]), "ja").await;
        let (units, origin) = t.results[0].clone().unwrap();
        println!("origin: {origin:?}");
        for u in &units {
            println!("{:?} => {:?}", u.source, u.translation);
        }
        assert_eq!(units.len(), 3, "aligned as three sentences");
        assert_eq!(units.iter().map(|u| u.source.as_str()).collect::<String>(), block);
    }
}
