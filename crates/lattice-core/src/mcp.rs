//! How much of the library a caller may change: `lattice-cli` and its MCP server check each operation against it, and
//! `lattice-cli serve` the phone's changes (design-review §23, §32).

/// Ordered: each role allows everything the roles before it allow.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Role {
    Read,
    Edit,
    Delete,
}
