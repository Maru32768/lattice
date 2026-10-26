//! Destination rules for background HTTP fetches. Browser webviews use a separate network stack.

use std::net::IpAddr;

use ipnet::IpNet;
use serde::{Deserialize, Serialize};
use ts_rs::TS;
use url::{Host, Url};

use crate::{msg, store::Store};

const SETTING: &str = "network_policy";

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, rename = "NetworkMode")]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    #[default]
    Public,
    Unrestricted,
    Allowlist,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(deny_unknown_fields)]
pub struct NetworkSettings {
    pub mode: Mode,
    pub allow: Vec<String>,
    pub deny: Vec<String>,
}

pub fn settings(store: &Store) -> Result<NetworkSettings, String> {
    let settings = match store.setting(SETTING).map_err(|e| e.to_string())? {
        Some(value) => serde_json::from_str(&value).map_err(|e| msg!("network.invalidSettings", detail = e.to_string()))?,
        None => NetworkSettings::default(),
    };
    Policy::parse(&settings)?;
    Ok(settings)
}

pub(crate) fn save(store: &Store, settings: &NetworkSettings) -> Result<(), String> {
    let value = serde_json::to_string(settings).map_err(|e| e.to_string())?;
    store.set_setting(SETTING, Some(&value)).map_err(|e| e.to_string())
}

enum Rule {
    Host(String),
    Subdomains(String),
    Ip(IpAddr),
    Network(IpNet),
}

impl Rule {
    fn parse(value: &str) -> Option<Self> {
        let value = value.trim();
        if value.is_empty() || value.len() > 512 {
            return None;
        }
        if let Ok(mut network) = value.parse::<IpNet>() {
            if let IpNet::V6(v6) = network
                && v6.prefix_len() >= 96
                && let Some(v4) = v6.addr().to_ipv4_mapped()
            {
                network = ipnet::Ipv4Net::new(v4, v6.prefix_len() - 96).ok()?.into();
            }
            return Some(Self::Network(network));
        }
        let literal = value.strip_prefix('[').and_then(|s| s.strip_suffix(']')).unwrap_or(value);
        if let Ok(ip) = literal.parse() {
            return Some(Self::Ip(ip));
        }
        let (wildcard, host) = match value.strip_prefix("*.") {
            Some(host) => (true, host),
            None => (false, value),
        };
        if host.contains(['/', '@', '?', '#', ':', '*', '[', ']']) {
            return None;
        }
        match Host::parse(host).ok()? {
            Host::Domain(name) => {
                let name = name.trim_end_matches('.');
                if name.is_empty() || name.split('.').any(str::is_empty) {
                    return None;
                }
                Some(if wildcard {
                    Self::Subdomains(name.into())
                } else {
                    Self::Host(name.into())
                })
            }
            Host::Ipv4(ip) if !wildcard => Some(Self::Ip(ip.into())),
            Host::Ipv6(ip) if !wildcard => Some(Self::Ip(ip.into())),
            _ => None,
        }
    }

    fn host(&self, host: &str) -> bool {
        let host = host.trim_end_matches('.');
        match self {
            Self::Host(name) => host == name,
            Self::Subdomains(name) => host.strip_suffix(name).is_some_and(|prefix| prefix.ends_with('.')),
            _ => false,
        }
    }

    fn ip(&self, ip: IpAddr) -> bool {
        let canonical = |ip: IpAddr| match ip {
            IpAddr::V6(v6) => v6.to_ipv4_mapped().map(IpAddr::V4).unwrap_or(ip),
            _ => ip,
        };
        match self {
            Self::Ip(wanted) => canonical(*wanted) == canonical(ip),
            Self::Network(network) => network.contains(&ip) || network.contains(&canonical(ip)),
            _ => false,
        }
    }
}

pub(crate) struct Policy {
    mode: Mode,
    allow: Vec<Rule>,
    deny: Vec<Rule>,
}

impl Policy {
    pub(crate) fn parse(settings: &NetworkSettings) -> Result<Self, String> {
        let parse = |values: &[String]| {
            if values.len() > 256 {
                return Err(msg!("network.tooManyRules", max = 256));
            }
            values.iter().map(|value| Rule::parse(value).ok_or_else(|| msg!("network.invalidRule", rule = value))).collect()
        };
        Ok(Self { mode: settings.mode, allow: parse(&settings.allow)?, deny: parse(&settings.deny)? })
    }

    pub(crate) fn check_url(&self, url: &Url) -> Result<(), String> {
        let allowed = matches!(url.scheme(), "http" | "https")
            && match url.host() {
                Some(Host::Ipv4(ip)) => self.allows_ip("", ip.into()),
                Some(Host::Ipv6(ip)) => self.allows_ip("", ip.into()),
                Some(Host::Domain(host)) => {
                    !self.deny.iter().any(|rule| rule.host(host)) && (self.mode != Mode::Allowlist || self.allow.iter().any(|rule| rule.host(host)))
                }
                None => false,
            };
        if allowed {
            Ok(())
        } else {
            Err(msg!("network.blocked", host = url.host_str().unwrap_or_default()))
        }
    }

    pub(crate) fn allows_ip(&self, host: &str, ip: IpAddr) -> bool {
        !self.deny.iter().any(|rule| rule.ip(ip) || rule.host(host))
            && (self.mode == Mode::Unrestricted || self.allow.iter().any(|rule| rule.ip(ip) || rule.host(host)) || (self.mode == Mode::Public && is_public(ip)))
    }
}

