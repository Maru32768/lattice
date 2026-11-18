//! What an agent may do with the library through `lattice-cli` and the MCP server (design-review §23).

/// Ordered: each role allows everything the roles before it allow.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Role {
    Read,
    Edit,
    Delete,
}
