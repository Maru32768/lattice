//! How much of the library a caller may change: `lattice-cli` and the app's MCP server check each operation against it, and
//! `lattice-cli serve` checks the phone's changes against it (design-review §23, §32). Also the app's MCP registrations:
//! one bearer token each, with the role its calls run with.

use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::msg;
use crate::store::{Store, random_hex, sha256_hex};

/// Ordered: each role allows everything the roles before it allow.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, rename = "McpRole")]
pub enum Role {
    Read,
    Edit,
    Delete,
}

/// Where a registration goes. A Claude Code project's own, which Claude Code ties to the Git repository its command runs
/// in or else to that folder, is used there in place of the user-wide one, since both go under one name.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename = "McpTarget")]
pub enum Target {
    // The aliases, and the one on `Registration::target`, read registrations stored by Claude Code's scope names.
    #[serde(alias = "user")]
    ClaudeCode,
    #[serde(alias = "local")]
    ClaudeCodeProject,
    Codex,
    Other,
}

impl Target {
    /// The agent whose own user settings the app writes (`mcp_agents`). They hold one `CLIENT_NAME`, so each of these
    /// takes one registration.
    pub fn agent(self) -> Option<&'static str> {
        match self {
            Target::ClaudeCode => Some("Claude Code"),
            Target::Codex => Some("Codex"),
            Target::ClaudeCodeProject | Target::Other => None,
        }
    }
}

/// Not a secret: a restored backup keeps the switch, and without registrations nobody gets in.
const ENABLED: &str = "mcp.enabled";
/// Every registration, token included, as one list: a backup drops it whole rather than keeping names whose tokens are gone.
const REGISTRATIONS: &str = "secret.mcp_registrations";
const MAX_NAME_CHARS: usize = 64;
/// Fixed, so what a registration put in an agent's settings stays right; the development build has its own, so both apps
/// serve agents at once.
pub const PORT: u16 = if cfg!(debug_assertions) {
    8789
} else {
    8788
};
/// Loopback only: another machine on the network cannot even connect.
pub const ADDR: SocketAddr = SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::LOCALHOST, PORT));
pub const ENDPOINT: &str = "/mcp";
/// The name a registration takes in an agent, apart for the same reason as the port. One name in every place, so a
/// project's own takes the place of the user-wide one there, and an agent's tools are `mcp__<name>__*` whichever it holds.
pub const CLIENT_NAME: &str = if cfg!(debug_assertions) {
    "lattice-dev"
} else {
    "lattice"
};

/// Two edits at once would each write back the list they read, and one change would be lost.
static EDITING: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Registration {
    /// Random and never reused, so nothing kept for a deleted registration passes to a new one.
    pub id: String,
    pub name: String,
    pub role: Role,
    /// Fixed once made: moving it would leave the old agent's settings with a token that still works.
    #[serde(alias = "scope")]
    pub target: Target,
    /// In the clear: the settings screen copies it again at any time, as the phone's QR code shows its token.
    pub token: String,
}

/// One change from the settings screen.
#[derive(Debug, Clone, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export, rename = "McpEdit")]
pub enum Edit {
    Enable {
        on: bool,
    },
    Create {
        name: String,
        role: Role,
        target: Target,
    },
    /// Writes the registration to its agent's settings again, as it is.
    Connect {
        id: String,
    },
    Regenerate {
        id: String,
    },
    SetRole {
        id: String,
        role: Role,
    },
    Delete {
        id: String,
    },
}

fn err(e: impl ToString) -> String {
    e.to_string()
}

pub fn enabled(store: &Store) -> Result<bool, String> {
    Ok(store.setting(ENABLED).map_err(err)?.is_some_and(|v| v == "1"))
}

/// In the order they were made.
pub fn registrations(store: &Store) -> Result<Vec<Registration>, String> {
    match store.setting(REGISTRATIONS).map_err(err)? {
        Some(list) => serde_json::from_str(&list).map_err(err),
        None => Ok(Vec::new()),
    }
}

/// Where agents reach the server.
pub fn url() -> String {
    format!("http://{ADDR}{ENDPOINT}")
}

