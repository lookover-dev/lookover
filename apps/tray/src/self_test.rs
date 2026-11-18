//! `--self-test`'s report: one JSON line of what the OS answered, each call and its result, and what was picked.

use serde_json::{Map, Value, json};

use crate::driver::say;

/// What a self-test found, in the order it asked.
pub struct Report {
    facts: Map<String, Value>,
    steps: Vec<Value>,
}

impl Report {
    pub fn new() -> Self {
        Report {
            facts: Map::new(),
            steps: Vec::new(),
        }
    }

    /// Something the OS answered that isn't a call's success: the size it asked for, its theme.
    pub fn fact(&mut self, name: &str, value: Value) {
        self.facts.insert(name.to_string(), value);
    }

    /// A call, whether it succeeded, and what it said.
    pub fn step(&mut self, step: &str, ok: bool, said: Value) {
        self.steps
            .push(json!({ "step": step, "ok": ok, "said": said }));
    }

    /// Whether every call succeeded (and there was one).
    pub fn ok(&self) -> bool {
        !self.steps.is_empty() && self.steps.iter().all(|step| step["ok"] == json!(true))
    }

    /// The report's line.
    pub fn line(&self) -> String {
        json!({
            "type": "self-test",
            "ok": self.ok(),
            "version": crate::VERSION,
            "os": std::env::consts::OS,
            "facts": self.facts,
            "steps": self.steps,
        })
        .to_string()
    }

    /// The exit code it calls for: 0 only when every call succeeded.
    pub fn code(&self) -> i32 {
        if self.ok() { 0 } else { 1 }
    }

    /// Prints the line; the exit code it calls for.
    pub fn print(&self) -> i32 {
        say(&mut std::io::stdout(), &self.line());
        self.code()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn it_passes_only_when_every_call_succeeded() {
        let mut report = Report::new();
        assert!(!report.ok(), "no call is no pass");
        report.step("add", true, json!({ "rect": [16, 16] }));
        report.step("show idle", true, Value::Null);
        assert!(report.ok());
        report.step("remove", false, json!("still on the tray"));
        assert!(!report.ok());
        assert_eq!(report.code(), 1);
    }

    #[test]
    fn its_line_says_each_call_in_order() {
        let mut report = Report::new();
        report.fact("dpi", json!(96));
        report.step("add", true, json!({ "rect": [16, 16] }));
        let line: Value = serde_json::from_str(&report.line()).unwrap();
        assert_eq!(line["type"], "self-test");
        assert_eq!(line["ok"], true);
        assert_eq!(line["facts"]["dpi"], 96);
        assert_eq!(
            line["steps"],
            json!([{ "step": "add", "ok": true, "said": { "rect": [16, 16] } }])
        );
    }
}
