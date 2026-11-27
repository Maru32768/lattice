//! The built `lattice-cli` binary against a temporary data folder.
#![allow(clippy::unwrap_used, reason = "a failed step fails the test")]

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

use lattice_core::fetch::Fetched;
use lattice_core::ingest::store_fetched;
use lattice_core::store::Store;
use serde_json::{Value, json};

/// A temporary data folder, removed when dropped.
struct Dir(PathBuf);

impl Drop for Dir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

impl std::ops::Deref for Dir {
    type Target = Path;
    fn deref(&self) -> &Path {
        &self.0
    }
}

fn data_dir(name: &str) -> Dir {
    let dir = std::env::temp_dir().join(format!("lattice-cli-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    Dir(dir)
}

/// Two articles; the first is tagged `db`.
fn library(name: &str) -> (Dir, i64) {
    let dir = data_dir(name);
    let s = Store::open(&dir.join("lattice.db")).unwrap();
    let mut first = 0;
    for (i, (url, title, body)) in [
        (
            "https://example.com/epoll",
            "Edge-triggered epoll",
            "<h2>Intro</h2><p>Edge-triggered polling with EPOLLET requires draining the socket until EAGAIN is returned by the kernel.</p>",
        ),
        ("https://example.com/mvcc", "MVCC notes", "<p>PostgreSQL keeps tuple visibility in the heap, so vacuum has to clean up dead tuples later on.</p>"),
    ]
    .into_iter()
    .enumerate()
    {
        let (id, _) = s.upsert_pending(url, url, "example.com").unwrap();
        let html = format!("<html><head><title>{title}</title></head><body><article>{body}</article></body></html>");
        store_fetched(&s, id, &Fetched { final_url: url.into(), status: 200, content_type: None, html }).unwrap();
        if i == 0 {
            first = id;
        }
    }
    s.add_tag(first, "db").unwrap();
    (dir, first)
}

fn cli(dir: &Path, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_lattice-cli")).arg("--data-dir").arg(dir).args(args).env_remove("LATTICE_ALLOW_WRITE").output().unwrap()
}

fn ok(dir: &Path, args: &[&str]) -> Value {
    let out = cli(dir, args);
    assert!(out.status.success(), "{args:?}: {}", String::from_utf8_lossy(&out.stderr));
    serde_json::from_slice(&out.stdout).unwrap()
}

fn refused(dir: &Path, args: &[&str]) -> Value {
    let out = cli(dir, args);
    assert!(!out.status.success(), "{args:?} should fail");
    serde_json::from_slice(&out.stderr).unwrap()
}

#[test]
fn reads_the_library() {
    let (dir, id) = library("read");
    let list = ok(&dir, &["list"]);
    assert_eq!(list["total"], 2);
    assert_eq!(ok(&dir, &["list", "--scope", "tag:db"])["articles"][0]["id"], id);
    assert_eq!(ok(&dir, &["list", "--limit", "1"])["articles"].as_array().unwrap().len(), 1);

    let got = ok(&dir, &["get", &id.to_string()]);
    assert_eq!(got["article"]["title"], "Edge-triggered epoll");
    let text = got["text"].as_str().unwrap();
    assert!(text.starts_with("## Intro\n\nEdge-triggered polling with EPOLLET"), "{text}");
    let blocks = ok(&dir, &["get", &id.to_string(), "--blocks"])["blocks"].clone();
    assert_eq!(blocks[0], json!({ "id": blocks[0]["id"], "kind": "heading", "text": "Intro" }));
    assert_eq!(ok(&dir, &["get", &id.to_string(), "--stickies"])["stickies"], json!([]));

    // No embedding model in the data folder: full text, and the reason is in the JSON.
    let found = ok(&dir, &["search", "epollet"]);
    assert_eq!(found["mode"], "full_text");
    assert!(found["semantic_error"].as_str().unwrap().contains("not downloaded"));
    assert_eq!(found["hits"][0]["article_id"], id);
    assert!(ok(&dir, &["search", "epollet", "--scope", "tag:nothing"])["hits"].as_array().unwrap().is_empty());

    assert_eq!(ok(&dir, &["tags"]), json!([{ "name": "db", "count": 1 }]));
    assert_eq!(ok(&dir, &["summary", &id.to_string()])["summary"], Value::Null);
    assert_eq!(ok(&dir, &["jobs"])["counts"], json!([]));

    let out = cli(&dir, &["--format", "text", "list"]);
    let text = String::from_utf8(out.stdout).unwrap();
    assert!(text.contains("MVCC notes  <https://example.com/mvcc>") && text.contains("(2 of 2; * unread)"), "{text}");

    assert_eq!(refused(&dir, &["get", "999"]), json!({ "error": "no article 999" }));
    assert!(refused(&dir, &["list", "--scope", "starred"])["error"].as_str().unwrap().starts_with("unknown scope"));
}

#[test]
fn a_folder_scopes_to_its_feeds_and_feeds_name_their_folder() {
    let (dir, _) = library("folder");
    let s = Store::open(&dir.join("lattice.db")).unwrap();
    let folder = lattice_core::feed_folders::create(&s, "TechFeed").unwrap();
    let (feed, _) = lattice_core::feeds::add(&s, "https://techfeed.io/feeds/rust", Some(folder)).unwrap();
    lattice_core::feeds::import(&s, feed, &[lattice_core::feeds::Entry { url: "https://techfeed.io/e/1".into(), ..Default::default() }]).unwrap();
    drop(s);
    let list = ok(&dir, &["list", "--scope", &format!("folder:{folder}")]);
    assert_eq!((list["total"].clone(), list["articles"][0]["folder_id"].clone()), (json!(1), json!(folder)));
    let feeds = ok(&dir, &["feeds"]);
    assert_eq!((feeds[0]["folder_id"].clone(), feeds[0]["folder"].clone()), (json!(folder), json!("TechFeed")));
    let text = String::from_utf8(cli(&dir, &["--format", "text", "feeds"]).stdout).unwrap();
    assert!(text.contains("[TechFeed]"), "{text}");
}

#[test]
fn a_question_without_sources_is_answered_without_the_llm() {
    let (dir, _) = library("ask");
    let m = ok(&dir, &["ask", "What is MVCC?", "--scope", "tag:nothing"]);
    assert_eq!(m["mode"], "none");
    assert!(m["answer"].as_str().unwrap().starts_with("Nothing in the saved articles"));
}

#[test]
fn writes_need_the_opt_in() {
    let (dir, id) = library("write");
    let id_s = id.to_string();
    assert!(refused(&dir, &["tag", &id_s, "later"])["error"].as_str().unwrap().contains("--allow-write"));
    assert_eq!(ok(&dir, &["tags"]), json!([{ "name": "db", "count": 1 }]), "nothing changed");

    assert_eq!(ok(&dir, &["--allow-write", "tag", &id_s, "later"])["tags"], json!(["db", "later"]));
    assert_eq!(ok(&dir, &["--allow-write", "favorite", &id_s])["favorite"], true);
    let out =
        Command::new(env!("CARGO_BIN_EXE_lattice-cli")).arg("--data-dir").arg(&*dir).args(["read", &id_s]).env("LATTICE_ALLOW_WRITE", "1").output().unwrap();
    assert!(out.status.success(), "the environment opts in too");
    assert_eq!(ok(&dir, &["list", "--scope", "unread"])["total"], 1);

    // Saving queues the fetch for the app's runners (nothing is fetched without --run).
    let saved = ok(&dir, &["--allow-write", "save", "https://example.invalid/page"]);
    assert_eq!((saved["queued"].clone(), saved["jobs_run"].clone()), (json!(true), json!(0)));
    assert_eq!(saved["article"]["fetch_status"], "pending");
    assert_eq!(ok(&dir, &["jobs"])["counts"], json!([{ "job_type": "ingest", "state": "pending", "count": 1 }]));
    ok(&dir, &["--allow-write", "save", "https://example.invalid/page"]);
    assert_eq!(ok(&dir, &["jobs"])["counts"][0]["count"], 1, "saving it again while pending queues the same job");
    let again = ok(&dir, &["--allow-write", "save", "https://example.com/epoll"]);
    assert_eq!((again["queued"].clone(), again["article_id"].clone()), (json!(false), json!(id)), "already saved");
    // --run fetches here with the runners' code; .invalid never resolves, so the failure is recorded.
    let ran = ok(&dir, &["--allow-write", "save", "https://example.invalid/other", "--run"]);
    assert_eq!((ran["jobs_run"].clone(), ran["article"]["fetch_status"].clone()), (json!(1), json!("failed")), "{ran}");
    assert!(refused(&dir, &["--allow-write", "save", "not a url"])["error"].as_str().unwrap().starts_with("not a URL"));
}

/// `serve` takes what the phone sends only with the opt-in (design-review §32): `/api/index` tells the page whether it may.
#[test]
fn serve_takes_the_phones_changes_only_with_the_opt_in() {
    /// Stopped when dropped, so a failed step leaves no server running.
    struct Server(std::process::Child);
    impl Drop for Server {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    let (dir, _) = library("serve");
    for (flags, env, read_only) in [(&[][..], "", true), (&["--allow-write"][..], "", false), (&["--allow-delete"][..], "", false), (&[][..], "1", false)] {
        let mut server = Server(
            Command::new(env!("CARGO_BIN_EXE_lattice-cli"))
                .arg("--data-dir")
                .arg(&*dir)
                .args(flags)
                .args(["serve", "--port", "0"])
                .env("LATTICE_ALLOW_WRITE", env)
                .stdout(Stdio::piped())
                .spawn()
                .unwrap(),
        );
        let mut url = String::new();
        BufReader::new(server.0.stdout.take().unwrap()).read_line(&mut url).unwrap();
        let (host, token) = url.trim().strip_prefix("http://").and_then(|u| u.split_once("/#t=")).unwrap();
        let token = token.split('&').next().unwrap();
        let mut conn = TcpStream::connect(host).unwrap();
        write!(conn, "GET /api/index HTTP/1.1\r\nHost: {host}\r\nAuthorization: Bearer {token}\r\nConnection: close\r\n\r\n").unwrap();
        let mut response = String::new();
        conn.read_to_string(&mut response).unwrap();
        let body: Value = serde_json::from_str(response.split_once("\r\n\r\n").unwrap().1).unwrap();
        assert_eq!(body["read_only"], read_only, "{flags:?} LATTICE_ALLOW_WRITE={env:?}");
    }
}

#[test]
fn a_missing_database_is_an_error_and_is_not_created() {
    let dir = data_dir("missing");
    assert!(refused(&dir, &["list"])["error"].as_str().unwrap().contains("no Lattice database"));
    assert!(!dir.join("lattice.db").exists());
}

#[test]
fn mcp_is_not_a_subcommand() {
    let out = cli(&data_dir("no-mcp"), &["mcp"]);
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert_eq!(out.status.code(), Some(2), "{stderr}");
    assert!(stderr.contains("unrecognized subcommand 'mcp'"), "{stderr}");
}

#[test]
fn deleting_needs_its_own_opt_in() {
    let (dir, id) = library("delete");
    let id_s = id.to_string();
    assert!(refused(&dir, &["--allow-write", "delete-article", &id_s])["error"].as_str().unwrap().contains("--allow-delete"));
    let by_env = Command::new(env!("CARGO_BIN_EXE_lattice-cli"))
        .arg("--data-dir")
        .arg(&*dir)
        .args(["delete-article", &id_s])
        .env("LATTICE_ALLOW_WRITE", "1")
        .output()
        .unwrap();
    assert!(!by_env.status.success(), "the environment opts in to edits only");
    assert_eq!(ok(&dir, &["--allow-delete", "rename-article", &id_s, "Mine"])["title"], "Mine", "delete includes the edits");
    assert_eq!(ok(&dir, &["--allow-delete", "delete-article", &id_s])["deleted"], true);
    assert_eq!(ok(&dir, &["list"])["total"], 1);
}
