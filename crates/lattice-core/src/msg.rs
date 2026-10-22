//! Messages for the user as stable codes with parameters (G51). The UI translates `code` from
//! its catalog (`be.<code>` in src/i18n); parameters stay as they are (paths, HTTP statuses,
//! provider errors). The JSON text travels unchanged through `Result<_, String>` errors and the
//! `last_error` columns, and reads as the code in logs.

/// `{"code":"backup.keepRange","params":{"max":1000}}`; a string param may itself be a coded message.
pub fn coded(code: &str, params: serde_json::Map<String, serde_json::Value>) -> String {
    serde_json::json!({ "code": code, "params": params }).to_string()
}

/// `msg!("backup.keepRange", max = MAX_KEEP)`: a coded message (see [`coded`]).
#[macro_export]
macro_rules! msg {
    ($code:literal $(, $name:ident = $value:expr)* $(,)?) => {{
        #[allow(unused_mut, reason = "a message without parameters never inserts")]
        let mut params = serde_json::Map::new();
        $(params.insert(stringify!($name).to_string(), serde_json::json!($value));)*
        $crate::msg::coded($code, params)
    }};
}

#[cfg(test)]
mod tests {
    #[test]
    fn codes_and_params_are_json() {
        let m = msg!("backup.keepRange", max = 1000, path = "C:\\x \"y\"");
        let v: serde_json::Value = serde_json::from_str(&m).unwrap();
        assert_eq!(v, serde_json::json!({ "code": "backup.keepRange", "params": { "max": 1000, "path": "C:\\x \"y\"" } }));
        assert_eq!(msg!("chat.noSources"), r#"{"code":"chat.noSources","params":{}}"#);
    }
}
