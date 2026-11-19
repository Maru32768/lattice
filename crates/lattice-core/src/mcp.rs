//! How much of the library a caller may change: `lattice-cli` and the app's MCP server check each operation against it, and
//! `lattice-cli serve` checks the phone's changes against it (design-review §23, §32). Also the app's MCP registrations:
//! one bearer token each, with the role its calls run with.

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

/// Not a secret: a restored backup keeps the switch, and without registrations nobody gets in.
const ENABLED: &str = "mcp.enabled";
/// Every registration, token included, as one list: a backup drops it whole rather than keeping names whose tokens are gone.
const REGISTRATIONS: &str = "secret.mcp_registrations";
const MAX_NAME_CHARS: usize = 64;
/// On loopback only. Fixed, so the command a registration copies stays right.
pub const PORT: u16 = 8788;

/// Two edits at once would each write back the list they read, and one change would be lost.
static EDITING: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Registration {
    /// Random and never reused, so nothing kept for a deleted registration passes to a new one.
    pub id: String,
    pub name: String,
    pub role: Role,
    /// In the clear: the settings screen copies it again at any time, as the phone's QR code shows its token.
    pub token: String,
}

/// One change from the settings screen.
#[derive(Debug, Clone, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export, rename = "McpEdit")]
pub enum Edit {
    Enable { on: bool },
    Create { name: String, role: Role },
    Regenerate { id: String },
    SetRole { id: String, role: Role },
    Delete { id: String },
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

/// Applies one change. An id that is gone changes nothing: the status the screen reads next shows what is there.
pub fn edit(store: &Store, edit: &Edit) -> Result<(), String> {
    match edit {
        Edit::Enable { on } => store.set_setting(ENABLED, on.then_some("1")).map_err(err),
        Edit::Create { name, role } => {
            let name = name.trim();
            if name.is_empty() || name.chars().count() > MAX_NAME_CHARS {
                return Err(msg!("mcp.badName", max = MAX_NAME_CHARS.to_string()));
            }
            change(store, |list| {
                // The settings screen tells registrations apart by name alone: each row and its role select are labelled with it.
                if list.iter().any(|r| r.name.to_lowercase() == name.to_lowercase()) {
                    return Err(msg!("mcp.nameTaken", name = name));
                }
                list.push(Registration { id: random_hex()?, name: name.to_string(), role: *role, token: random_hex()? });
                Ok(())
            })
        }
        Edit::Regenerate { id } => change(store, |list| {
            if let Some(r) = list.iter_mut().find(|r| r.id == *id) {
                r.token = random_hex()?;
            }
            Ok(())
        }),
        Edit::SetRole { id, role } => change(store, |list| {
            if let Some(r) = list.iter_mut().find(|r| r.id == *id) {
                r.role = *role;
            }
            Ok(())
        }),
        Edit::Delete { id } => change(store, |list| {
            list.retain(|r| r.id != *id);
            Ok(())
        }),
    }
}

fn change(store: &Store, f: impl FnOnce(&mut Vec<Registration>) -> Result<(), String>) -> Result<(), String> {
    let _one_at_a_time = EDITING.lock().unwrap_or_else(|e| e.into_inner());
    let mut list = registrations(store)?;
    f(&mut list)?;
    store.set_setting(REGISTRATIONS, Some(&serde_json::to_string(&list).map_err(err)?)).map_err(err)
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
        edit(s, &Edit::Create { name: name.into(), role }).unwrap();
        registrations(s).unwrap().into_iter().find(|r| r.name == name.trim()).unwrap()
    }

    #[test]
    fn a_token_finds_its_registration_until_it_is_regenerated_or_deleted() {
        let s = store();
        let a = create(&s, "Claude Code", Role::Read);
        let b = create(&s, "Codex", Role::Edit);
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
        edit(&s, &Edit::Delete { id: a.id.clone() }).unwrap();
        assert_eq!(authenticate(&s, &renewed.token).unwrap(), None);
        assert_eq!(registrations(&s).unwrap(), std::slice::from_ref(&b), "the other one stays");
        edit(&s, &Edit::Delete { id: a.id }).unwrap();
        assert_eq!(registrations(&s).unwrap(), [b], "a registration that is gone changes nothing");
    }

    #[test]
    fn a_name_is_trimmed_and_must_be_new() {
        let s = store();
        assert_eq!(create(&s, "  Claude Code ", Role::Read).name, "Claude Code");
        assert!(edit(&s, &Edit::Create { name: "claude code".into(), role: Role::Edit }).is_err_and(|e| e.contains("mcp.nameTaken")));
        assert!(edit(&s, &Edit::Create { name: " ".into(), role: Role::Edit }).is_err_and(|e| e.contains("mcp.badName")));
        assert!(edit(&s, &Edit::Create { name: "x".repeat(MAX_NAME_CHARS + 1), role: Role::Edit }).is_err_and(|e| e.contains("mcp.badName")));
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
                        edit(s, &Edit::Create { name: format!("{t}-{i}"), role: Role::Read }).unwrap();
                    }
                });
            }
        });
        assert_eq!(registrations(&s).unwrap().len(), 80);
    }

    #[test]
    fn a_name_is_taken_once_when_agents_register_it_at_the_same_time() {
        let s = store();
        std::thread::scope(|scope| {
            for _ in 0..8 {
                let s = &s;
                scope.spawn(move || {
                    for i in 0..30 {
                        let _ = edit(s, &Edit::Create { name: format!("agent {i}"), role: Role::Read });
                    }
                });
            }
        });
        assert_eq!(registrations(&s).unwrap().len(), 30);
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
    fn registrations_are_never_backed_up() {
        assert!(REGISTRATIONS.starts_with(crate::store::SECRET_PREFIX));
        assert!(!ENABLED.starts_with(crate::store::SECRET_PREFIX));
    }
}