pub(crate) fn is_public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let [a, b, ..] = v4.octets();
            !(v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_broadcast()
                || v4.is_documentation()
                || v4.is_multicast()
                || a == 0
                || a >= 240
                || (a == 100 && (64..128).contains(&b)))
        }
        IpAddr::V6(v6) => match v6.to_ipv4() {
            Some(v4) => is_public(v4.into()),
            None => {
                let s0 = v6.segments()[0];
                !(v6.is_multicast() || s0 & 0xfe00 == 0xfc00 || s0 & 0xffc0 == 0xfe80)
            }
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy(mode: Mode, allow: &[&str], deny: &[&str]) -> Policy {
        Policy::parse(&NetworkSettings { mode, allow: allow.iter().map(|s| s.to_string()).collect(), deny: deny.iter().map(|s| s.to_string()).collect() })
            .unwrap()
    }

    #[test]
    fn modes_and_rule_precedence() {
        let public = policy(Mode::Public, &["localhost", "192.168.2.0/24"], &["192.168.2.5", "blocked.example"]);
        let check = |url| public.check_url(&Url::parse(url).unwrap()).is_ok();
        assert!(check("https://example.com"));
        assert!(check("http://localhost:8080"));
        assert!(check("http://192.168.2.4"));
        assert!(!check("http://192.168.2.5"));
        assert!(!check("https://blocked.example"));
        assert!(!check("http://127.0.0.1"));
        assert!(!check("file:///tmp/a"));
        assert!(public.allows_ip("localhost", "127.0.0.1".parse().unwrap()));
        assert!(!public.allows_ip("localhost", "192.168.2.5".parse().unwrap()), "IP deny overrides hostname allow");
        assert!(public.allows_ip("other.example", "192.168.2.4".parse().unwrap()));

        let strict = policy(Mode::Allowlist, &["example.com", "10.0.0.0/8"], &["10.1.2.3"]);
        assert!(strict.check_url(&Url::parse("https://example.com").unwrap()).is_ok());
        assert!(strict.check_url(&Url::parse("http://10.0.0.1").unwrap()).is_ok());
        assert!(strict.check_url(&Url::parse("http://10.1.2.3").unwrap()).is_err());
        assert!(strict.check_url(&Url::parse("https://other.example").unwrap()).is_err());
        assert!(!strict.allows_ip("example.com", "10.1.2.3".parse().unwrap()));
        assert!(policy(Mode::Allowlist, &[], &[]).check_url(&Url::parse("https://example.com").unwrap()).is_err());

        let all = policy(Mode::Unrestricted, &[], &["127.0.0.1"]);
        assert!(all.check_url(&Url::parse("http://10.1.2.3").unwrap()).is_ok());
        assert!(all.check_url(&Url::parse("http://127.0.0.1").unwrap()).is_err());
    }

    #[test]
    fn canonical_hosts_and_ip_encodings() {
        let p = policy(Mode::Allowlist, &["EXAMPLE.com.", "*.Sub.Example.com", "bücher.example", "::1"], &["127.0.0.0/8"]);
        for url in ["https://example.com", "https://EXAMPLE.COM./x", "https://a.sub.example.com", "https://xn--bcher-kva.example", "http://[::1]"] {
            assert!(p.check_url(&Url::parse(url).unwrap()).is_ok(), "{url}");
        }
        for url in ["https://sub.example.com", "https://badexample.com", "https://sub.example.com.evil.test", "https://other.example.com"] {
            assert!(p.check_url(&Url::parse(url).unwrap()).is_err(), "{url}");
        }
        let all = policy(Mode::Unrestricted, &[], &["127.0.0.0/8"]);
        for url in ["http://2130706433", "http://0x7f000001", "http://127.1", "http://[::ffff:127.0.0.1]"] {
            assert!(all.check_url(&Url::parse(url).unwrap()).is_err(), "{url}");
        }
        let mapped = policy(Mode::Unrestricted, &[], &["::ffff:127.0.0.0/104"]);
        assert!(mapped.check_url(&Url::parse("http://127.0.0.1").unwrap()).is_err(), "mapped IPv6 CIDR must also cover equivalent IPv4 URLs");
        assert!(Rule::parse("[[::1]]").is_none(), "malformed brackets must not be reinterpreted");
        for invalid in ["", "https://example.com", "example.com:8080", "example.com/path", "*", "*example.com", "10.0.0.0/99", "user@example.com"] {
            assert!(Rule::parse(invalid).is_none(), "{invalid}");
        }
    }

    #[test]
    fn stored_settings_are_validated() {
        let store = Store::open_in_memory().unwrap();
        assert_eq!(settings(&store).unwrap(), NetworkSettings::default());
        let value = NetworkSettings { mode: Mode::Allowlist, allow: vec!["localhost".into()], deny: vec![] };
        save(&store, &value).unwrap();
        assert_eq!(settings(&store).unwrap(), value);
        store.set_setting(SETTING, Some(r#"{"mode":"unknown","allow":[],"deny":[]}"#)).unwrap();
        assert!(settings(&store).is_err(), "corrupt settings cannot silently fall back to unrestricted access");
    }
}