/// Applies one change and gives the registration it was about, as it now is or last was. An id that is gone changes
/// nothing: the status the screen reads next shows what is there. Connecting an agent switches the server on, which the
/// agent needs.
pub fn edit(store: &Store, edit: &Edit) -> Result<Option<Registration>, String> {
    let about = apply(store, edit)?;
    if about.is_some() && matches!(edit, Edit::Create { .. } | Edit::Connect { .. }) && !enabled(store)? {
        apply(store, &Edit::Enable { on: true })?;
    }
    Ok(about)
}

fn apply(store: &Store, edit: &Edit) -> Result<Option<Registration>, String> {
    match edit {
        Edit::Enable { on } => store.set_setting(ENABLED, on.then_some("1")).map_err(err).map(|()| None),
        Edit::Create { name, role, target } => {
            let name = match name.trim() {
                "" => target.agent().unwrap_or_default(),
                name => name,
            };
            if name.is_empty() || name.chars().count() > MAX_NAME_CHARS {
                return Err(msg!("mcp.badName", max = MAX_NAME_CHARS.to_string()));
            }
            change(store, |list| {
                // The settings screen tells registrations apart by name alone: each row and its role select are labelled with it.
                if list.iter().any(|r| r.name.to_lowercase() == name.to_lowercase()) {
                    return Err(msg!("mcp.nameTaken", name = name));
                }
                // The agent's settings would hold the newer one's token alone.
                if let Some(agent) = target.agent()
                    && let Some(r) = list.iter().find(|r| r.target == *target)
                {
                    return Err(msg!("mcp.targetTaken", agent = agent, name = r.name));
                }
                let made = Registration { id: random_hex()?, name: name.to_string(), role: *role, target: *target, token: random_hex()? };
                list.push(made.clone());
                Ok(Some(made))
            })
        }
        Edit::Connect { id } => Ok(registrations(store)?.into_iter().find(|r| r.id == *id)),
        Edit::Regenerate { id } => change_one(store, id, |r| {
            r.token = random_hex()?;
            Ok(())
        }),
        Edit::SetRole { id, role } => change_one(store, id, |r| {
            r.role = *role;
            Ok(())
        }),
        Edit::Delete { id } => change(store, |list| Ok(list.extract_if(.., |r| r.id == *id).next())),
    }
}

fn change_one(store: &Store, id: &str, f: impl FnOnce(&mut Registration) -> Result<(), String>) -> Result<Option<Registration>, String> {
    change(store, |list| match list.iter_mut().find(|r| r.id == id) {
        Some(r) => f(r).map(|()| Some(r.clone())),
        None => Ok(None),
    })
}

fn change<T>(store: &Store, f: impl FnOnce(&mut Vec<Registration>) -> Result<T, String>) -> Result<T, String> {
    let _one_at_a_time = EDITING.lock().unwrap_or_else(|e| e.into_inner());
    let mut list = registrations(store)?;
    let out = f(&mut list)?;
    store.set_setting(REGISTRATIONS, Some(&serde_json::to_string(&list).map_err(err)?)).map_err(err)?;
    Ok(out)
}

