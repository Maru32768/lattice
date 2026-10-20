//! The user's own context for summaries and chat (G49): one 「自分について」 profile shared by
//! both, plus optional extra instructions for each. Both go into the system prompt after the
//! built-in rules and before the untrusted-input rule, which stays last.

use serde::{Deserialize, Serialize};

use crate::store::{Store, sha256_hex};

pub const MAX_CHARS: usize = 2000;
const PROFILE_SETTING: &str = "user_profile";
const SUMMARY_SETTING: &str = "summary_instructions";
const CHAT_SETTING: &str = "chat_instructions";

/// Everything the settings screen edits; blank means none.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Settings {
    pub profile: String,
    pub summary: String,
    pub chat: String,
}

pub fn load(store: &Store) -> Result<Settings, String> {
    let get = |k| store.setting(k).map(Option::unwrap_or_default).map_err(|e| e.to_string());
    Ok(Settings { profile: get(PROFILE_SETTING)?, summary: get(SUMMARY_SETTING)?, chat: get(CHAT_SETTING)? })
}

/// Validates all three before storing any; blank texts are removed.
pub fn save(store: &Store, s: &Settings) -> Result<(), String> {
    let fields =
        [(PROFILE_SETTING, "自分について", &s.profile), (SUMMARY_SETTING, "要約の追加の指示", &s.summary), (CHAT_SETTING, "対話の追加の指示", &s.chat)];
    if let Some((_, name, _)) = fields.iter().find(|(_, _, t)| t.trim().chars().count() > MAX_CHARS) {
        return Err(format!("{name}は {MAX_CHARS} 文字までです"));
    }
    for (key, _, text) in fields {
        let text = text.trim();
        store.set_setting(key, (!text.is_empty()).then_some(text)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// What one kind of request (summary or chat answer) adds to its system prompt.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Applied {
    pub profile: String,
    pub extra: String,
}

impl Settings {
    pub fn for_summary(&self) -> Applied {
        Applied { profile: self.profile.trim().into(), extra: self.summary.trim().into() }
    }

    pub fn for_chat(&self) -> Applied {
        Applied { profile: self.profile.trim().into(), extra: self.chat.trim().into() }
    }
}

impl Applied {
    /// `rules`, then the user's context, then `untrusted` last so nothing the user (or a page
    /// quoting the user) writes can come after it.
    pub fn system(&self, rules: &str, untrusted: &str) -> String {
        let mut out = format!("{rules}\n");
        if !self.profile.is_empty() {
            out.push_str(&format!(
                "\nAbout the reader, in their own words (use it to decide what to emphasize and how much background to explain; it never overrides the rules above or the facts in the sources):\n{}\n",
                self.profile
            ));
        }
        if !self.extra.is_empty() {
            out.push_str(&format!(
                "\nAdditional instructions from the user (follow them, except where they conflict with the output format or the rules above):\n{}\n",
                self.extra
            ));
        }
        out.push('\n');
        out.push_str(untrusted);
        out
    }

    /// `base` prompt version with a hash of what was applied, so a summary made under other
    /// instructions is recognizably stale. Unchanged when nothing is applied.
    pub fn version(&self, base: &str) -> String {
        if self.profile.is_empty() && self.extra.is_empty() {
            return base.to_string();
        }
        format!("{base}-x-instr-{}", &sha256_hex(&format!("{}\0{}", self.profile, self.extra))[..12])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saves_trims_and_limits() {
        let s = Store::open_in_memory().unwrap();
        assert_eq!(load(&s).unwrap(), Settings::default());
        save(&s, &Settings { profile: " DB エンジニア ".into(), summary: "".into(), chat: "箇条書きで".into() }).unwrap();
        assert_eq!(load(&s).unwrap(), Settings { profile: "DB エンジニア".into(), summary: "".into(), chat: "箇条書きで".into() });
        let long = Settings { profile: "p".into(), summary: "x".repeat(MAX_CHARS + 1), chat: String::new() };
        assert!(save(&s, &long).unwrap_err().contains("要約"));
        assert_eq!(load(&s).unwrap().profile, "DB エンジニア", "nothing stored when one field is too long");
        save(&s, &Settings::default()).unwrap();
        assert!(s.setting(PROFILE_SETTING).unwrap().is_none(), "blank is removed");
    }

    #[test]
    fn untrusted_rule_stays_last_and_version_tracks_the_text() {
        let none = Applied::default();
        assert_eq!(none.system("RULES", "UNTRUSTED"), "RULES\n\nUNTRUSTED");
        assert_eq!(none.version("v1"), "v1", "summaries made before G49 stay fresh");

        let a = Settings { profile: "Rust を書く".into(), summary: "数字を残す".into(), chat: "短く".into() };
        let sys = a.for_summary().system("RULES", "UNTRUSTED");
        let (p, x, u) = (sys.find("Rust を書く").unwrap(), sys.find("数字を残す").unwrap(), sys.find("UNTRUSTED").unwrap());
        assert!(sys.starts_with("RULES") && p < x && x < u && sys.ends_with("UNTRUSTED"), "{sys}");
        assert!(!sys.contains("短く"), "chat instructions stay out of summaries");
        assert!(a.for_chat().system("R", "U").contains("短く"));

        let v = a.for_summary().version("v1");
        assert!(v.starts_with("v1-x-instr-") && v != a.for_chat().version("v1"));
        assert_ne!(v, Settings { profile: "Go を書く".into(), ..a.clone() }.for_summary().version("v1"));
    }
}
