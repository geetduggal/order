use serde::{Deserialize, Serialize};

/// Result of picking or restoring a vault folder. `path` is the resolved
/// absolute filesystem path (security-scoped access already open on iOS),
/// or null when the user cancelled or no/stale bookmark exists. `name` is
/// the folder's display name when freshly picked.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultFolder {
  pub path: Option<String>,
  pub name: Option<String>,
}
