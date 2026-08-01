//! In-app agent: a Rust-owned tool-use loop over the Anthropic API that reads
//! and edits the vault. The Rust core is the driver — it builds requests, calls
//! the model, executes tool calls against the vault, and decides when a turn is
//! done. React only sends user text and renders events; it never touches a path
//! or the model API. Works identically on macOS + iOS (all file access goes
//! through the vault abstraction).

pub mod chat;
pub mod fs_tools;
pub mod provider;
pub mod run;
pub mod tools;

pub use run::AgentState;