/// The registration holding `token`, as stored now: a regenerated or deleted token is refused from the next request,
/// and the role is the one set last. Comparing hashes gives a timing attack nothing to measure.
pub fn authenticate(store: &Store, token: &str) -> Result<Option<Registration>, String> {
    let presented = sha256_hex(token);
    Ok(registrations(store)?.into_iter().find(|r| sha256_hex(&r.token) == presented))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> Store {
        Store::open_in_memory().unwrap()
    }

    fn create(s: &Store, name: &str, role: Role) -> Registration {
        create_in(s, name, role, Target::ClaudeCodeProject)
    }

    fn create_in(s: &Store, name: &str, role: Role, target: Target) -> Registration {
        edit(s, &Edit::Create { name: name.into(), role, target }).unwrap().unwrap()
    }

    #[test]
    fn a_token_finds_its_registration_until_it_is_regenerated_or_deleted() {
        let s = store();
        let a = create_in(&s, "Claude Code", Role::Read, Target::ClaudeCode);
        let b = create(&s, "Research", Role::Edit);
        assert_eq!(registrations(&s).unwrap(), [a.clone(), b.clone()], "what creating gives is what is stored");
        assert_eq!(a.token.len(), 64);
        assert_ne!(a.token, b.token);
        assert_eq!(authenticate(&s, &a.token).unwrap(), Some(a.clone()));
        assert_eq!(authenticate(&s, "").unwrap(), None);
        edit(&s, &Edit::SetRole { id: a.id.clone(), role: Role::Edit }).unwrap();
        assert_eq!(authenticate(&s, &a.token).unwrap().map(|r| r.role), Some(Role::Edit));
        edit(&s, &Edit::Regenerate { id: a.id.clone() }).unwrap();
        assert_eq!(authenticate(&s, &a.token).unwrap(), None, "the old token");
        let renewed = registrations(&s).unwrap().remove(0);
        assert_eq!((renewed.id.as_str(), renewed.name.as_str()), (a.id.as_str(), "Claude Code"));
        assert_eq!(edit(&s, &Edit::Connect { id: a.id.clone() }).unwrap().as_ref(), Some(&renewed));
        assert_eq!(authenticate(&s, &renewed.token).unwrap().as_ref(), Some(&renewed), "connecting again makes no new token");
        assert_eq!(edit(&s, &Edit::Delete { id: a.id.clone() }).unwrap().as_ref(), Some(&renewed), "the caller learns what went");
        assert_eq!(authenticate(&s, &renewed.token).unwrap(), None);
        assert_eq!(registrations(&s).unwrap(), std::slice::from_ref(&b), "the other one stays");
        for gone in [Edit::Delete { id: a.id.clone() }, Edit::Regenerate { id: a.id.clone() }, Edit::Connect { id: a.id }] {
            assert_eq!(edit(&s, &gone).unwrap(), None, "{gone:?}");
        }
        assert_eq!(registrations(&s).unwrap(), [b], "a registration that is gone changes nothing");
    }

    #[test]
    fn a_name_is_trimmed_and_must_be_new() {
        let s = store();
        assert_eq!(create(&s, "  Claude Code ", Role::Read).name, "Claude Code");
        let refused = |name: String| edit(&s, &Edit::Create { name, role: Role::Edit, target: Target::ClaudeCodeProject }).unwrap_err();
        assert!(refused("claude code".into()).contains("mcp.nameTaken"));
        assert!(refused(" ".into()).contains("mcp.badName"));
        assert!(refused("x".repeat(MAX_NAME_CHARS + 1)).contains("mcp.badName"));
        assert_eq!(registrations(&s).unwrap().len(), 1);
        let longest = "あ".repeat(MAX_NAME_CHARS);
        assert_eq!(create(&s, &longest, Role::Read).name, longest, "counted in characters, the limit itself allowed");
    }

    #[test]
    fn edits_at_the_same_time_lose_none() {
        let s = store();
        std::thread::scope(|scope| {
            for t in 0..8 {
                let s = &s;
                scope.spawn(move || {
                    for i in 0..10 {
                        edit(s, &Edit::Create { name: format!("{t}-{i}"), role: Role::Read, target: Target::Other }).unwrap();
                    }
                });
            }
        });
        assert_eq!(registrations(&s).unwrap().len(), 80);
    }

    #[test]
    fn a_name_and_all_of_claude_code_are_taken_once_when_registered_at_the_same_time() {
        let s = store();
        let together = std::sync::Barrier::new(8);
        std::thread::scope(|scope| {
            for t in 0..8 {
                let (s, together) = (&s, &together);
                scope.spawn(move || {
                    together.wait();
                    let _ = edit(s, &Edit::Create { name: format!("all {t}"), role: Role::Read, target: Target::ClaudeCode });
                    for i in 0..30 {
                        let _ = edit(s, &Edit::Create { name: format!("agent {i}"), role: Role::Read, target: Target::ClaudeCodeProject });
                    }
                });
            }
        });
        let list = registrations(&s).unwrap();
        assert_eq!(list.len(), 31);
        assert_eq!(list.iter().filter(|r| r.target == Target::ClaudeCode).count(), 1);
    }

    #[test]
    fn all_of_claude_code_and_codex_take_one_registration_each_and_the_rest_any_number() {
        let s = store();
        for (target, agent) in [(Target::ClaudeCode, "Claude Code"), (Target::Codex, "Codex")] {
            let first = create_in(&s, &format!("first {agent}"), Role::Read, target);
            let refused = edit(&s, &Edit::Create { name: "second".into(), role: Role::Edit, target }).unwrap_err();
            let v: serde_json::Value = serde_json::from_str(&refused).unwrap();
            assert_eq!(v, serde_json::json!({ "code": "mcp.targetTaken", "params": { "agent": agent, "name": first.name } }));
            edit(&s, &Edit::Delete { id: first.id }).unwrap();
            assert_eq!(create_in(&s, &format!("second {agent}"), Role::Edit, target).target, target, "free again once that one is gone");
        }
        for (i, target) in [Target::ClaudeCodeProject, Target::ClaudeCodeProject, Target::Other, Target::Other].into_iter().enumerate() {
            create_in(&s, &format!("more {i}"), Role::Read, target);
        }
        assert_eq!(registrations(&s).unwrap().len(), 6);
    }

    #[test]
    fn a_registration_without_a_name_takes_its_agents_and_one_without_an_agent_needs_one() {
        let s = store();
        assert_eq!(create_in(&s, "  ", Role::Read, Target::ClaudeCode).name, "Claude Code");
        assert_eq!(create_in(&s, "", Role::Read, Target::Codex).name, "Codex");
        for target in [Target::ClaudeCodeProject, Target::Other] {
            assert!(edit(&s, &Edit::Create { name: " ".into(), role: Role::Read, target }).unwrap_err().contains("mcp.badName"), "{target:?}");
        }
    }

    #[test]
    fn registrations_stored_by_scope_still_work() {
        let s = store();
        let stored = r#"[{"id":"r1","name":"All","role":"delete","scope":"user","token":"t1"},
            {"id":"r2","name":"Research","role":"read","scope":"local","token":"t2"}]"#;
        s.set_setting(REGISTRATIONS, Some(stored)).unwrap();
        assert_eq!(authenticate(&s, "t1").unwrap().map(|r| (r.role, r.target)), Some((Role::Delete, Target::ClaudeCode)));
        assert_eq!(authenticate(&s, "t2").unwrap().map(|r| r.target), Some(Target::ClaudeCodeProject));
        edit(&s, &Edit::SetRole { id: "r2".into(), role: Role::Edit }).unwrap();
        assert_eq!(authenticate(&s, "t1").unwrap().map(|r| r.target), Some(Target::ClaudeCode), "written back as it was read");
    }

    #[test]
    fn it_listens_on_this_pc_only() {
        // Tests run the development build's port; the release build's is 8788.
        assert!(ADDR.ip().is_loopback());
        assert_eq!(url(), "http://127.0.0.1:8789/mcp");
    }

    #[test]
    fn the_server_is_off_until_switched_on() {
        let s = store();
        assert!(!enabled(&s).unwrap());
        edit(&s, &Edit::Enable { on: true }).unwrap();
        assert!(enabled(&s).unwrap());
        edit(&s, &Edit::Enable { on: false }).unwrap();
        assert!(!enabled(&s).unwrap());
    }

    #[test]
    fn connecting_an_agent_switches_the_server_on_and_nothing_else_does() {
        let s = store();
        let turned_on = |change: Edit| {
            edit(&s, &Edit::Enable { on: false }).unwrap();
            let _ = edit(&s, &change);
            enabled(&s).unwrap()
        };
        let new = |name: &str, target| Edit::Create { name: name.into(), role: Role::Read, target };
        for target in [Target::ClaudeCode, Target::ClaudeCodeProject, Target::Codex, Target::Other] {
            assert!(turned_on(new(&format!("{target:?}"), target)), "{target:?}");
        }
        let id = || registrations(&s).unwrap().remove(0).id;
        assert!(turned_on(Edit::Connect { id: id() }));
        assert!(!turned_on(Edit::Connect { id: "gone".into() }));
        assert!(!turned_on(new("second", Target::Codex)), "refused");
        assert!(!turned_on(Edit::Regenerate { id: id() }));
        assert!(!turned_on(Edit::SetRole { id: id(), role: Role::Edit }));
        assert!(!turned_on(Edit::Delete { id: id() }));
    }

    #[test]
    fn registrations_are_never_backed_up() {
        assert!(REGISTRATIONS.starts_with(crate::store::SECRET_PREFIX));
        assert!(!ENABLED.starts_with(crate::store::SECRET_PREFIX));
    }
}
